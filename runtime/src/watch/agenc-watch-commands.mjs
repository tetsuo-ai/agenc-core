function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchCommandController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchCommandController requires a ${name} object`);
  }
}

function reviewScopeSuffix(args = []) {
  const scope = args.join(" ").trim();
  return scope ? ` Scope: ${scope}.` : " Scope: review the current workspace changes.";
}

function buildReviewModePrompt(canonicalName, args = []) {
  const scopeSuffix = reviewScopeSuffix(args);
  if (canonicalName === "/security-review") {
    return [
      `Perform a security-focused review of the current workspace changes.${scopeSuffix}`,
      "Prioritize real vulnerabilities, auth and permission flaws, data exposure, injection risks, sandbox or path escapes, unsafe deserialization, and missing security tests.",
      "Report findings first, ordered by severity, with concrete file references and concise remediation guidance.",
      "If there are no findings, say so explicitly and list any residual risks or coverage gaps.",
    ].join(" ");
  }
  if (canonicalName === "/pr-comments") {
    return [
      `Draft concise PR review comments for the current workspace changes.${scopeSuffix}`,
      "Focus on actionable comments tied to concrete issues, behavior regressions, risky assumptions, and missing tests.",
      "Keep each comment brief, specific, and ready to paste into a code review.",
      "If there are no issues, provide a short approval note plus residual risks or follow-up checks.",
    ].join(" ");
  }
  return [
    `Review the current workspace changes.${scopeSuffix}`,
    "Focus on bugs, regressions, risky assumptions, and missing tests.",
    "Present findings first, ordered by severity, with concrete file references.",
    "Keep any summary brief and place it after the findings.",
    "If there are no findings, say so explicitly and mention residual risks or testing gaps.",
  ].join(" ");
}

function reviewModePresentation(canonicalName) {
  switch (canonicalName) {
    case "/security-review":
      return {
        title: "Security Review",
        body: "Requested a security-focused review of the current changes.",
      };
    case "/pr-comments":
      return {
        title: "PR Comments",
        body: "Requested concise PR review comments for the current changes.",
      };
    default:
      return {
        title: "Code Review",
        body: "Requested a findings-first review of the current changes.",
      };
  }
}

function formatCheckpointSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return "Checkpoint unavailable.";
  }
  const pieces = [
    `${summary.id}${summary.active ? " [active]" : ""}`,
    summary.label,
    `reason ${summary.reason ?? "manual"}`,
    `events ${Number.isFinite(Number(summary.eventCount)) ? Number(summary.eventCount) : 0}`,
    `run ${summary.runState ?? "idle"}`,
  ];
  if (summary.sessionId) {
    pieces.push(`session ${summary.sessionId}`);
  }
  if (summary.objective) {
    pieces.push(`objective ${summary.objective}`);
  }
  if (Number.isFinite(Number(summary.createdAtMs)) && Number(summary.createdAtMs) > 0) {
    pieces.push(new Date(Number(summary.createdAtMs)).toISOString());
  }
  return pieces.join("\n");
}

function formatCheckpointList(summaries = []) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    return "No checkpoints saved.";
  }
  return summaries
    .map((summary) => formatCheckpointSummary(summary))
    .join("\n\n");
}

function buildPermissionsCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "status").trim().toLowerCase();
  if (!subcommand || subcommand === "status") {
    return {
      content: "/policy status",
      title: "Permissions",
      body: "Requested policy and approval state for the active runtime.",
    };
  }
  if (subcommand === "credentials") {
    return {
      content: "/policy credentials",
      title: "Permission Credentials",
      body: "Requested active session credential leases.",
    };
  }
  if (subcommand === "revoke-credentials") {
    const credentialId = args.slice(1).join(" ").trim();
    return {
      content: credentialId
        ? `/policy revoke-credentials ${credentialId}`
        : "/policy revoke-credentials",
      title: "Revoke Credentials",
      body: credentialId
        ? `Requested credential revocation for ${credentialId}.`
        : "Requested revocation of active session credential leases.",
    };
  }
  if (subcommand === "simulate") {
    const toolName = (args[1] ?? "").trim();
    if (!toolName) {
      return {
        error:
          "Usage: /permissions simulate <toolName> [jsonArgs]",
      };
    }
    const argText = args.slice(2).join(" ").trim();
    return {
      content: argText
        ? `/policy simulate ${toolName} ${argText}`
        : `/policy simulate ${toolName}`,
      title: "Permission Simulation",
      body: `Requested a policy/approval simulation for ${toolName}.`,
    };
  }
  if (["allow", "deny", "clear", "reset"].includes(subcommand)) {
    const pattern = args.slice(1).join(" ").trim();
    if (subcommand !== "reset" && !pattern) {
      return {
        error:
          "Usage: /permissions [status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]|allow <toolPattern>|deny <toolPattern>|clear <toolPattern>|reset]",
      };
    }
    return {
      content:
        subcommand === "reset"
          ? "/policy update reset"
          : `/policy update ${subcommand} ${pattern}`,
      title: "Policy Update",
      body:
        subcommand === "reset"
          ? "Requested a reset of all session policy allow/deny overrides."
          : `Requested a session policy ${subcommand} override for ${pattern}.`,
    };
  }
  return {
    error:
      "Usage: /permissions [status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]|allow <toolPattern>|deny <toolPattern>|clear <toolPattern>|reset]",
  };
}

function buildApprovalsCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const rawToken = String(parsedSlash?.commandToken ?? "").trim().toLowerCase();
  if (rawToken === "/approve") {
    if (args.length === 0 || (args.length === 1 && args[0]?.toLowerCase() === "list")) {
      return {
        content: "approve list",
        title: "Approvals",
        body: "Requested pending approvals for the active session.",
      };
    }
    const requestId = (args[0] ?? "").trim();
    const disposition = (args[1] ?? "").trim().toLowerCase();
    if (requestId && ["yes", "no", "always"].includes(disposition)) {
      return {
        content: `approve ${requestId} ${disposition}`,
        title: "Approval Resolve",
        body: `Requested ${disposition} for approval ${requestId}.`,
      };
    }
    return {
      error:
        "Usage: /approve [list|<requestId> <yes|no|always>]",
    };
  }

  const subcommand = (args[0] ?? "list").trim().toLowerCase();
  if (!subcommand || subcommand === "list") {
    return {
      content: "approve list",
      title: "Approvals",
      body: "Requested pending approvals for the active session.",
    };
  }
  const requestId = (args[1] ?? "").trim();
  if (!requestId) {
    return {
      error:
        "Usage: /approvals [list|approve <requestId>|deny <requestId>|always <requestId>]",
    };
  }
  const disposition =
    subcommand === "approve"
      ? "yes"
      : subcommand === "deny"
        ? "no"
        : subcommand === "always"
          ? "always"
          : null;
  if (!disposition) {
    return {
      error:
        "Usage: /approvals [list|approve <requestId>|deny <requestId>|always <requestId>]",
    };
  }
  return {
    content: `approve ${requestId} ${disposition}`,
    title: "Approval Resolve",
    body: `Requested ${disposition} for approval ${requestId}.`,
  };
}

function buildCompactionCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "now").trim().toLowerCase();
  if (!subcommand || ["now", "force", "run"].includes(subcommand)) {
    return {
      content: "/compact",
      title: "Compaction",
      body: "Requested immediate conversation compaction for the active session.",
    };
  }
  if (["status", "context", "usage"].includes(subcommand)) {
    return {
      content: "/context",
      title: "Compaction Status",
      body: "Requested context usage and compaction pressure for the active session.",
    };
  }
  return {
    error: "Usage: /compact [now|status]",
  };
}

function buildRetryRunCommand(parsedSlash, sessionId) {
  const reason = Array.isArray(parsedSlash?.args)
    ? parsedSlash.args.join(" ").trim()
    : "";
  return {
    title: "Retry Run",
    body: reason
      ? `Retrying durable run for ${sessionId} from its last checkpoint.\n\nReason: ${reason}`
      : `Retrying durable run for ${sessionId} from its last checkpoint.`,
    payload: {
      action: "retry_from_checkpoint",
      sessionId,
      ...(reason ? { reason } : { reason: "operator retry from checkpoint" }),
    },
    status: "retrying run",
  };
}

function buildVerificationOverrideCommand(parsedSlash, sessionId) {
  const args = Array.isArray(parsedSlash?.args) ? [...parsedSlash.args] : [];
  const mode = String(args.shift() ?? "")
    .trim()
    .toLowerCase();
  if (!["continue", "complete", "fail"].includes(mode)) {
    return {
      error:
        "Usage: /verify-override <continue|complete|fail> <reason> [--user-update <text>]",
    };
  }
  const userUpdateIndex = args.findIndex((token) =>
    ["--user-update", "--userupdate"].includes(String(token ?? "").trim().toLowerCase())
  );
  const reasonTokens = userUpdateIndex >= 0 ? args.slice(0, userUpdateIndex) : args;
  const userUpdateTokens = userUpdateIndex >= 0 ? args.slice(userUpdateIndex + 1) : [];
  const reason = reasonTokens.join(" ").trim();
  const userUpdate = userUpdateTokens.join(" ").trim();
  if (!reason) {
    return {
      error:
        "Usage: /verify-override <continue|complete|fail> <reason> [--user-update <text>]",
    };
  }
  return {
    title: "Verification Override",
    body: [
      `Applying ${mode} verification override for ${sessionId}.`,
      `Reason: ${reason}`,
      userUpdate ? `User update: ${userUpdate}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    payload: {
      action: "verification_override",
      sessionId,
      override: {
        mode,
        reason,
        ...(userUpdate ? { userUpdate } : {}),
      },
    },
    status: `override ${mode}`,
  };
}

