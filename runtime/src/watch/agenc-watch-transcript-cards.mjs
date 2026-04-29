function plainText(line) {
  if (typeof line === "string") {
    return line;
  }
  return String(line?.plainText ?? line?.text ?? "");
}

function usesPreviewHeadline(kind) {
  return kind === "you" || kind === "queued" || kind === "agent";
}

export const TRANSCRIPT_VISIBLE_TOOL_INPUT_FIELDS = Object.freeze([
  "command",
  "pattern",
  "file_path",
  "filePath",
  "path",
  "prompt",
  "description",
  "query",
  "url",
  "skill",
  "args",
  "files",
]);

export const TRANSCRIPT_VISIBLE_TOOL_RESULT_FIELDS = Object.freeze([
  "stdout",
  "stderr",
  "content",
  "output",
  "result",
  "text",
  "message",
  "filenames",
  "lines",
  "results",
]);

function stripSystemReminders(value) {
  return String(value ?? "").replace(
    /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
    "",
  );
}

function appendSearchText(parts, value) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendSearchText(parts, entry);
    }
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value)) {
      if (typeof entry !== "object") {
        appendSearchText(parts, entry);
      }
    }
    return;
  }
  const text = stripSystemReminders(value).replace(/\s+/g, " ").trim();
  if (text) {
    parts.push(text);
  }
}

function appendVisibleFields(parts, source, fields) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  for (const field of fields) {
    appendSearchText(parts, source[field]);
  }
}

export function splitTranscriptPreviewForHeadline(event, previewLines = []) {
  const lines = Array.isArray(previewLines) ? [...previewLines] : [];
  if (!usesPreviewHeadline(String(event?.kind ?? ""))) {
    return {
      headline: "",
      bodyLines: lines,
    };
  }

  const firstPreviewLine = plainText(lines.shift() ?? "");
  return {
    headline: firstPreviewLine,
    bodyLines: lines,
  };
}

export function buildTranscriptCardSearchText(event, previewLines = []) {
  const parts = [];
  appendSearchText(parts, event?.title);
  appendSearchText(parts, event?.body);
  appendSearchText(parts, event?.toolName);
  for (const line of Array.isArray(previewLines) ? previewLines : []) {
    appendSearchText(parts, plainText(line));
  }
  appendVisibleFields(parts, event?.toolArgs, TRANSCRIPT_VISIBLE_TOOL_INPUT_FIELDS);
  appendVisibleFields(parts, event?.toolResult, TRANSCRIPT_VISIBLE_TOOL_RESULT_FIELDS);
  appendVisibleFields(parts, event?.result, TRANSCRIPT_VISIBLE_TOOL_RESULT_FIELDS);
  return [...new Set(parts)].join("\n");
}

export function resolveTranscriptCardLabel(event = {}) {
  const kind = String(event.kind ?? "");
  const toolName = String(event.toolName ?? event.title ?? "");
  if (event.cardLabel) {
    return String(event.cardLabel);
  }
  if (kind === "approval") {
    return "AUTH";
  }
  if (/VerifyPlanExecution|verify_plan_execution|verification/i.test(toolName)) {
    return "VERIFY";
  }
  if (/EnterPlanMode|ExitPlanMode|plan mode|approved.*plan|submitted.*plan/i.test(toolName)) {
    return "PLAN";
  }
  if (kind === "tool result" || kind === "tool error") {
    return kind === "tool error" || event.isError ? "ERROR" : "RETURN";
  }
  if (kind === "tool") {
    return "EXEC";
  }
  return "";
}

export function getTranscriptCardActions(event = {}) {
  const actions = ["copy"];
  if (event.hasBody !== false) {
    actions.push("detail");
  }
  if (event.filePath) {
    actions.push("open-file");
  }
  if (event.kind === "approval") {
    actions.push("review-approval");
  }
  if (
    event.filePath
    && (
      resolveTranscriptCardLabel(event) === "PLAN"
      || /EnterPlanMode|ExitPlanMode|plan/i.test(String(event.toolName ?? event.title ?? event.filePath ?? ""))
    )
  ) {
    actions.push("open-plan");
  }
  return actions;
}

export function computeTranscriptPreviewMaxLines({
  eventKind = "",
  sourcePreview = false,
  mutationPreview = false,
  latestIsCurrent = false,
  following = false,
  viewportLines = 12,
  maxPreviewSourceLines = 160,
} = {}) {
  const viewport = Math.max(12, Number(viewportLines) || 12);
  if (eventKind === "agent" && latestIsCurrent && following) {
    return Infinity;
  }
  const sourceInlineBudget = mutationPreview
    ? Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 32 : 18,
        Math.floor(viewport * (latestIsCurrent ? 0.84 : 0.56)),
      ),
    )
    : Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 12 : 6,
        Math.floor(viewport * (latestIsCurrent ? 0.32 : 0.2)),
      ),
    );
  if (mutationPreview) {
    return sourceInlineBudget;
  }
  if (sourcePreview) {
    return Math.min(sourceInlineBudget, latestIsCurrent ? 10 : 6);
  }
  if (eventKind === "agent") {
    return Math.max(
      latestIsCurrent ? 10 : 6,
      Math.floor(viewport * (latestIsCurrent ? 0.42 : 0.24)),
    );
  }
  if (eventKind === "market") {
    return latestIsCurrent ? 8 : 6;
  }
  // Tool and subagent outputs are where code and file contents land. The
  // old 2-line cap reduced an editFile diff, a readFile of a 200-line
  // source file, or a bash build log to "first line + ellipsis", which
  // is exactly what made every non-trivial tool result look "cut off".
  // Use the same proportional sizing as `sourceInlineBudget` so tool
  // output respects the viewport instead of a hard cap.
  if (
    eventKind === "tool" ||
    eventKind === "tool result" ||
    eventKind === "tool error" ||
    eventKind === "subagent tool" ||
    eventKind === "subagent tool result" ||
    eventKind === "subagent error"
  ) {
    return Math.min(
      maxPreviewSourceLines,
      Math.max(
        latestIsCurrent ? 20 : 10,
        Math.floor(viewport * (latestIsCurrent ? 0.55 : 0.3)),
      ),
    );
  }
  if (eventKind === "subagent") {
    // Subagent status cards are lighter than their tool output — a
    // short summary is enough — but 2 was too aggressive; show the
    // full summary headline + progress lines.
    return latestIsCurrent ? 6 : 4;
  }
  if (eventKind === "you" || eventKind === "operator" || eventKind === "queued") {
    return 3;
  }
  if (eventKind === "approval") {
    return latestIsCurrent ? 6 : 4;
  }
  if (eventKind === "error") {
    return 3;
  }
  // Keep the conservative default for unrecognized event kinds. The
  // tool/subagent cases above are where the "code is cut off"
  // symptom lives; unknown kinds are rare and a tight default
  // prevents spam when new event types are added without explicit
  // sizing.
  return 2;
}
