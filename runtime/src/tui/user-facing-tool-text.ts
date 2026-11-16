/**
 * The presentation boundary for tool text.
 *
 * A tool result is written for the model. Tool-specific renderers turn the
 * normal cases into rows, but several paths print result text as it is: a
 * stored row whose typed output is missing or invalid, a result with no
 * matching call, an out-of-order result, a tool with no renderer in the
 * expanded view, a failed row's reason. Every such path passes its text
 * through this module first, so instructions addressed to the model,
 * `<system-reminder>` wrappers, internal ids and protocol footers do not
 * reach the screen.
 *
 * Only text the runtime itself writes is rewritten. Real file, shell and
 * external tool output is left as it is.
 *
 * Pure module: no React, provider or registry imports.
 */
import {
  askUserQuestionDisplayFromModelText,
  formatAskUserQuestionDisplay,
} from "../tools/ask-user-question/display.js";
import {
  ENTERED_PLAN_MODE_TEXT,
  PLAN_MODE_ALREADY_ACTIVE_TEXT,
  exitPlanModeReceipt,
  skillLoadReceipt,
  userFacingToolResultText,
} from "../tools/user-facing-result.js";


/** A file-read warning (the only reminders a tool result carries for display). */
function fileReadWarningText(inner: string): string | undefined {
  const text = inner.trim();
  if (/^Warning: the file exists but the contents are empty\.?$/u.test(text)) return "Empty file";
  if (/^Warning: the PDF exists but no extractable text was found\.?$/u.test(text)) return "No extractable text";
  const past = /^Warning: the (?:file|notebook|PDF) exists but is shorter than the provided offset \((\d+)\)\. The (?:file|rendered notebook|extracted PDF text) has (\d+) lines?\.?$/u.exec(text);
  if (past !== null) {
    return `No lines at offset ${past[1]}. File has ${past[2]} ${past[2] === "1" ? "line" : "lines"}.`;
  }
  return undefined;
}

/** User-facing line for a read that returned no lines, when the result says why. */
export function emptyReadNotice(result: string): string | undefined {
  // The whole result is the warning; a file whose text merely contains the
  // tag is not one.
  const match = /^\s*<system-reminder>([^<]{0,400})<\/system-reminder>\s*$/u.exec(result);
  return match === null ? undefined : fileReadWarningText(match[1]!);
}

/**
 * The only `<system-reminder>` blocks a tool result carries from AgenC are
 * the file-read warnings, and the runtime returns each as the WHOLE result.
 * Such a result becomes its plain line. Anything else is the tool's real
 * output (a shell command or a file may print the tag) and is shown exactly
 * as produced.
 */
export function stripSystemReminders(text: string): string {
  return emptyReadNotice(text) ?? text;
}

const ATTACHMENT_RECEIPT = /\[Shown to the user: ([a-z]+) "([^"\]\r\n]{0,500})"\]/gu;

