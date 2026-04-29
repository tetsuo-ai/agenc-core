const PLAN_TOOL_NAMES = new Set([
  "enterplanmode",
  "exitplanmode",
  "askuserquestion",
  "verifyplanexecutiontool",
  "verifyplanexecution",
]);

function inline(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function block(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toolInput(payload) {
  const input =
    payload.input ??
    payload.args ??
    payload.arguments ??
    payload.toolInput ??
    payload.permission?.input ??
    payload.request?.input;
  return asRecord(input);
}

function candidateToolNames(payload) {
  const input = toolInput(payload);
  return [
    payload.toolName,
    payload.tool,
    payload.action,
    payload.name,
    payload.permission?.toolName,
    payload.permission?.tool,
    payload.request?.toolName,
    payload.request?.tool,
    input.toolName,
    input.tool,
    input.name,
  ]
    .map((value) => inline(value))
    .filter(Boolean);
}

export function openClaudePlanToolName(payload = {}) {
  for (const candidate of candidateToolNames(asRecord(payload))) {
    const normalized = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (PLAN_TOOL_NAMES.has(normalized)) {
      if (normalized === "verifyplanexecution") return "VerifyPlanExecutionTool";
      return candidate;
    }
  }
  return null;
}

function requestIdLine(payload) {
  const requestId = inline(
    payload.requestId ??
      payload.id ??
      payload.callId ??
      payload.toolCallId ??
      payload.permission?.requestId,
  );
  if (!requestId) {
    return null;
  }
  return `Approve: /approve ${requestId} yes\nReject: /approve ${requestId} no`;
}

function planTextFrom(payload, input) {
  return block(
    input.plan ??
      payload.plan ??
      payload.currentPlan ??
      payload.planContent ??
      payload.permission?.plan ??
      payload.request?.plan,
  );
}

function planPathFrom(payload, input) {
  return inline(
    input.planFilePath ??
      input.filePath ??
      payload.planFilePath ??
      payload.filePath ??
      payload.permission?.planFilePath,
  );
}

function formatAllowedPrompts(input) {
  const allowedPrompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];
  if (allowedPrompts.length === 0) {
    return null;
  }
  const lines = allowedPrompts
    .map((prompt, index) => {
      const tool = inline(prompt?.tool ?? prompt?.toolName ?? "tool");
      const text = inline(prompt?.prompt ?? prompt?.description ?? "");
      return text ? `${index + 1}. ${tool}: ${text}` : `${index + 1}. ${tool}`;
    })
    .filter(Boolean);
  return lines.length > 0 ? ["Allowed prompts requested:", ...lines].join("\n") : null;
}

function formatEnterPlanMode(payload) {
  const controls = requestIdLine(payload);
  return {
    title: "Enter Plan Mode?",
    body: [
      "AgenC wants to enter plan mode to explore and design an implementation approach.",
      [
        "In plan mode, AgenC will:",
        " · Explore the codebase thoroughly",
        " · Identify existing patterns",
        " · Design an implementation strategy",
        " · Present a plan for your approval",
      ].join("\n"),
      "No code changes will be made until you approve the plan.",
      controls,
    ]
      .filter(Boolean)
      .join("\n\n"),
    tone: "purple",
  };
}

function formatExitPlanMode(payload) {
  const input = toolInput(payload);
  const plan = planTextFrom(payload, input);
  const planPath = planPathFrom(payload, input);
  const controls = requestIdLine(payload);
  const allowedPrompts = formatAllowedPrompts(input);
  const feedback = inline(payload.feedback ?? input.feedback ?? payload.acceptFeedback);
  return {
    title: "Plan Ready for Approval",
    body: [
      plan || "No plan content was supplied. The model should write the AgenC plan file before calling ExitPlanMode.",
      planPath ? `Plan file: ${planPath}` : null,
      allowedPrompts,
      feedback ? `Feedback note: ${feedback}` : null,
      controls,
      "Approve to leave plan mode and implement. Reject to revise the plan and call ExitPlanMode again.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    tone: "purple",
  };
}

function normalizeQuestionOptions(question) {
  const options = Array.isArray(question?.options) ? question.options : [];
  return options
    .map((option, index) => {
      if (typeof option === "string") {
        return `${index + 1}. ${inline(option)}`;
      }
      const label = inline(option?.label ?? option?.value ?? option?.title ?? `Option ${index + 1}`);
      const description = inline(option?.description ?? option?.detail ?? "");
      const preview = block(option?.preview ?? "");
      return [
        `${index + 1}. ${label}${description ? ` - ${description}` : ""}`,
        preview ? `   Preview: ${preview.split("\n").slice(0, 4).join("\n   ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean);
}

function normalizeQuestions(payload, input) {
  if (Array.isArray(input.questions)) {
    return input.questions;
  }
  if (Array.isArray(payload.questions)) {
    return payload.questions;
  }
  const question = input.question ?? payload.question ?? payload.message;
  if (question) {
    return [{ question, options: input.options ?? payload.options ?? [] }];
  }
  return [];
}

function formatAskUserQuestion(payload) {
  const input = toolInput(payload);
  const questions = normalizeQuestions(payload, input);
  const metadataSource = inline(input.metadata?.source ?? payload.metadata?.source);
  const lines = questions.flatMap((question, index) => {
    const text = inline(question?.question ?? question?.text ?? question?.title);
    const options = normalizeQuestionOptions(question);
    return [
      `${index + 1}. ${text || "Question"}`,
      ...options.map((optionLine) => `   ${optionLine}`),
    ];
  });
  const controls = requestIdLine(payload);
  return {
    title:
      questions.length === 1
        ? inline(questions[0]?.question ?? questions[0]?.text ?? "Question for You")
        : "Questions for You",
    body: [
      metadataSource ? `Source: ${metadataSource}` : null,
      lines.length > 0 ? lines.join("\n") : "AgenC needs clarification before continuing.",
      controls,
      "Use the displayed options or respond with clarifying details; in plan mode this should gather requirements, not approve the plan.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    tone: "purple",
  };
}

function formatVerification(payload) {
  const input = toolInput(payload);
  const status = inline(payload.status ?? payload.verdict ?? input.status ?? input.verdict);
  const summary = block(payload.summary ?? payload.result ?? payload.message ?? input.summary);
  const criteria = Array.isArray(input.criteria ?? payload.criteria)
    ? (input.criteria ?? payload.criteria)
        .map((item, index) => `${index + 1}. ${inline(item)}`)
        .join("\n")
    : block(input.criteria ?? payload.criteria);
  const evidence = Array.isArray(payload.evidence ?? input.evidence)
    ? (payload.evidence ?? input.evidence)
        .map((item, index) => `${index + 1}. ${inline(item)}`)
        .join("\n")
    : block(payload.evidence ?? input.evidence);
  return {
    title: status ? `Verify Plan Execution: ${status}` : "Verify Plan Execution",
    body: [
      summary || "AgenC is verifying that implementation matches the approved plan.",
      criteria ? `Criteria:\n${criteria}` : null,
      evidence ? `Evidence:\n${evidence}` : null,
      requestIdLine(payload),
    ]
      .filter(Boolean)
      .join("\n\n"),
    tone: status && /fail|block|reject|missing/i.test(status) ? "amber" : "teal",
  };
}

export function formatOpenClaudePlanApproval(payload = {}) {
  const record = asRecord(payload);
  const toolName = openClaudePlanToolName(record);
  if (!toolName) {
    return null;
  }
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "enterplanmode") return formatEnterPlanMode(record);
  if (normalized === "exitplanmode") return formatExitPlanMode(record);
  if (normalized === "askuserquestion") return formatAskUserQuestion(record);
  return formatVerification(record);
}