function parseInlineJsonObject(rawValue, usage) {
  const source = String(rawValue ?? "").trim();
  if (!source) {
    return { error: usage };
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { error: usage };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: usage };
  }
  return { value: parsed };
}

function buildRunCancelCommand(parsedSlash, sessionId) {
  const reason = Array.isArray(parsedSlash?.args)
    ? parsedSlash.args.join(" ").trim()
    : "";
  return {
    title: "Cancel Run",
    body: reason
      ? `Cancelling durable run for ${sessionId}.\n\nReason: ${reason}`
      : `Cancelling durable run for ${sessionId}.`,
    payload: {
      action: "cancel",
      sessionId,
      ...(reason ? { reason } : { reason: "operator cancel durable run" }),
    },
    status: "cancelling run",
  };
}

function buildRunObjectiveCommand(parsedSlash, sessionId) {
  const objective = Array.isArray(parsedSlash?.args)
    ? parsedSlash.args.join(" ").trim()
    : "";
  if (!objective) {
    return {
      error: "Usage: /run-objective <objective>",
    };
  }
  return {
    title: "Run Objective",
    body: `Updating durable run objective for ${sessionId}.\n\nObjective: ${objective}`,
    payload: {
      action: "edit_objective",
      sessionId,
      objective,
      reason: "operator updated durable run objective",
    },
    status: "run objective updated",
  };
}

function buildRunConstraintsCommand(parsedSlash, sessionId) {
  const usage =
    "Usage: /run-constraints <json>";
  const parsed = parseInlineJsonObject(
    Array.isArray(parsedSlash?.args) ? parsedSlash.args.join(" ") : "",
    usage,
  );
  if (parsed.error) {
    return parsed;
  }
  return {
    title: "Run Constraints",
    body: `Amending durable run constraints for ${sessionId}.`,
    payload: {
      action: "amend_constraints",
      sessionId,
      constraints: parsed.value,
      reason: "operator amended durable run constraints",
    },
    status: "run constraints updated",
  };
}

function buildRunBudgetCommand(parsedSlash, sessionId) {
  const usage = "Usage: /run-budget <json>";
  const parsed = parseInlineJsonObject(
    Array.isArray(parsedSlash?.args) ? parsedSlash.args.join(" ") : "",
    usage,
  );
  if (parsed.error) {
    return parsed;
  }
  return {
    title: "Run Budget",
    body: `Adjusting durable run budget for ${sessionId}.`,
    payload: {
      action: "adjust_budget",
      sessionId,
      budget: parsed.value,
      reason: "operator adjusted durable run budget",
    },
    status: "run budget updated",
  };
}

function buildRunCompactCommand(parsedSlash, sessionId) {
  const reason = Array.isArray(parsedSlash?.args)
    ? parsedSlash.args.join(" ").trim()
    : "";
  return {
    title: "Run Compaction",
    body: reason
      ? `Forcing durable run compaction for ${sessionId}.\n\nReason: ${reason}`
      : `Forcing durable run compaction for ${sessionId}.`,
    payload: {
      action: "force_compact",
      sessionId,
      ...(reason ? { reason } : { reason: "operator requested durable run compaction" }),
    },
    status: "run compaction requested",
  };
}

function buildRunWorkerCommand(parsedSlash, sessionId) {
  const usage = "Usage: /run-worker <json>";
  const parsed = parseInlineJsonObject(
    Array.isArray(parsedSlash?.args) ? parsedSlash.args.join(" ") : "",
    usage,
  );
  if (parsed.error) {
    return parsed;
  }
  return {
    title: "Run Worker",
    body: `Updating durable run worker preference for ${sessionId}.`,
    payload: {
      action: "reassign_worker",
      sessionId,
      worker: parsed.value,
      reason: "operator reassigned durable run worker",
    },
    status: "run worker updated",
  };
}

function splitOptionTail(tokens = [], optionNames = []) {
  const normalizedNames = optionNames.map((value) => String(value).trim().toLowerCase());
  const index = tokens.findIndex((token) =>
    normalizedNames.includes(String(token ?? "").trim().toLowerCase())
  );
  if (index < 0) {
    return {
      head: tokens,
      tail: [],
    };
  }
  return {
    head: tokens.slice(0, index),
    tail: tokens.slice(index + 1),
  };
}