/** `[Shown to the user: file "report"]` is the model's receipt; the user reads `Attached file "report"`. */
export function attachmentCaption(text: string): string {
  return text.replace(ATTACHMENT_RECEIPT, (_match, kind: string, title: string) =>
    kind === "chart" || kind === "table" || kind === "image"
      ? `${kind[0]!.toUpperCase()}${kind.slice(1)}: ${title}`
      : `Attached ${kind} "${title}"`);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Tool discovery (system.searchTools): schemas, `useHint` and `hint` are for the model. */
function toolDiscoveryReceipt(record: Record<string, unknown>): string | undefined {
  if (!Array.isArray(record.results)) return undefined;
  const isDiscovery = Array.isArray(record.loaded) || typeof record.hint === "string" ||
    typeof record.totalCatalogSize === "number" ||
    record.results.some((item) => typeof (item as { useHint?: unknown } | null)?.useHint === "string");
  if (!isDiscovery) return undefined;
  const loaded = Array.isArray(record.loaded)
    ? record.loaded.filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  if (loaded.length > 0) {
    return loaded.length <= 3 ? `Loaded ${loaded.join(", ")}` : `Loaded ${loaded.length} tools`;
  }
  return `Found ${plural(record.results.length, "tool", "tools")}`;
}

function commandOf(entry: unknown): string | undefined {
  const command = (entry as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return undefined;
  const line = command.replace(/\s+/gu, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/** list_processes / kill_process: session handles and "do not signal them again" notes. */
function processReceipt(record: Record<string, unknown>): string | undefined {
  // list_processes: { sessions, live_count, note }
  if (Array.isArray(record.sessions) && typeof record.live_count === "number") {
    if (record.sessions.length === 0) return "No commands running";
    const lines = record.sessions.map((entry) => {
      const status = (entry as { status?: unknown } | null)?.status;
      return `${commandOf(entry) ?? "command"}: ${typeof status === "string" ? status : "running"}`;
    });
    return lines.length <= 8 ? lines.join("\n") : `${plural(lines.length, "command", "commands")} listed`;
  }
  // kill_process: { ...result, owned_live_sessions, owned_live_sessions_note, stopping_sessions... }
  const isKill = "owned_live_sessions" in record || "terminated" in record ||
    (Array.isArray(record.results) && record.results.length > 0 && record.results.every((item) =>
      typeof item === "object" && item !== null && "terminated" in item)) ||
    (typeof record.note === "string" && record.note.startsWith("no live background session"));
  if (!isKill) return undefined;
  const stopped = Array.isArray(record.results)
    ? record.results.length
    : record.terminated === true ? 1 : 0;
  const remaining = Array.isArray(record.owned_live_sessions) ? record.owned_live_sessions.length : 0;
  const head = stopped === 0
    ? (typeof record.note === "string" && record.note.startsWith("no live background session")
      ? "No background command to stop"
      : "Stop requested")
    : `Stop requested for ${plural(stopped, "command", "commands")}`;
  return remaining > 0 ? `${head}. ${plural(remaining, "command", "commands")} still running.` : `${head}.`;
}

/** web_fetch on a route without the DeepSeek fetch metadata returns `{url, ok, content}`. */
function fetchReceipt(record: Record<string, unknown>): string | undefined {
  if (typeof record.url !== "string" || !("content" in record || "ok" in record)) return undefined;
  const title = typeof record.title === "string" && record.title.trim().length > 0
    ? record.title.trim()
    : record.url;
  return record.ok === false ? `Could not fetch ${title}` : `Fetched ${title}`;
}

/** MCP resource list/read results. */
function resourceReceipt(record: Record<string, unknown>): string | undefined {
  if (Array.isArray(record.resources)) {
    return `Found ${plural(record.resources.length, "resource", "resources")}`;
  }
  if (typeof record.resource === "object" && record.resource !== null) {
    const uri = (record.resource as { uri?: unknown }).uri;
    return typeof uri === "string" ? `Read resource ${uri}` : "Read resource";
  }
  return undefined;
}

const CODE_MODE_FOOTER = /^\[code_mode status=([a-z_]+)(?: wall_time=([0-9.]+)s)?[^\]\n]*\]$/mu;

/** Code-mode results: `Script running with cell ID ...` and the `[code_mode ...]` footer. */
function codeModeText(text: string): string | undefined {
  const footer = CODE_MODE_FOOTER.exec(text);
  const running = /^Script running with cell ID \S+/mu.test(text);
  if (footer === null && !running) return undefined;
  const status = footer?.[1];
  const seconds = footer?.[2];
  const line = running || status === "yielded" || status === "running"
    ? "Script running."
    : status === "completed" || status === "ok" || status === "success"
      ? `Script finished${seconds !== undefined ? ` in ${seconds}s` : ""}.`
      : status !== undefined
        ? `Script ${status.replaceAll("_", " ")}${seconds !== undefined ? ` after ${seconds}s` : ""}.`
        : "Script running.";
  const body = text
    .replace(/^\[code_mode [^\]\n]*\]$/gmu, "")
    .replace(/^Script running with cell ID \S+.*$/gmu, "")
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gu, "[image]")
    .trim();
  return body.length > 0 ? `${body}\n${line}` : line;
}

/**
 * Legacy Agent tool results carry an id marked "internal ID - do not mention
 * to user" followed by next-step instructions for the model.
 */
function legacyAgentText(text: string): string | undefined {
  const lines = text.split("\n");
  const idLine = lines.findIndex((line) => /\(internal ID - do not mention to user/u.test(line));
  if (idLine < 0) return undefined;
  // What precedes the id line is the receipt; the id and what follows it
  // are for the model.
  const body = lines.slice(0, idLine).join("\n").trim();
  return body.length > 0 ? body : "Agent started";
}

/** Legacy WebSearch text ends with a citation instruction for the model. */
function withoutSearchReminder(text: string): string {
  return text.replace(/\n*REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks\.?\s*$/u, "").trimEnd();
}

const TODO_BOILERPLATE = /^Todos have been modified successfully\./u;

const CODE_MODE_TOOLS = /^(?:exec|wait|code_mode|code-mode)$/u;
const DISCOVERY_TOOLS = /^(?:system\.searchTools|system_searchTools)$/u;
const PROCESS_TOOLS = /^(?:list_processes|kill_process)$/u;
const RESOURCE_TOOLS = /^(?:ListMcpResourcesTool|ReadMcpResourceTool)$/u;
const AGENT_TOOLS = /^(?:Agent|Task|AgentTool)$/u;
const SEARCH_TOOLS = /^(?:WebSearch|web_search)$/u;

/** A tool served by an external MCP server: its output is its own and is never rewritten. */
function isExternalTool(toolName: string | undefined): boolean {
  return toolName !== undefined && /^mcp(?:\.|__)/u.test(toolName);
}

/**
 * User-facing form of a tool RESULT text that a fallback or generic path is
 * about to print.
 *
 * With a known `toolName` only that tool's rules apply. Without one (a
 * result that lost its call) only texts the runtime writes word for word
 * are recognized, each anchored at the start of the result, so file, shell
 * or external output that merely contains similar text is left alone; the
 * JSON receipts are never guessed for an unknown tool.
 */
export function userFacingResultText(text: string, toolName?: string): string {
  if (text.length === 0 || isExternalTool(toolName)) return text;
  const byTool = toolName === undefined
    ? undefined
    : userFacingToolResultText({ toolName, result: text });
  if (byTool !== undefined) return byTool;

  const unknown = toolName === undefined;
  const lead = text.trimStart();
  if (unknown) {
    const question = askUserQuestionDisplayFromModelText(lead);
    if (question !== null) return formatAskUserQuestionDisplay(question);
    const plan = exitPlanModeReceipt(lead);
    if (plan !== undefined) return plan;
    if (/^Entered plan mode\.\s+In plan mode, you should:/u.test(lead)) return ENTERED_PLAN_MODE_TEXT;
    if (/^Already in plan mode\.\s+In plan mode, you should:/u.test(lead)) return PLAN_MODE_ALREADY_ACTIVE_TEXT;
    if (lead.startsWith("<command-name>")) {
      const skill = skillLoadReceipt(lead);
      if (skill !== undefined) return skill;
    }
  }
  if ((unknown || toolName === "TodoWrite") && TODO_BOILERPLATE.test(lead)) return "Todo list updated";
  if (unknown || AGENT_TOOLS.test(toolName)) {
    const agent = legacyAgentText(text);
    if (agent !== undefined) return agent;
  }
  if (!unknown && CODE_MODE_TOOLS.test(toolName)) {
    const code = codeModeText(text);
    if (code !== undefined) return code;
  }
  if (!unknown) {
    const record = parseJsonObject(text);
    if (record !== undefined) {
      const receipt =
        (DISCOVERY_TOOLS.test(toolName) ? toolDiscoveryReceipt(record) : undefined) ??
        (PROCESS_TOOLS.test(toolName) ? processReceipt(record) : undefined) ??
        (toolName === "web_fetch" ? fetchReceipt(record) : undefined) ??
        (RESOURCE_TOOLS.test(toolName) ? resourceReceipt(record) : undefined);
      if (receipt !== undefined) return receipt;
    }
  }
  const cleaned = stripSystemReminders(text);
  return attachmentCaption(unknown || SEARCH_TOOLS.test(toolName) ? withoutSearchReminder(cleaned) : cleaned);
}

/** A non-text result block is named, never printed as JSON (it can hold base64 media). */
export function nonTextBlockReceipt(block: unknown): string {
  const type = typeof block === "object" && block !== null
    ? (block as { type?: unknown }).type
    : undefined;
  if (type === "image" || type === "image_url") return "Image received.";
  if (type === "document" || type === "file" || type === "resource" || type === "resource_link") {
    return "File received.";
  }
  if (type === "audio") return "Audio received.";
  return "Content received.";
}

/** Text of a tool_result `content` value for a fallback row. */
export function userFacingResultContent(content: unknown, toolName?: string): string | null {
  if (content === undefined || content === null) return null;
  if (typeof content === "string") return userFacingResultText(content, toolName);
  if (Array.isArray(content)) {
    const text: string[] = [];
    const receipts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") text.push(block);
      else if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        text.push(block.text);
      } else {
        receipts.push(nonTextBlockReceipt(block));
      }
    }
    const shown = text.length > 0 ? userFacingResultText(text.join("\n"), toolName) : "";
    return [shown, ...receipts].filter((part) => part.length > 0).join("\n");
  }
  return userFacingResultText(String(content), toolName);
}