function buildRetryStepCommand(parsedSlash, sessionId) {
  const rawArgs = Array.isArray(parsedSlash?.args) ? [...parsedSlash.args] : [];
  const traceIndex = rawArgs.findIndex((token) =>
    ["--trace"].includes(String(token ?? "").trim().toLowerCase())
  );
  let traceId = "";
  let withoutTrace = rawArgs;
  if (traceIndex >= 0) {
    traceId = String(rawArgs[traceIndex + 1] ?? "").trim();
    withoutTrace = [...rawArgs.slice(0, traceIndex), ...rawArgs.slice(traceIndex + 2)];
  }
  const { head, tail } = splitOptionTail(withoutTrace, ["--reason"]);
  const stepName = head.join(" ").trim();
  const reason = tail.join(" ").trim();
  if (!stepName) {
    return {
      error:
        "Usage: /retry-step <stepName> [--trace <traceId>] [--reason <text>]",
    };
  }
  return {
    title: "Retry Step",
    body: [
      `Retrying durable run step "${stepName}" for ${sessionId}.`,
      traceId ? `Trace: ${traceId}` : null,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    payload: {
      action: "retry_from_step",
      sessionId,
      stepName,
      ...(traceId ? { traceId } : {}),
      ...(reason ? { reason } : {}),
    },
    status: "retrying step",
  };
}

function buildRetryTraceCommand(parsedSlash, sessionId) {
  const rawArgs = Array.isArray(parsedSlash?.args) ? [...parsedSlash.args] : [];
  const traceId = String(rawArgs.shift() ?? "").trim();
  const { head, tail } = splitOptionTail(rawArgs, ["--reason"]);
  const stepName = head.join(" ").trim();
  const reason = tail.join(" ").trim();
  if (!traceId) {
    return {
      error:
        "Usage: /retry-trace <traceId> [stepName] [--reason <text>]",
    };
  }
  return {
    title: "Retry Trace",
    body: [
      `Retrying durable run trace "${traceId}" for ${sessionId}.`,
      stepName ? `Step: ${stepName}` : null,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    payload: {
      action: "retry_from_trace",
      sessionId,
      traceId,
      ...(stepName ? { stepName } : {}),
      ...(reason ? { reason } : {}),
    },
    status: "retrying trace",
  };
}

function buildRunForkCommand(parsedSlash, sessionId) {
  const rawArgs = Array.isArray(parsedSlash?.args) ? [...parsedSlash.args] : [];
  const targetSessionId = String(rawArgs.shift() ?? "").trim();
  if (!targetSessionId) {
    return {
      error:
        "Usage: /run-fork <targetSessionId> [--objective <text>] [--reason <text>]",
    };
  }
  const objectiveIndex = rawArgs.findIndex((token) =>
    ["--objective"].includes(String(token ?? "").trim().toLowerCase())
  );
  const reasonIndex = rawArgs.findIndex((token) =>
    ["--reason"].includes(String(token ?? "").trim().toLowerCase())
  );
  let objective = "";
  let reason = "";
  if (objectiveIndex >= 0) {
    const end = reasonIndex > objectiveIndex ? reasonIndex : rawArgs.length;
    objective = rawArgs.slice(objectiveIndex + 1, end).join(" ").trim();
  }
  if (reasonIndex >= 0) {
    reason = rawArgs.slice(reasonIndex + 1).join(" ").trim();
  }
  return {
    title: "Fork Run",
    body: [
      `Forking durable run ${sessionId} into ${targetSessionId}.`,
      objective ? `Objective: ${objective}` : null,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    payload: {
      action: "fork_from_checkpoint",
      sessionId,
      targetSessionId,
      ...(objective ? { objective } : {}),
      ...(reason ? { reason } : {}),
    },
    status: "forking run",
  };
}

function buildDesktopCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "").trim().toLowerCase();
  if (!subcommand || !["start", "stop", "status", "vnc", "list", "attach"].includes(subcommand)) {
    return {
      error: "Usage: /desktop <start|stop|status|vnc|list|attach>",
    };
  }
  return {
    content: ["/desktop", ...args].join(" ").trim(),
    title: "Desktop Tools",
    body: `Requested desktop command: /desktop ${args.join(" ").trim()}`.trim(),
  };
}

function buildSkillTogglePayload(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "list").trim().toLowerCase();
  if (!subcommand || subcommand === "list") {
    return {
      mode: "list",
      title: "Skills",
      body: "Requested the live skill catalog for this runtime.",
    };
  }
  if (!["enable", "disable"].includes(subcommand)) {
    return {
      error: "Usage: /skills [list|enable <name>|disable <name>]",
    };
  }
  const skillName = args.slice(1).join(" ").trim();
  if (!skillName) {
    return {
      error: "Usage: /skills [list|enable <name>|disable <name>]",
    };
  }
  return {
    mode: "toggle",
    title: "Skills",
    body: `${subcommand === "enable" ? "Enabling" : "Disabling"} runtime skill ${skillName}.`,
    payload: {
      skillName,
      enabled: subcommand === "enable",
    },
    status:
      subcommand === "enable"
        ? `enabling skill ${skillName}`
        : `disabling skill ${skillName}`,
  };
}

function buildPluginCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "list").trim().toLowerCase();
  if (!subcommand || subcommand === "list") {
    return {
      mode: "report",
      section: "plugins",
    };
  }
  if (subcommand === "trust") {
    const packageName = String(args[1] ?? "").trim();
    if (!packageName) {
      return {
        error: "Usage: /plugins [list|trust <packageName> [subpath ...]|untrust <packageName>]",
      };
    }
    return {
      mode: "trust",
      packageName,
      allowedSubpaths: args.slice(2).map((entry) => String(entry ?? "").trim()).filter(Boolean),
    };
  }
  if (subcommand === "untrust") {
    const packageName = args.slice(1).join(" ").trim();
    if (!packageName) {
      return {
        error: "Usage: /plugins [list|trust <packageName> [subpath ...]|untrust <packageName>]",
      };
    }
    return {
      mode: "untrust",
      packageName,
    };
  }
  return {
    error: "Usage: /plugins [list|trust <packageName> [subpath ...]|untrust <packageName>]",
  };
}

function buildMcpCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "list").trim().toLowerCase();
  if (!subcommand || subcommand === "list") {
    return {
      mode: "report",
      section: "mcp",
    };
  }
  if (!["enable", "disable"].includes(subcommand)) {
    return {
      error: "Usage: /mcp [list|enable <serverName>|disable <serverName>]",
    };
  }
  const serverName = args.slice(1).join(" ").trim();
  if (!serverName) {
    return {
      error: "Usage: /mcp [list|enable <serverName>|disable <serverName>]",
    };
  }
  return {
    mode: "toggle",
    serverName,
    enabled: subcommand === "enable",
  };
}

function buildExtensibilityCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const section = (args[0] ?? "overview").trim().toLowerCase();
  if (!["overview", "skills", "plugins", "mcp", "hooks"].includes(section)) {
    return {
      error: "Usage: /extensibility [overview|skills|plugins|mcp|hooks]",
    };
  }
  return { section };
}

function buildInputPreferenceCommand(parsedSlash, {
  commandName,
  usage,
  defaultValue,
  allowedValues,
} = {}) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const token = (args[0] ?? "show").trim().toLowerCase();
  if (!token || token === "show" || token === "status") {
    return { mode: "show" };
  }
  if (allowedValues.includes(token)) {
    return {
      mode: "set",
      value: token === "insert" || token === "normal" ? "vim" : token,
      composerMode: commandName === "/input-mode" && ["insert", "normal"].includes(token)
        ? token
        : null,
    };
  }
  return {
    error: `Usage: ${usage}`,
  };
}

function isVimPreferenceEnabled(preferences = {}) {
  return preferences?.inputModeProfile === "vim" || preferences?.keybindingProfile === "vim";
}

function buildConfigCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const token = (args[0] ?? "show").trim().toLowerCase();
  if (!token || ["show", "status", "ui", "local"].includes(token)) {
    return { mode: "show" };
  }
  return {
    error: "Usage: /config [show]",
  };
}

function buildStatuslineCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const token = (args[0] ?? "show").trim().toLowerCase();
  if (!token || token === "show" || token === "status") {
    return { mode: "show" };
  }
  if (["on", "enable", "enabled"].includes(token)) {
    return { mode: "set", enabled: true };
  }
  if (["off", "disable", "disabled"].includes(token)) {
    return { mode: "set", enabled: false };
  }
  if (token === "toggle") {
    return { mode: "toggle" };
  }
  return {
    error: "Usage: /statusline [show|on|off|toggle]",
  };
}

function buildVimCommand(parsedSlash, { currentInputPreferences } = {}) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const token = (args[0] ?? "toggle").trim().toLowerCase();
  if (token === "show" || token === "status") {
    return { mode: "show" };
  }
  if (!token || token === "toggle") {
    return {
      mode: "set",
      enabled: !isVimPreferenceEnabled(currentInputPreferences?.() ?? {}),
    };
  }
  if (["on", "enable", "enabled"].includes(token)) {
    return { mode: "set", enabled: true };
  }
  if (["off", "disable", "disabled"].includes(token)) {
    return { mode: "set", enabled: false };
  }
  return {
    error: "Usage: /vim [show|on|off|toggle]",
  };
}

function buildDiffCommand(
  parsedSlash,
  {
    openLatestDiffDetail,
    currentDiffNavigationState,
    jumpCurrentDiffHunk,
    closeDetailView,
  },
) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "open").trim().toLowerCase();
  if (!subcommand || ["open", "latest", "show"].includes(subcommand)) {
    const diffEvent = openLatestDiffDetail();
    if (!diffEvent) {
      return {
        errorTitle: "No Diff Available",
        errorBody: "No diff or mutation preview is available in the current transcript.",
        status: "no diff available",
      };
    }
    return {
      title: "Diff View",
      body: `Opened diff detail for ${diffEvent.title}.`,
      status: `detail open: ${diffEvent.title}`,
    };
  }
  if (["next", "prev", "previous"].includes(subcommand)) {
    let navigation = currentDiffNavigationState();
    if (!navigation?.enabled) {
      const diffEvent = openLatestDiffDetail();
      if (!diffEvent) {
        return {
          errorTitle: "No Diff Available",
          errorBody: "No diff or mutation preview is available in the current transcript.",
          status: "no diff available",
        };
      }
      navigation = currentDiffNavigationState();
    }
    if (!navigation?.enabled) {
      return {
        errorTitle: "No Diff Hunk Navigation",
        errorBody: "The active detail view does not expose diff hunks.",
        status: "diff hunk navigation unavailable",
      };
    }
    const direction = subcommand === "next" ? 1 : -1;
    const moved = jumpCurrentDiffHunk(direction);
    const nextNavigation = currentDiffNavigationState();
    const ordinal = nextNavigation?.currentHunkIndex + 1;
    const total = nextNavigation?.totalHunks ?? 0;
    if (moved) {
      return {
        title: "Diff View",
        body:
          total > 0
            ? `Focused hunk ${ordinal}/${total}${nextNavigation?.currentFilePath ? ` in ${nextNavigation.currentFilePath}.` : "."}`
            : "Focused the requested diff hunk.",
        status:
          total > 0
            ? `hunk ${ordinal}/${total}`
            : "diff hunk focused",
      };
    }
    return {
      title: "Diff View",
      body:
        total > 0
          ? `Already at the ${direction > 0 ? "last" : "first"} hunk (${ordinal}/${total}).`
          : "No diff hunks are available in the active detail view.",
      status:
        total > 0
          ? `${direction > 0 ? "last" : "first"} hunk ${ordinal}/${total}`
          : "no diff hunks available",
    };
  }
  if (["close", "hide"].includes(subcommand)) {
    const navigation = currentDiffNavigationState();
    if (!navigation?.enabled) {
      return {
        errorTitle: "No Diff Detail Open",
        errorBody: "No diff detail is currently open.",
        status: "diff detail not open",
      };
    }
    const closed = closeDetailView();
    if (!closed) {
      return {
        errorTitle: "No Diff Detail Open",
        errorBody: "No diff detail is currently open.",
        status: "diff detail not open",
      };
    }
    return {
      title: "Diff View",
      body: "Closed the active diff detail view.",
      status: "detail closed",
    };
  }
  return {
    errorTitle: "Usage Error",
    errorBody: "Usage: /diff [open|next|prev|close]",
  };
}