const EXEC_NOTE_RULES: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/^\[note: this command left processes running after it exited\./u,
    () => "Stopped processes the command left running."],
  [/^\[note: timeoutMs=\d+ passed and the command is still running;/u,
    () => "The time limit passed. The command is still running in the background."],
  [/^\[note: timeoutMs passed while (\d+) background sessions/u,
    (match) => `The time limit passed with ${match[1]} background commands already running, so this command was stopped.`],
  [/^\[note: session \d+ runs in the background\./u,
    () => "Command is running in the background."],
  [/^\[session \d+ ended after ([^:]+): ([^(]+?)(?:, likely out of memory[^(]*)? \(`([^`]*)`\)\./u,
    (match) => `Background command finished after ${match[1]} (${match[2]!.trim()}): ${match[3]}`],
];

/**
 * The notes under a shell result tell the model how to poll or stop a
 * session ("write_stdin polls its output, kill_process stops it."). The
 * expanded view shows what happened instead; an unrecognized note is kept.
 */
export function userFacingExecNotes(notes: string): string {
  if (notes.length === 0) return notes;
  return notes.split("\n").map((line) => {
    const trimmed = line.trim();
    for (const [pattern, format] of EXEC_NOTE_RULES) {
      const match = pattern.exec(trimmed);
      if (match !== null) return format(match);
    }
    return line;
  }).join("\n");
}

const ERROR_RULES: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/^Permission to use (\S+) has been denied because AgenC is running in don't ask mode\./u,
    () => "Not allowed in don't ask mode."],
  [/^Permission to use (\S+) has been denied\./u, () => "Action was not allowed."],
  [/^Permission for this tool use was denied\.[\s\S]*?The user said:\n([\s\S]*)$/u,
    (match) => `Permission denied: ${match[1]!.trim()}`],
  [/^Permission for this tool use was denied\./u, () => "Permission denied."],
  [/^The user doesn't want to proceed with this tool use\.[\s\S]*?the user said:\n([\s\S]*)$/u,
    (match) => `Declined: ${match[1]!.trim()}`],
  [/^The user doesn't want to proceed with this tool use\./u, () => "Declined."],
  [/^The user doesn't want to take this action right now\./u, () => "Cancelled."],
  [/^\[Request interrupted by user(?: for tool use)?\]/u, () => "Interrupted."],
  [/^Not permitted: (\S+) cannot run in this session because no approval resolver is available/u,
    () => "Not permitted in this session."],
];

/**
 * Sentences the runtime's own refusals use to tell the model what to do
 * next. Each alternative is the start of one such sentence; the sentence is
 * dropped through its final period. Kept narrow on purpose: a tool's own
 * error text is never rewritten by a broad pattern.
 */
const MODEL_DIRECTED_SENTENCE = new RegExp(
  "(?:^|(?<=[.!?:;]\\s))(?:" + [
    "Do not retry (?:the same call|this call|unchanged)",
    "Do not run this command again unchanged",
    "Do not write \\.git files directly",
    "STOP and explain to the user",
    "STOP what you are doing",
    "Let the user decide how to proceed",
    "Try a different approach or report the limitation",
    "Confirm with the user, then re-invoke",
    "Read it again before attempting to write it",
    "IMPORTANT: You \\*may\\* attempt",
    "But you \\*should not\\* attempt",
    "You should only try to work around",
    "If you believe this capability is essential",
    "If the user asked for this git operation, retry it once",
    "Explain that you will start the preview",
    "Retry this command once with sandbox_permissions",
    "Retry a complete (?:tool|JSON) call",
    "A persistent server can use detach=true",
    "Check an escalated server's URL",
    "(?:Escalation is unavailable(?: in this session)?; )?ask the user to run",
  ].join("|") + ")[^.!?]*(?:\\.(?=\\S)[^.!?]*)*(?:[.!?]+|$)\\s*",
  "gu",
);

const ERROR_LINE_RULES: readonly [RegExp, string][] = [
  [/^File has been modified since read, either by the user or by a linter\./u, "File changed since it was read."],
  [/^\[sandbox\] Git could not write protected \.git metadata\./u, "Sandbox blocked a git write to protected .git metadata."],
  [/^\[sandbox\] The sandbox blocks local servers\./u, "Sandbox blocked starting a local server."],
];

/**
 * User-facing form of a tool ERROR text. Known refusal sentinels become a
 * short line; otherwise the factual part is kept and the sentences that
 * instruct the model ("Do not retry...", "STOP and explain to the user...")
 * are dropped. Returns the input when nothing in it addresses the model.
 */
export function userFacingErrorText(text: string): string {
  const trimmed = text.trim();
  for (const [pattern, format] of ERROR_RULES) {
    const match = pattern.exec(trimmed);
    if (match !== null) return format(match);
  }
  for (const [pattern, shown] of ERROR_LINE_RULES) {
    if (pattern.test(trimmed)) return shown;
  }
  const worktree = /^(Worktree has [^.]+)\. Removing will discard this work permanently\./u.exec(trimmed);
  if (worktree !== null) return `${worktree[1]}. Removing it would discard this work.`;
  const cleaned = stripSystemReminders(trimmed)
    .replace(MODEL_DIRECTED_SENTENCE, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : trimmed.length > 0 ? "failed" : trimmed;
}

/** Correlation ids inside a runtime notice: `streamed tool Write (call_abc123) reached ...`. */
export function withoutCallIds(text: string): string {
  return text.replace(/(streamed tool \S+) \((?:call|toolu)_[A-Za-z0-9_-]{4,}\)/gu, "$1");
}