export function createWatchCommandController(dependencies = {}) {
  const {
    watchState,
    queuedOperatorInputs,
    WATCH_COMMANDS,
    parseWatchSlashCommand,
    authPayload,
    send,
    shutdownWatch,
    dismissIntro,
    clearLiveTranscriptView,
    exportCurrentView,
    exportBundle,
    showInsights,
    showAgents,
    showExtensibility,
    showInputModes,
    showConfig,
    resetLiveRunSurface,
    resetDelegationState,
    persistSessionId,
    currentSessionLabel,
    setSessionLabel,
    clearSessionLabel,
    currentInputPreferences,
    setInputModeProfile,
    setKeybindingProfile,
    setThemeName,
    currentStatuslineEnabled,
    setStatuslineEnabled,
    trustPluginPackage,
    untrustPluginPackage,
    setMcpServerEnabled,
    captureCheckpoint,
    listCheckpoints,
    listPendingAttachments,
    formatPendingAttachments,
    queuePendingAttachment,
    resolveImplicitAttachmentInput,
    removePendingAttachment,
    clearPendingAttachments,
    prepareChatMessagePayload,
    openLatestDiffDetail,
    currentDiffNavigationState,
    jumpCurrentDiffHunk,
    closeDetailView,
    rewindToCheckpoint,
    clearBootstrapTimer,
    pushEvent,
    setTransientStatus,
    readWatchDaemonLogTail,
    formatLogPayload,
    currentClientKey,
    isOpen,
    bootstrapPending,
    voiceController,
    nowMs = Date.now,
  } = dependencies;

  assertObject("watchState", watchState);
  if (!Array.isArray(queuedOperatorInputs)) {
    throw new TypeError("createWatchCommandController requires a queuedOperatorInputs array");
  }
  if (!Array.isArray(WATCH_COMMANDS)) {
    throw new TypeError("createWatchCommandController requires WATCH_COMMANDS");
  }
  assertFunction("parseWatchSlashCommand", parseWatchSlashCommand);
  assertFunction("authPayload", authPayload);
  assertFunction("send", send);
  assertFunction("shutdownWatch", shutdownWatch);
  assertFunction("dismissIntro", dismissIntro);
  assertFunction("clearLiveTranscriptView", clearLiveTranscriptView);
  assertFunction("exportCurrentView", exportCurrentView);
  assertFunction("resetLiveRunSurface", resetLiveRunSurface);
  assertFunction("resetDelegationState", resetDelegationState);
  assertFunction("persistSessionId", persistSessionId);
  assertFunction("clearBootstrapTimer", clearBootstrapTimer);
  assertFunction("pushEvent", pushEvent);
  assertFunction("setTransientStatus", setTransientStatus);
  assertFunction("readWatchDaemonLogTail", readWatchDaemonLogTail);
  assertFunction("formatLogPayload", formatLogPayload);
  assertFunction("currentClientKey", currentClientKey);
  assertFunction("isOpen", isOpen);
  assertFunction("bootstrapPending", bootstrapPending);
  assertFunction("nowMs", nowMs);
  const commandNames = new Set(WATCH_COMMANDS.map((command) => command?.name).filter(Boolean));
  const attachmentCommandsEnabled =
    commandNames.has("/attach") ||
    commandNames.has("/attachments") ||
    commandNames.has("/unattach");
  if (
    commandNames.has("/checkpoint") ||
    commandNames.has("/checkpoints") ||
    commandNames.has("/rewind")
  ) {
    assertFunction("captureCheckpoint", captureCheckpoint);
    assertFunction("listCheckpoints", listCheckpoints);
    assertFunction("rewindToCheckpoint", rewindToCheckpoint);
  }
  if (commandNames.has("/diff")) {
    assertFunction("openLatestDiffDetail", openLatestDiffDetail);
    assertFunction("currentDiffNavigationState", currentDiffNavigationState);
    assertFunction("jumpCurrentDiffHunk", jumpCurrentDiffHunk);
    assertFunction("closeDetailView", closeDetailView);
  }
  if (attachmentCommandsEnabled) {
    assertFunction("listPendingAttachments", listPendingAttachments);
    assertFunction("formatPendingAttachments", formatPendingAttachments);
    assertFunction("queuePendingAttachment", queuePendingAttachment);
    assertFunction("removePendingAttachment", removePendingAttachment);
    assertFunction("clearPendingAttachments", clearPendingAttachments);
    assertFunction("prepareChatMessagePayload", prepareChatMessagePayload);
  }
  if (commandNames.has("/bundle")) {
    assertFunction("exportBundle", exportBundle);
  }
  if (commandNames.has("/insights")) {
    assertFunction("showInsights", showInsights);
  }
  if (commandNames.has("/agents")) {
    assertFunction("showAgents", showAgents);
  }
  if (commandNames.has("/extensibility")) {
    assertFunction("showExtensibility", showExtensibility);
  }
  if (
    commandNames.has("/input-mode") ||
    commandNames.has("/keybindings") ||
    commandNames.has("/theme")
  ) {
    assertFunction("showInputModes", showInputModes);
    assertFunction("currentInputPreferences", currentInputPreferences);
    assertFunction("setInputModeProfile", setInputModeProfile);
    assertFunction("setKeybindingProfile", setKeybindingProfile);
    assertFunction("setThemeName", setThemeName);
  }
  if (
    commandNames.has("/config") ||
    commandNames.has("/statusline") ||
    commandNames.has("/vim")
  ) {
    assertFunction("showConfig", showConfig);
    assertFunction("currentInputPreferences", currentInputPreferences);
    assertFunction("setInputModeProfile", setInputModeProfile);
    assertFunction("setKeybindingProfile", setKeybindingProfile);
    assertFunction("currentStatuslineEnabled", currentStatuslineEnabled);
    assertFunction("setStatuslineEnabled", setStatuslineEnabled);
  }
  if (commandNames.has("/plugins")) {
    assertFunction("trustPluginPackage", trustPluginPackage);
    assertFunction("untrustPluginPackage", untrustPluginPackage);
  }
  if (commandNames.has("/mcp")) {
    assertFunction("setMcpServerEnabled", setMcpServerEnabled);
  }
  if (commandNames.has("/session-label")) {
    assertFunction("currentSessionLabel", currentSessionLabel);
    assertFunction("setSessionLabel", setSessionLabel);
    assertFunction("clearSessionLabel", clearSessionLabel);
  }

  const listPendingAttachmentsImpl =
    typeof listPendingAttachments === "function" ? listPendingAttachments : () => [];
  const formatPendingAttachmentsImpl =
    typeof formatPendingAttachments === "function"
      ? formatPendingAttachments
      : () => "No attachments queued.";
  const prepareChatMessagePayloadImpl =
    typeof prepareChatMessagePayload === "function"
      ? prepareChatMessagePayload
      : (content) => ({
        payload: authPayload({ content }),
        attachmentSummaries: [],
      });

  function attachmentSummarySuffix() {
    const queued = listPendingAttachmentsImpl();
    if (!Array.isArray(queued) || queued.length === 0) {
      return "";
    }
    return `\n\nAttachments\n${formatPendingAttachmentsImpl()}`;
  }

  function sendPreparedChatMessage(content, {
    eventKind = "you",
    title = "Prompt",
    body = content,
    tone = "teal",
  } = {}) {
    const attachmentSuffix = attachmentSummarySuffix();
    let prepared;
    try {
      prepared = prepareChatMessagePayloadImpl(content, { consumeAttachments: true });
    } catch (error) {
      setTransientStatus("attachment error");
      pushEvent(
        "error",
        "Attachment Error",
        error instanceof Error ? error.message : String(error),
        "red",
      );
      return false;
    }
    pushEvent(eventKind, title, `${body}${attachmentSuffix}`, tone);
    send("chat.message", prepared.payload);
    if (Array.isArray(prepared?.attachmentSummaries) && prepared.attachmentSummaries.length > 0) {
      setTransientStatus(
        `sent with ${prepared.attachmentSummaries.length} attachment${prepared.attachmentSummaries.length === 1 ? "" : "s"}`,
      );
    }
    return true;
  }

  function printHelp() {
    pushEvent(
      "help",
      "Command Help",
      [
        "Keyboard",
        "Ctrl+O opens the newest event in a full detail view.",
        "Ctrl+Y copies the current detail view or transcript to tmux/system clipboard.",
        "Ctrl+L clears the visible transcript without leaving the session.",
        "",
        ...WATCH_COMMANDS.map((command) => {
          const aliasText =
            Array.isArray(command.aliases) && command.aliases.length > 0
              ? ` (${command.aliases.join(", ")})`
              : "";
          return `${command.usage}${aliasText}\n${command.description}`;
        }),
      ].join("\n\n"),
      "slate",
    );
  }

  function queueOperatorInput(value, reason = "bootstrap pending") {
    queuedOperatorInputs.push(value);
    pushEvent(
      "queued",
      "Queued Input",
      `${value}\n\n${reason}`,
      "amber",
    );
    setTransientStatus(`queued ${value} until session restore completes`);
  }

  function requireSession(command) {
    if (!watchState.sessionId) {
      pushEvent("error", "Session Error", `${command} requires an active session`, "red");
      return false;
    }
    return true;
  }

  function shouldQueueOperatorInput() {
    return !isOpen() || bootstrapPending();
  }

  function queueLocalAttachment(inputPath, { implicit = false } = {}) {
    try {
      const result = queuePendingAttachment(inputPath, {
        allowMissing: implicit === true,
      });
      setTransientStatus(
        result.duplicate === true
          ? `attachment already queued: ${result.attachment.filename}`
          : `attachment queued: ${result.attachment.filename}`,
      );
      pushEvent(
        "operator",
        result.duplicate === true
          ? "Attachment Already Queued"
          : implicit === true
            ? "Attachment Queued From Path"
            : "Attachment Queued",
        formatPendingAttachmentsImpl(),
        result.duplicate === true ? "amber" : "teal",
      );
    } catch (error) {
      setTransientStatus("attachment error");
      pushEvent(
        "error",
        "Attachment Error",
        error instanceof Error ? error.message : String(error),
        "red",
      );
    }
    return true;
  }

  function dispatchOperatorInput(value, { replayed = false } = {}) {
    dismissIntro();
    watchState.transcriptScrollOffset = 0;
    watchState.transcriptFollowMode = true;
    const maybeQueue = (reason) => {
      if (replayed) {
        pushEvent("error", "Queued Input Failed", `${value}\n\n${reason}`, "red");
        return true;
      }
      queueOperatorInput(value, reason);
      return true;
    };

    if (value.trim() === "/") {
      printHelp();
      return true;
    }

    const parsedSlash = parseWatchSlashCommand(value);
    if (parsedSlash) {
      const canonicalName = parsedSlash.command?.name ?? null;
      const firstArg = parsedSlash.args[0];

      if (canonicalName === "/quit") {
        shutdownWatch(0);
        return true;
      }

      if (canonicalName === "/help") {
        printHelp();
        return true;
      }

      if (canonicalName === "/clear") {
        clearLiveTranscriptView();
        return true;
      }

      if (canonicalName === "/export") {
        exportCurrentView({ announce: true });
        return true;
      }

      if (canonicalName === "/bundle") {
        exportBundle({ announce: true });
        return true;
      }

      if (canonicalName === "/insights") {
        showInsights();
        return true;
      }

      if (canonicalName === "/agents") {
        showAgents({
          query: parsedSlash.args.join(" ").trim() || null,
        });
        return true;
      }

      if (canonicalName === "/extensibility") {
        const action = buildExtensibilityCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        showExtensibility({ section: action.section });
        return true;
      }

      if (canonicalName === "/hooks") {
        showExtensibility({ section: "hooks" });
        return true;
      }

      if (canonicalName === "/plugins") {
        const action = buildPluginCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        try {
          if (action.mode === "report") {
            showExtensibility({ section: action.section });
          } else if (action.mode === "trust") {
            trustPluginPackage(action.packageName, action.allowedSubpaths);
          } else {
            untrustPluginPackage(action.packageName);
          }
        } catch (error) {
          setTransientStatus("plugin update failed");
          pushEvent(
            "error",
            "Plugin Config Error",
            error instanceof Error ? error.message : String(error),
            "red",
          );
        }
        return true;
      }

      if (canonicalName === "/mcp") {
        const action = buildMcpCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        try {
          if (action.mode === "report") {
            showExtensibility({ section: action.section });
          } else {
            setMcpServerEnabled(action.serverName, action.enabled);
          }
        } catch (error) {
          setTransientStatus("mcp update failed");
          pushEvent(
            "error",
            "MCP Config Error",
            error instanceof Error ? error.message : String(error),
            "red",
          );
        }
        return true;
      }

      if (canonicalName === "/config") {
        const action = buildConfigCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        setTransientStatus("local config ready");
        showConfig();
        return true;
      }

      if (
        canonicalName === "/input-mode" ||
        canonicalName === "/keybindings" ||
        canonicalName === "/theme"
      ) {
        const action =
          canonicalName === "/input-mode"
            ? buildInputPreferenceCommand(parsedSlash, {
              commandName: canonicalName,
              usage: "/input-mode [show|default|vim]",
              defaultValue: "default",
              allowedValues: ["default", "vim", "insert", "normal"],
            })
            : canonicalName === "/keybindings"
              ? buildInputPreferenceCommand(parsedSlash, {
                commandName: canonicalName,
                usage: "/keybindings [show|default|vim]",
                defaultValue: "default",
                allowedValues: ["default", "vim"],
              })
              : buildInputPreferenceCommand(parsedSlash, {
                commandName: canonicalName,
                usage: "/theme [show|default|aurora|ember|matrix]",
                defaultValue: "default",
                allowedValues: ["default", "aurora", "ember", "matrix"],
              });
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        if (action.mode === "show") {
          showInputModes();
          return true;
        }
        if (canonicalName === "/input-mode") {
          setInputModeProfile(action.value);
          if (action.composerMode) {
            watchState.composerMode = action.composerMode;
          }
          setTransientStatus(`input mode: ${watchState.inputPreferences.inputModeProfile}`);
        } else if (canonicalName === "/keybindings") {
          setKeybindingProfile(action.value);
          setTransientStatus(`keybindings: ${watchState.inputPreferences.keybindingProfile}`);
        } else {
          setThemeName(action.value);
          setTransientStatus(`theme: ${watchState.inputPreferences.themeName}`);
        }
        showInputModes();
        return true;
      }

      if (canonicalName === "/statusline") {
        const action = buildStatuslineCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        if (action.mode === "show") {
          setTransientStatus("local config ready");
          showConfig();
          return true;
        }
        const enabled =
          action.mode === "toggle"
            ? currentStatuslineEnabled() !== true
            : action.enabled === true;
        setStatuslineEnabled(enabled);
        setTransientStatus(`statusline: ${enabled ? "on" : "off"}`);
        showConfig();
        return true;
      }

      if (canonicalName === "/vim") {
        const action = buildVimCommand(parsedSlash, { currentInputPreferences });
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        if (action.mode === "show") {
          setTransientStatus("local config ready");
          showConfig();
          return true;
        }
        setInputModeProfile(action.enabled === true ? "vim" : "default");
        setKeybindingProfile(action.enabled === true ? "vim" : "default");
        watchState.composerMode = "insert";
        setTransientStatus(`vim mode: ${action.enabled === true ? "on" : "off"}`);
        showConfig();
        return true;
      }

      if (canonicalName === "/attach") {
        const inputPath = parsedSlash.args.join(" ").trim();
        if (!inputPath) {
          pushEvent("error", "Usage Error", "Usage: /attach <path>", "red");
          return true;
        }
        return queueLocalAttachment(inputPath);
      }

      if (canonicalName === "/attachments") {
        const queued = listPendingAttachmentsImpl();
        setTransientStatus(
          queued.length > 0
            ? `${queued.length} attachment${queued.length === 1 ? "" : "s"} queued`
            : "no attachments queued",
        );
        pushEvent(
          "operator",
          "Queued Attachments",
          formatPendingAttachmentsImpl(),
          "slate",
        );
        return true;
      }

      if (canonicalName === "/unattach") {
        const reference = parsedSlash.args.join(" ").trim() || null;
        const result = removePendingAttachment(reference);
        if (result?.error) {
          setTransientStatus("attachment missing");
          pushEvent("error", "Attachment Error", result.error, "red");
          return true;
        }
        const removed = Array.isArray(result?.removed) ? result.removed : [];
        const remaining = listPendingAttachmentsImpl();
        setTransientStatus(
          remaining.length > 0
            ? `${remaining.length} attachment${remaining.length === 1 ? "" : "s"} queued`
            : "attachments cleared",
        );
        pushEvent(
          "operator",
          "Attachment Removed",
          removed.length > 0
            ? `${removed.length} attachment${removed.length === 1 ? "" : "s"} removed.\n\n${removed.map((attachment, index) => `${index + 1}. ${attachment.filename ?? attachment.id ?? "attachment"}`).join("\n")}`
            : "No attachments removed.",
          "teal",
        );
        return true;
      }

      if (!canonicalName) {
        if (attachmentCommandsEnabled && typeof resolveImplicitAttachmentInput === "function") {
          const implicitAttachmentInput = resolveImplicitAttachmentInput(value);
          if (implicitAttachmentInput) {
            return queueLocalAttachment(implicitAttachmentInput, { implicit: true });
          }
        }
        pushEvent(
          "error",
          "Unknown Command",
          `${parsedSlash.commandToken} is not a supported command.\n\nUse /help for the full command list.`,
          "red",
        );
        return true;
      }

      if (shouldQueueOperatorInput()) {
        return maybeQueue("session bootstrap not complete");
      }

      if (canonicalName === "/skills") {
        const action = buildSkillTogglePayload(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        pushEvent("operator", action.title, action.body, "teal");
        if (action.mode === "list") {
          send("skills.list", {});
          setTransientStatus("requesting skills");
        } else {
          send("skills.toggle", action.payload);
          setTransientStatus(action.status);
        }
        return true;
      }

      if (canonicalName === "/model") {
        const modelArg = (firstArg ?? "").trim();
        pushEvent(
          "operator",
          modelArg ? "Model Switch" : "Model Query",
          modelArg
            ? `Requested model switch to: ${modelArg}`
            : "Requested current model routing info.",
          "teal",
        );
        send("chat.message", authPayload({ content: value }));
        return true;
      }

      if (canonicalName === "/init") {
        pushEvent(
          "operator",
          "Project Guide Init",
          "Requested AGENC.md generation for the active workspace.",
          "teal",
        );
        send("chat.message", authPayload({ content: value }));
        return true;
      }

      if (canonicalName === "/voice") {
        if (voiceController) {
          const voiceArg = (firstArg ?? "").trim().toLowerCase();
          if (voiceArg === "stop" || voiceArg === "off") {
            voiceController.stopVoice();
          } else if (!voiceArg || voiceArg === "start" || voiceArg === "on") {
            voiceController.startVoice();
          } else {
            // Voice persona change or config query — forward to daemon
            send("chat.message", authPayload({ content: value }));
          }
        } else {
          // No voice controller — just forward to daemon for config display
          send("chat.message", authPayload({ content: value }));
        }
        return true;
      }

      if (canonicalName === "/context") {
        pushEvent("operator", "Context", "Requested context window usage.", "teal");
        send("chat.message", authPayload({ content: "/context" }));
        return true;
      }

      if (canonicalName === "/compact") {
        const action = buildCompactionCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        pushEvent("operator", action.title, action.body, "teal");
        send("chat.message", authPayload({ content: action.content }));
        return true;
      }

      if (
        canonicalName === "/run-cancel" ||
        canonicalName === "/run-objective" ||
        canonicalName === "/run-constraints" ||
        canonicalName === "/run-budget" ||
        canonicalName === "/run-compact" ||
        canonicalName === "/run-worker" ||
        canonicalName === "/retry-run" ||
        canonicalName === "/retry-step" ||
        canonicalName === "/retry-trace" ||
        canonicalName === "/run-fork" ||
        canonicalName === "/verify-override"
      ) {
        if (!requireSession(canonicalName)) return true;
        const runAvailability = watchState.runDetail?.availability;
        if (runAvailability?.controlAvailable === false) {
          setTransientStatus("run control unavailable");
          pushEvent(
            "error",
            "Run Control Unavailable",
            runAvailability.disabledReason ??
              "Durable background run controls are not available for this runtime.",
            "red",
          );
          return true;
        }
        if (
          (canonicalName === "/retry-run" ||
            canonicalName === "/retry-step" ||
            canonicalName === "/retry-trace" ||
            canonicalName === "/run-fork") &&
          watchState.runDetail &&
          watchState.runDetail.checkpointAvailable === false
        ) {
          setTransientStatus("checkpoint unavailable");
          pushEvent(
            "error",
            "Checkpoint Unavailable",
            "The active durable run does not currently expose a retryable checkpoint.",
            "red",
          );
          return true;
        }
        const action =
          canonicalName === "/run-cancel"
            ? buildRunCancelCommand(parsedSlash, watchState.sessionId)
            : canonicalName === "/run-objective"
              ? buildRunObjectiveCommand(parsedSlash, watchState.sessionId)
              : canonicalName === "/run-constraints"
                ? buildRunConstraintsCommand(parsedSlash, watchState.sessionId)
                : canonicalName === "/run-budget"
                  ? buildRunBudgetCommand(parsedSlash, watchState.sessionId)
                  : canonicalName === "/run-compact"
                    ? buildRunCompactCommand(parsedSlash, watchState.sessionId)
                    : canonicalName === "/run-worker"
                      ? buildRunWorkerCommand(parsedSlash, watchState.sessionId)
                      : canonicalName === "/retry-run"
                        ? buildRetryRunCommand(parsedSlash, watchState.sessionId)
                        : canonicalName === "/retry-step"
                          ? buildRetryStepCommand(parsedSlash, watchState.sessionId)
                          : canonicalName === "/retry-trace"
                            ? buildRetryTraceCommand(parsedSlash, watchState.sessionId)
                            : canonicalName === "/run-fork"
                              ? buildRunForkCommand(parsedSlash, watchState.sessionId)
                        : buildVerificationOverrideCommand(parsedSlash, watchState.sessionId);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        watchState.runInspectPending = true;
        setTransientStatus(action.status);
        pushEvent("operator", action.title, action.body, "teal");
        send("run.control", action.payload);
        return true;
      }

      if (canonicalName === "/desktop") {
        const action = buildDesktopCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        pushEvent("operator", action.title, action.body, "teal");
        send("chat.message", authPayload({ content: action.content }));
        return true;
      }

      if (canonicalName === "/permissions") {
        const action = buildPermissionsCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        pushEvent("operator", action.title, action.body, "teal");
        send("chat.message", authPayload({ content: action.content }));
        return true;
      }

      if (canonicalName === "/approvals") {
        const action = buildApprovalsCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        pushEvent("operator", action.title, action.body, "teal");
        send("chat.message", authPayload({ content: action.content }));
        return true;
      }

      if (canonicalName === "/diff") {
        const action = buildDiffCommand(parsedSlash, {
          openLatestDiffDetail,
          currentDiffNavigationState,
          jumpCurrentDiffHunk,
          closeDetailView,
        });
        if (action.errorBody) {
          pushEvent(
            "error",
            action.errorTitle ?? "No Diff Available",
            action.errorBody,
            "red",
          );
          if (action.status) {
            setTransientStatus(action.status);
          }
          return true;
        }
        if (action.status) {
          setTransientStatus(action.status);
        }
        pushEvent("operator", action.title, action.body, "teal");
        return true;
      }

      if (canonicalName === "/checkpoint") {
        const label = parsedSlash.args.join(" ").trim();
        const summary = captureCheckpoint(label || null, { reason: "manual" });
        setTransientStatus(`checkpoint saved: ${summary.id}`);
        pushEvent(
          "checkpoint",
          "Checkpoint Saved",
          formatCheckpointSummary(summary),
          "blue",
        );
        return true;
      }

      if (canonicalName === "/checkpoints") {
        const limitArg = parsedSlash.args[0];
        const parsedLimit = Number(limitArg);
        if (limitArg && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
          pushEvent(
            "error",
            "Usage Error",
            "Usage: /checkpoints [limit]",
            "red",
          );
          return true;
        }
        const limit = limitArg ? Math.floor(parsedLimit) : 8;
        const summaries = listCheckpoints({ limit });
        setTransientStatus(
          summaries.length > 0
            ? `${summaries.length} checkpoint${summaries.length === 1 ? "" : "s"} listed`
            : "no checkpoints",
        );
        pushEvent(
          "checkpoint",
          "Checkpoint History",
          formatCheckpointList(summaries),
          "slate",
        );
        return true;
      }

      if (canonicalName === "/rewind") {
        const reference = parsedSlash.args.join(" ").trim() || "latest";
        const summary = rewindToCheckpoint(reference);
        if (!summary) {
          pushEvent(
            "error",
            "Checkpoint Not Found",
            `No checkpoint matched ${reference}.`,
            "red",
          );
          setTransientStatus("checkpoint missing");
          return true;
        }
        setTransientStatus(`rewound to ${summary.id}`);
        pushEvent(
          "checkpoint",
          "Checkpoint Rewind",
          formatCheckpointSummary(summary),
          "amber",
        );
        return true;
      }

      if (
        canonicalName === "/review" ||
        canonicalName === "/security-review" ||
        canonicalName === "/pr-comments"
      ) {
        const presentation = reviewModePresentation(canonicalName);
        const previousObjective = watchState.currentObjective;
        const previousRunState = watchState.runState;
        const previousRunPhase = watchState.runPhase;
        const previousRunStartedAtMs = watchState.activeRunStartedAtMs;
        watchState.currentObjective = presentation.title;
        watchState.runState = "starting";
        watchState.runPhase = "queued";
        watchState.activeRunStartedAtMs = nowMs();
        resetDelegationState();
        const sent = sendPreparedChatMessage(
          buildReviewModePrompt(canonicalName, parsedSlash.args),
          {
            eventKind: "operator",
            title: presentation.title,
            body: presentation.body,
            tone: "teal",
          },
        );
        if (!sent) {
          watchState.currentObjective = previousObjective;
          watchState.runState = previousRunState;
          watchState.runPhase = previousRunPhase;
          watchState.activeRunStartedAtMs = previousRunStartedAtMs;
        }
        return true;
      }

      if (canonicalName === "/memory") {
        if (shouldQueueOperatorInput()) {
          return maybeQueue("session bootstrap not complete");
        }
        const query = (firstArg ?? "").trim();
        if (query) {
          pushEvent("operator", "Memory Search", `Searching memory for: ${query}`, "teal");
          send("memory.search", authPayload({ query }));
        } else {
          pushEvent("operator", "Memory Sessions", "Fetching memory sessions.", "teal");
          send("memory.sessions", authPayload({ limit: 20 }));
        }
        return true;
      }

      if (canonicalName === "/new") {
        const preResetCheckpoint = commandNames.has("/checkpoint")
          ? captureCheckpoint("Before new session", { reason: "new-session" })
          : null;
        const clearedAttachments = attachmentCommandsEnabled
          ? clearPendingAttachments()
          : [];
        resetLiveRunSurface();
        resetDelegationState();
        watchState.currentObjective = null;
        watchState.runDetail = null;
        watchState.runState = "idle";
        watchState.runPhase = null;
        watchState.bootstrapAttempts = 0;
        clearBootstrapTimer();
        pushEvent(
          "operator",
          "New Session",
          preResetCheckpoint
            ? `Requested a fresh chat session.\n\nSaved ${preResetCheckpoint.id} before reset.${clearedAttachments.length > 0 ? `\n\nCleared ${clearedAttachments.length} queued attachment${clearedAttachments.length === 1 ? "" : "s"}.` : ""}`
            : clearedAttachments.length > 0
              ? `Requested a fresh chat session.\n\nCleared ${clearedAttachments.length} queued attachment${clearedAttachments.length === 1 ? "" : "s"}.`
              : "Requested a fresh chat session.",
          "teal",
        );
        send("chat.new", authPayload());
        return true;
      }

      if (canonicalName === "/sessions") {
        watchState.manualSessionsRequestPending = true;
        watchState.manualSessionsQuery = parsedSlash.args.join(" ").trim() || null;
        pushEvent(
          "operator",
          "Session List",
          watchState.manualSessionsQuery
            ? `Requested resumable sessions matching: ${watchState.manualSessionsQuery}`
            : "Requested resumable sessions.",
          "teal",
        );
        send("chat.sessions", authPayload());
        return true;
      }

      if (canonicalName === "/session") {
        if (!firstArg) {
          pushEvent(
            "error",
            "Missing Session Id",
            "Usage: /session <sessionId>",
            "red",
          );
          return true;
        }
        watchState.sessionId = firstArg;
        persistSessionId(watchState.sessionId);
        pushEvent("operator", "Session Resume", `Resuming ${firstArg}.`, "teal");
        send("chat.resume", authPayload({ sessionId: firstArg }));
        return true;
      }

      if (canonicalName === "/session-label") {
        if (!requireSession("/session-label")) return true;
        const rawArgs = parsedSlash.args.map((arg) => String(arg ?? "").trim()).filter(Boolean);
        const subcommand = (rawArgs[0] ?? "").toLowerCase();
        if (rawArgs.length === 0 || subcommand === "show") {
          const label = currentSessionLabel();
          setTransientStatus(label ? `session label: ${label}` : "session label not set");
          pushEvent(
            "session",
            "Session Label",
            label
              ? `Session ${watchState.sessionId}\nlocal label: ${label}`
              : `Session ${watchState.sessionId}\nNo local label set.`,
            "teal",
          );
          return true;
        }
        if (subcommand === "clear") {
          const cleared = clearSessionLabel();
          setTransientStatus(cleared ? "session label cleared" : "session label not set");
          pushEvent(
            "session",
            "Session Label Cleared",
            cleared
              ? `Cleared local label for ${watchState.sessionId}.\n\nPrevious label: ${cleared}`
              : `No local label was set for ${watchState.sessionId}.`,
            cleared ? "amber" : "slate",
          );
          return true;
        }
        const label = subcommand === "set"
          ? rawArgs.slice(1).join(" ").trim()
          : rawArgs.join(" ").trim();
        if (!label) {
          pushEvent(
            "error",
            "Usage Error",
            "Usage: /session-label [show|clear|<label>]",
            "red",
          );
          return true;
        }
        const result = setSessionLabel(label);
        setTransientStatus(
          result.changed
            ? `session label set: ${result.label}`
            : `session label unchanged: ${result.label}`,
        );
        pushEvent(
          "session",
          "Session Label Updated",
          result.previous && result.previous !== result.label
            ? `Session ${result.sessionId}\nlocal label: ${result.label}\nprevious: ${result.previous}`
            : `Session ${result.sessionId}\nlocal label: ${result.label}`,
          result.changed ? "teal" : "slate",
        );
        return true;
      }

      if (canonicalName === "/history") {
        watchState.manualHistoryRequestPending = true;
        const limit = Number(firstArg);
        const payload = Number.isFinite(limit) && limit > 0
          ? authPayload({ limit: Math.floor(limit) })
          : authPayload();
        pushEvent("operator", "History Query", "Requested recent chat history.", "teal");
        send("chat.history", payload);
        return true;
      }

      if (canonicalName === "/runs") {
        pushEvent("operator", "Run List", "Requested active runs for this session.", "teal");
        send("runs.list", watchState.sessionId ? { sessionId: watchState.sessionId } : {});
        return true;
      }

      if (canonicalName === "/inspect") {
        if (!requireSession("/inspect")) return true;
        watchState.runInspectPending = true;
        pushEvent("operator", "Run Inspect", `Inspecting run for ${watchState.sessionId}.`, "teal");
        send("run.inspect", { sessionId: watchState.sessionId });
        return true;
      }

      if (canonicalName === "/trace") {
        if (firstArg) {
          pushEvent("operator", "Trace Detail", `Inspecting trace ${firstArg}.`, "teal");
          send("observability.trace", { traceId: firstArg });
        } else {
          pushEvent("operator", "Trace Query", "Requested recent traces.", "teal");
          send(
            "observability.traces",
            watchState.sessionId ? { sessionId: watchState.sessionId, limit: 5 } : { limit: 5 },
          );
        }
        return true;
      }

      if (canonicalName === "/logs") {
        const lines = Number(firstArg);
        const lineCount = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 80;
        pushEvent("operator", "Log Query", `Requested recent daemon logs (${lineCount} lines).`, "teal");
        try {
          const logs = readWatchDaemonLogTail({ lines: lineCount });
          setTransientStatus("log bundle loaded");
          pushEvent("logs", "Daemon Logs", formatLogPayload(logs), "slate");
        } catch (error) {
          setTransientStatus("runtime error");
          pushEvent(
            "error",
            "Runtime Error",
            error instanceof Error ? error.message : String(error),
            "red",
          );
        }
        return true;
      }

      if (canonicalName === "/status") {
        watchState.manualStatusRequestPending = true;
        pushEvent("operator", "Gateway Status", "Requested daemon status.", "teal");
        send("status.get", {});
        return true;
      }

      if (canonicalName === "/cancel") {
        pushEvent("operator", "Cancel Chat", `Cancelling chat for ${currentClientKey()}.`, "teal");
        send("chat.cancel", authPayload());
        return true;
      }

      if (canonicalName === "/pause" || canonicalName === "/resume" || canonicalName === "/stop") {
        if (!requireSession(canonicalName)) return true;
        watchState.runInspectPending = true;
        const action = canonicalName.slice(1);
        const title = action[0].toUpperCase() + action.slice(1);
        const progressiveVerb =
          action === "pause"
            ? "Pausing"
            : action === "resume"
              ? "Resuming"
              : "Stopping";
        pushEvent("operator", `${title} Run`, `${progressiveVerb} run for ${watchState.sessionId}.`, "teal");
        send("run.control", {
          action,
          sessionId: watchState.sessionId,
          reason: `operator ${action}`,
        });
        return true;
      }
    }

    if (shouldQueueOperatorInput()) {
      return maybeQueue("session bootstrap not complete");
    }
    persistSessionId(watchState.sessionId);
    const previousObjective = watchState.currentObjective;
    const previousRunState = watchState.runState;
    const previousRunPhase = watchState.runPhase;
    const previousRunStartedAtMs = watchState.activeRunStartedAtMs;
    watchState.currentObjective = value;
    watchState.runState = "starting";
    watchState.runPhase = "queued";
    watchState.activeRunStartedAtMs = nowMs();
    resetDelegationState();
    const sent = sendPreparedChatMessage(value, {
      eventKind: "you",
      title: "Prompt",
      body: value,
      tone: "teal",
    });
    if (!sent) {
      watchState.currentObjective = previousObjective;
      watchState.runState = previousRunState;
      watchState.runPhase = previousRunPhase;
      watchState.activeRunStartedAtMs = previousRunStartedAtMs;
    }
    return true;
  }

  function flushQueuedOperatorInputs() {
    if (!isOpen() || bootstrapPending() || queuedOperatorInputs.length === 0) {
      return;
    }
    while (queuedOperatorInputs.length > 0) {
      const value = queuedOperatorInputs.shift();
      if (!value) {
        continue;
      }
      dispatchOperatorInput(value, { replayed: true });
    }
  }

  return {
    printHelp,
    queueOperatorInput,
    flushQueuedOperatorInputs,
    shouldQueueOperatorInput,
    dispatchOperatorInput,
  };
}
