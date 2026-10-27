/**
 * Runtime-local compaction summarizer for the `emergency_local` ladder tier
 * (#2497). It produces a valid `CompactionSummaryBodyV1` from the same
 * structured inputs the model summarizer receives, without any provider
 * call, so the durable compaction transaction runs unchanged.
 *
 * The output is deliberately plain: a header that says what happened, the
 * earlier context, latest assistant state and bounded tool-result excerpts.
 * Evidence is quoted, not paraphrased; a model-free tier must not invent.
 */

import type { LLMMessage } from "../../llm/types.js";
import { isRecord } from "../../utils/record.js";
import type { CompactionStage } from "./transaction-types.js";
import { conservativeOutputTokenEstimate } from "./transaction-limits.js";

export interface CompactionLocalSummarizerInput {
  readonly stage: CompactionStage;
  readonly messages: readonly LLMMessage[];
  readonly allowedSourceRefIds: readonly string[];
  /** Output reserve the transaction planned for this call. */
  readonly maxOutputTokens: number;
}

/** Returns the JSON text of a `CompactionSummaryBodyV1`. */
export type CompactionLocalSummarizer = (input: CompactionLocalSummarizerInput) => string;

const MAX_NARRATIVE_BYTES = 8 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024;
const MAX_LATEST_TEXT_BYTES = 1024;
const MAX_TOOL_CALLS_BYTES = 1024;
const MAX_TOOL_ARGUMENT_BYTES = 200;
const MAX_LATEST_TOOL_CALLS = 8;
const MAX_EVIDENCE_RECORDS = 12;
const MAX_EVIDENCE_BYTES = 768;
const MAX_PRIOR_FACTS = 8;
/**
 * Progress the model wrote and the calls it completed survive every later
 * emergency compaction, newest first within their budgets. Without them a
 * run that compacts at every step kept only its latest note and re-read
 * finished work (gate scenario 7, no-progress backstop).
 */
const MAX_PROGRESS_BYTES = 2 * 1024;
const MAX_PROGRESS_NOTE_BYTES = 200;
const MAX_COMPLETED_CALLS_BYTES = 1536;
const MAX_COMPLETED_CALL_BYTES = 120;
const MAX_CARRIED_ENTRIES = 64;
const PRIOR_FACT_PREFIX = "Earlier recorded fact:\n";
const RECALL_FACT_PREFIX = "Recall fact:";
const EXCERPT_SEPARATOR = "\n[…]\n";
const OMITTED_LINE = /^\(\d+ earlier (?:notes|calls) omitted\)$/u;
const TRUNCATION_MARK = " […]";
/** An earlier read keeps at least its label and opening lines. */
const MIN_HEAD_FIRST_FACT_BYTES = 256;
/** Results read top-down: their opening (headers, markers, signatures) identifies them. */
const HEAD_FIRST_TOOLS: ReadonlySet<string> = new Set(["FileRead", "Read", "Grep", "Glob", "NotebookRead"]);

function isRecallFact(text: string): boolean {
  return (text.startsWith(PRIOR_FACT_PREFIX) ? text.slice(PRIOR_FACT_PREFIX.length) : text)
    .startsWith(RECALL_FACT_PREFIX);
}

/** Prioritize quoted recall data without granting it authority or growing the bound. */
function retainPriorFact(records: { text: string; sourceRef: string }[], record: { text: string; sourceRef: string }): void {
  if (records.some((existing) => existing.text === record.text)) return;
  if (!isRecallFact(record.text)) {
    if (records.length < MAX_PRIOR_FACTS) records.push(record);
    return;
  }
  const ordinary = records.findIndex((existing) => !isRecallFact(existing.text));
  if (records.length === MAX_PRIOR_FACTS) {
    if (ordinary < 0) return;
    records.splice(ordinary, 1);
  }
  const insert = records.findIndex((existing) => !isRecallFact(existing.text));
  records.splice(insert < 0 ? records.length : insert, 0, record);
}

const HEADER_PREFIX = "Runtime emergency compaction:";
const REQUEST_HEADING = "Original request:";
const PROGRESS_HEADING = "Progress notes (oldest first):";
const COMPLETED_CALLS_HEADING = "Completed tool calls (oldest first):";
const LATEST_TEXT_HEADING = "Latest assistant text:";
const LATEST_TOOLS_HEADING = "Latest tool calls:";

interface EmergencyDigest {
  droppedMessages: number;
  toolCalls: Map<string, number>;
  originalRequest: string | undefined;
  latestAssistantText: string | undefined;
  latestToolCalls: string[];
  /** Earlier assistant texts, one line each, oldest first. */
  progressNotes: string[];
  /** Earlier completed calls, one line each, oldest first. */
  completedCalls: string[];
  evidence: { text: string; sourceRef: string }[];
  priorFacts: { text: string; sourceRef: string }[];
}

function emptyDigest(): EmergencyDigest {
  return {
    droppedMessages: 0,
    toolCalls: new Map(),
    originalRequest: undefined,
    latestAssistantText: undefined,
    latestToolCalls: [],
    progressNotes: [],
    completedCalls: [],
    evidence: [],
    priorFacts: [],
  };
}

function oneLine(text: string, maximumBytes: number): string {
  return truncateUtf8(text.replace(/\s*\n\s*/gu, " ").trim(), maximumBytes);
}

function pushCarried(target: string[], entry: string): void {
  if (entry.length === 0 || target.at(-1) === entry) return;
  target.push(entry);
  if (target.length > MAX_CARRIED_ENTRIES) target.splice(0, target.length - MAX_CARRIED_ENTRIES);
}

/**
 * Sections of an earlier emergency narrative this one carries forward: its
 * original request, its progress and completed calls, and its latest note
 * and calls, which are earlier progress from here on.
 */
function carryNarrative(digest: EmergencyDigest, narrative: string): void {
  const request = section(narrative, REQUEST_HEADING);
  if (digest.originalRequest === undefined && request !== undefined && request.length > 0) {
    digest.originalRequest = request;
  }
  for (const line of section(narrative, PROGRESS_HEADING)?.split("\n") ?? []) {
    if (!OMITTED_LINE.test(line)) pushCarried(digest.progressNotes, line);
  }
  const latest = section(narrative, LATEST_TEXT_HEADING);
  if (latest !== undefined) pushCarried(digest.progressNotes, oneLine(latest, MAX_PROGRESS_NOTE_BYTES));
  for (const line of section(narrative, COMPLETED_CALLS_HEADING)?.split("\n") ?? []) {
    if (!OMITTED_LINE.test(line)) pushCarried(digest.completedCalls, line);
  }
  for (const line of section(narrative, LATEST_TOOLS_HEADING)?.split("\n") ?? []) {
    pushCarried(digest.completedCalls, compactCallLine(line));
  }
}

/** `Tool({"file_path":"a"})` from a latest-calls section as the shorter completed-call line. */
function compactCallLine(line: string): string {
  const match = /^([^(\s]+)\((.*)\)$/su.exec(line);
  return match === null ? truncateUtf8(line, MAX_COMPLETED_CALL_BYTES) : callLine(match[1]!, match[2]!);
}

interface StructuredMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: ReadonlyArray<{ readonly id?: unknown; readonly name?: unknown; readonly arguments?: unknown }>;
  readonly tool_call_id?: unknown;
  readonly tool_name?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

/** Truncate to a UTF-8 byte budget on a code-point boundary, marking the cut. */
export function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const marker = " […]";
  const budget = Math.max(0, maximumBytes - Buffer.byteLength(marker, "utf8"));
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    end += codePoint.length;
  }
  return `${value.slice(0, end)}${marker}`;
}

function tailUtf8(value: string, maximumBytes: number): string {
  // At most maximumBytes UTF-16 units can contribute to this byte suffix;
  // avoid copying the full (potentially very large) tool result.
  const bytes = Buffer.from(value.slice(-maximumBytes), "utf8");
  let start = Math.max(0, bytes.length - maximumBytes);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/**
 * Opening of `value` within `maximumBytes`, ending on a line break when one
 * lies in the last three quarters: a value cut mid-line (a hash missing its
 * last digit) reads as complete and is worse than a line left out.
 */
function headLines(value: string, maximumBytes: number): string {
  const cut = truncateUtf8(value, maximumBytes);
  if (cut === value) return value;
  const kept = cut.slice(0, -TRUNCATION_MARK.length);
  const lineEnd = kept.lastIndexOf("\n");
  return lineEnd >= kept.length / 4 ? kept.slice(0, lineEnd) : cut;
}

/** Closing of `value` within `maximumBytes`, starting on a line when one starts in its first three quarters. */
function tailLines(value: string, maximumBytes: number): string {
  const tail = tailUtf8(value, maximumBytes);
  if (tail.length === value.length) return tail;
  const lineStart = tail.indexOf("\n");
  return lineStart >= 0 && lineStart <= (tail.length * 3) / 4 ? tail.slice(lineStart + 1) : tail;
}

function evidenceExcerpt(value: string, maximumBytes: number, headFirst = false): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  if (headFirst) {
    const headBytes = Math.floor(maximumBytes * 0.75);
    return `${headLines(value, headBytes)}${EXCERPT_SEPARATOR}${tailLines(value, maximumBytes - headBytes - 16)}`;
  }
  const headBytes = Math.min(128, Math.floor(maximumBytes / 4));
  return `${truncateUtf8(value, headBytes)}${EXCERPT_SEPARATOR}${tailUtf8(value, maximumBytes - headBytes - 16)}`;
}

function recordedToolName(text: string): string | undefined {
  const body = text.startsWith(PRIOR_FACT_PREFIX) ? text.slice(PRIOR_FACT_PREFIX.length) : text;
  return /^Recorded ([^\s(]+)/u.exec(body)?.[1];
}

/**
 * Shrink an already excerpted earlier fact without losing what identified
 * it: the label and opening of a read stay ahead of its tail, while command
 * output keeps its computed tail as before.
 */
function priorFactExcerpt(text: string, maximumBytes: number): string {
  const toolName = recordedToolName(text);
  const headFirst = toolName !== undefined && HEAD_FIRST_TOOLS.has(toolName);
  const budget = headFirst ? Math.max(MIN_HEAD_FIRST_FACT_BYTES, maximumBytes) : maximumBytes;
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  if (!headFirst) return evidenceExcerpt(text, budget);
  const separatorAt = text.indexOf(EXCERPT_SEPARATOR);
  if (separatorAt < 0) return headLines(text, budget);
  const available = Math.max(0, budget - Buffer.byteLength(EXCERPT_SEPARATOR, "utf8"));
  // A tail shorter than a line or two is noise; spend those bytes on the head.
  const tailBytes = available >= 512 ? Math.floor(available / 8) : 0;
  const tail = tailBytes > 0 ? tailLines(text.slice(separatorAt + EXCERPT_SEPARATOR.length), tailBytes) : "";
  return `${headLines(text.slice(0, separatorAt), available - tailBytes)}${tail.length > 0 ? EXCERPT_SEPARATOR + tail : TRUNCATION_MARK}`;
}

/** A completed call as one line: a path-bearing call reads as `Tool path`. */
function callLine(name: string, args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    if (isRecord(parsed)) {
      const target = [parsed.file_path, parsed.path, parsed.pattern].find((value) => typeof value === "string");
      if (typeof target === "string") {
        const rest = Object.entries(parsed)
          .filter(([key]) => !["file_path", "path", "pattern"].includes(key))
          .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
        return truncateUtf8(`${name} ${target}${rest.length > 0 ? ` (${rest.join(", ")})` : ""}`, MAX_COMPLETED_CALL_BYTES);
      }
    }
  } catch { /* Non-JSON arguments are shown as sent. */ }
  return truncateUtf8(args.length > 0 ? `${name}(${args})` : name, MAX_COMPLETED_CALL_BYTES);
}

function parseInput(message: LLMMessage | undefined): unknown {
  const raw = message === undefined ? "" : textOf(message.content);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** An earlier compaction context in the dropped span, parsed. */
function priorCompactionContext(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const prior: unknown = JSON.parse(text);
    return isRecord(prior) && prior.kind === "agenc_compaction_context_v2" ? prior : undefined;
  } catch {
    return undefined; // Ordinary user prose is not a prior summary.
  }
}

function digestTranscript(payload: unknown, sourceRef: string | undefined): EmergencyDigest {
  const digest = emptyDigest();
  const units = (payload as { units?: unknown } | undefined)?.units;
  if (!Array.isArray(units)) return digest;
  const callLines = new Map<string, string>();
  for (const unit of units) {
    const messages = (unit as { messages?: unknown } | undefined)?.messages;
    if (!Array.isArray(messages)) continue;
    for (const entry of messages as StructuredMessage[]) {
      digest.droppedMessages += 1;
      const role = typeof entry.role === "string" ? entry.role : "user";
      const text = textOf(entry.content).trim();
      const prior = role === "user" ? priorCompactionContext(text) : undefined;
      if (prior !== undefined) {
        // A previous summary is history, not the request: carry its record.
        if (typeof prior.narrative === "string") carryNarrative(digest, prior.narrative);
        if (sourceRef !== undefined && Array.isArray(prior.facts)) {
          for (const fact of prior.facts) {
            if (typeof fact === "string") retainPriorFact(digest.priorFacts, {
              text: priorFactExcerpt(fact.startsWith(PRIOR_FACT_PREFIX) ? fact : PRIOR_FACT_PREFIX + fact, MAX_EVIDENCE_BYTES),
              sourceRef,
            });
          }
        }
        continue;
      }
      if (role === "user" && digest.originalRequest === undefined && text.length > 0) {
        digest.originalRequest = text;
      }
      if (sourceRef !== undefined && role === "tool" && text.length > 0) {
        const name = typeof entry.tool_name === "string" ? entry.tool_name : "tool";
        const label = (typeof entry.tool_call_id === "string" ? callLines.get(entry.tool_call_id) : undefined) ?? name;
        // Command results commonly put computed values and exit status at
        // the end; reads identify themselves at the start. Keep both ends.
        const excerpt = evidenceExcerpt(text, MAX_EVIDENCE_BYTES, HEAD_FIRST_TOOLS.has(name));
        digest.evidence.push({ text: `Recorded ${label} output (excerpt):\n${excerpt}`, sourceRef });
        digest.evidence = digest.evidence.slice(-MAX_EVIDENCE_RECORDS);
      }
      if (role === "assistant") {
        if (text.length > 0) {
          if (digest.latestAssistantText !== undefined) {
            pushCarried(digest.progressNotes, oneLine(digest.latestAssistantText, MAX_PROGRESS_NOTE_BYTES));
          }
          digest.latestAssistantText = text;
        }
        if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
          for (const line of digest.latestToolCalls) pushCarried(digest.completedCalls, compactCallLine(line));
          digest.latestToolCalls = [];
          for (const call of entry.tool_calls) {
            const name = typeof call.name === "string" ? call.name : "tool";
            digest.toolCalls.set(name, (digest.toolCalls.get(name) ?? 0) + 1);
            const args = argumentsText(call.arguments);
            if (typeof call.id === "string") callLines.set(call.id, callLine(name, args));
            digest.latestToolCalls.push(
              args.length > 0 ? `${name}(${truncateUtf8(args, MAX_TOOL_ARGUMENT_BYTES)})` : name,
            );
          }
        }
      }
    }
  }
  return digest;
}

/**
 * The transcript embeds arguments that parse as JSON values, with sorted
 * object keys, and others as the sent string. An object's shorter entries
 * come first, so one long value (a Write's content, a MultiEdit's edits)
 * cannot push the target path past MAX_TOOL_ARGUMENT_BYTES.
 */
function argumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (!isRecord(value)) return JSON.stringify(value);
  const entries = Object.entries(value).map(([key, entry]) => {
    const text = `${JSON.stringify(key)}:${JSON.stringify(entry)}`;
    return { text, bytes: Buffer.byteLength(text, "utf8") };
  });
  // Array sort is stable, so entries of equal size keep their order.
  entries.sort((left, right) => left.bytes - right.bytes);
  return `{${entries.map((entry) => entry.text).join(",")}}`;
}

function section(narrative: string, heading: string): string | undefined {
  const start = narrative.indexOf(`\n${heading}\n`);
  if (start < 0) return undefined;
  const bodyStart = start + heading.length + 2;
  const next = narrative.indexOf("\n\n", bodyStart);
  return narrative.slice(bodyStart, next < 0 ? undefined : next).trim();
}

function parseHeader(narrative: string): { messages: number; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const messages = Number(/(\d+) messages/u.exec(narrative)?.[1] ?? 0);
  const list = /\((.*?)\) were dropped/u.exec(narrative)?.[1] ?? "";
  for (const item of list.split(",").map((value) => value.trim()).filter(Boolean)) {
    const match = /^(.+)×(\d+)$/u.exec(item);
    if (match) calls.set(match[1]!, Number(match[2]));
  }
  return { messages: Number.isFinite(messages) ? messages : 0, calls };
}

/** Merge child summaries: earliest request, latest state, summed counts. */
function digestSummaries(payload: unknown): EmergencyDigest {
  const digest = emptyDigest();
  const summaries = (payload as { summaries?: unknown } | undefined)?.summaries;
  if (!Array.isArray(summaries)) return digest;
  for (const child of summaries) {
    const narrative = (child as { narrative?: unknown } | undefined)?.narrative;
    if (typeof narrative !== "string") continue;
    const header = parseHeader(narrative);
    digest.droppedMessages += header.messages;
    for (const [name, count] of header.calls) {
      digest.toolCalls.set(name, (digest.toolCalls.get(name) ?? 0) + count);
    }
    const request = section(narrative, REQUEST_HEADING);
    if (digest.originalRequest === undefined && request !== undefined) digest.originalRequest = request;
    // An earlier child's latest state becomes progress of the merged summary
    // when a later child has newer state.
    const latest = section(narrative, LATEST_TEXT_HEADING);
    if (latest !== undefined && digest.latestAssistantText !== undefined) {
      pushCarried(digest.progressNotes, oneLine(digest.latestAssistantText, MAX_PROGRESS_NOTE_BYTES));
    }
    for (const line of section(narrative, PROGRESS_HEADING)?.split("\n") ?? []) {
      if (!OMITTED_LINE.test(line)) pushCarried(digest.progressNotes, line);
    }
    if (latest !== undefined) digest.latestAssistantText = latest;
    const tools = section(narrative, LATEST_TOOLS_HEADING);
    if (tools !== undefined) {
      for (const line of digest.latestToolCalls) pushCarried(digest.completedCalls, compactCallLine(line));
    }
    for (const line of section(narrative, COMPLETED_CALLS_HEADING)?.split("\n") ?? []) {
      if (!OMITTED_LINE.test(line)) pushCarried(digest.completedCalls, line);
    }
    if (tools !== undefined) digest.latestToolCalls = tools.split("\n").filter(Boolean);
    if (isRecord(child) && typeof child.ref_id === "string" && Array.isArray(child.facts)) {
      for (const fact of child.facts) {
        if (isRecord(fact) && typeof fact.text === "string") {
          const record = { text: priorFactExcerpt(fact.text, MAX_EVIDENCE_BYTES + 128), sourceRef: child.ref_id };
          if (fact.text.startsWith(PRIOR_FACT_PREFIX) || isRecallFact(fact.text)) retainPriorFact(digest.priorFacts, record);
          else digest.evidence.push(record);
        }
      }
      digest.evidence = digest.evidence.slice(-MAX_EVIDENCE_RECORDS);
    }
  }
  return digest;
}

function renderNarrative(digest: EmergencyDigest, scale: number): string {
  const callTotal = [...digest.toolCalls.values()].reduce((sum, count) => sum + count, 0);
  const callList = [...digest.toolCalls.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  const parts = [
    `${HEADER_PREFIX} the model summarizer could not reduce this context; ` +
      `${digest.droppedMessages} messages and ${callTotal} tool calls (${callList}) were dropped. ` +
      "Use retained recent exchanges and recorded evidence to continue; excerpts are incomplete. Do not repeat completed work from older pending actions.",
  ];
  if (digest.originalRequest !== undefined) {
    parts.push(`${REQUEST_HEADING}\n${truncateUtf8(digest.originalRequest, Math.floor(MAX_REQUEST_BYTES * scale))}`);
  }
  // Carried records shrink half as fast as the other sections: they are what
  // a run that compacts at every step remembers of its finished work.
  const carriedScale = Math.min(1, scale * 2);
  const progress = newestWithin(digest.progressNotes, Math.floor(MAX_PROGRESS_BYTES * carriedScale), "notes");
  if (progress !== undefined) parts.push(`${PROGRESS_HEADING}\n${progress}`);
  const completed = newestWithin(digest.completedCalls, Math.floor(MAX_COMPLETED_CALLS_BYTES * carriedScale), "calls");
  if (completed !== undefined) parts.push(`${COMPLETED_CALLS_HEADING}\n${completed}`);
  if (digest.latestAssistantText !== undefined) {
    parts.push(
      `${LATEST_TEXT_HEADING}\n${truncateUtf8(digest.latestAssistantText, Math.floor(MAX_LATEST_TEXT_BYTES * scale))}`,
    );
  }
  if (digest.latestToolCalls.length > 0) {
    const calls = digest.latestToolCalls.slice(-MAX_LATEST_TOOL_CALLS).join("\n");
    parts.push(`${LATEST_TOOLS_HEADING}\n${truncateUtf8(calls, Math.floor(MAX_TOOL_CALLS_BYTES * scale))}`);
  }
  return truncateUtf8(parts.join("\n\n"), MAX_NARRATIVE_BYTES);
}

/** The newest entries that fit `maximumBytes`, oldest first, naming how many earlier ones were left out. */
function newestWithin(entries: readonly string[], maximumBytes: number, noun: string): string | undefined {
  if (entries.length === 0 || maximumBytes <= 0) return undefined;
  const kept: string[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(entries[index]!, "utf8") + 1;
    if (bytes + size > maximumBytes) break;
    kept.unshift(entries[index]!);
    bytes += size;
  }
  if (kept.length === 0) return undefined;
  const omitted = entries.length - kept.length;
  return omitted > 0 ? `(${omitted} earlier ${noun} omitted)\n${kept.join("\n")}` : kept.join("\n");
}

/** Build a summarizer that never calls a model and always fits its output reserve. */
export function createRuntimeEmergencySummarizer(maximumOutputTokens = 8_192): CompactionLocalSummarizer {
  return (input) => {
    const outputLimit = Math.min(input.maxOutputTokens, maximumOutputTokens);
    const payload = parseInput(input.messages[0]);
    // A single-call plan labels its only call `final` yet still sends the
    // transcript, so the payload kind, not the stage, decides the parser.
    const kind = (payload as { kind?: unknown } | undefined)?.kind;
    const digest = kind === "untrusted_compaction_summaries" ? digestSummaries(payload) : digestTranscript(payload, input.allowedSourceRefIds[0]);
    let narrative = "";
    for (const scale of maximumOutputTokens < 8_192 ? [0.25, 0.1, 0] : [1, 0.5, 0.25, 0.1, 0]) {
      narrative = renderNarrative(digest, scale);
      // Reduce the number of older excerpts before shortening each one: the
      // computed tail of an oversized result must survive, along with facts
      // already learned in earlier summaries.
      const records = scale === 0 ? [] : [...digest.priorFacts.map((record) => ({
        ...record, text: priorFactExcerpt(record.text, Math.max(192, Math.floor(MAX_EVIDENCE_BYTES * scale))),
      })),
        ...digest.evidence.slice(-Math.max(1, Math.ceil(digest.evidence.length * scale)))];
      const facts = records.map((record, index) => ({
        id: `e${index + 1}`,
        text: record.text,
        source_ref_ids: [record.sourceRef],
      }));
      const body = JSON.stringify({ narrative, facts, open_actions: [] });
      if (conservativeOutputTokenEstimate(body) <= outputLimit) return body;
    }
    // Even the bare header did not fit the reserve; shrink the first line
    // until it does. The body is never empty: a compaction with no
    // narrative would be rejected downstream.
    const header = narrative.split("\n")[0] ?? HEADER_PREFIX;
    for (let bytes = 256; bytes >= 16; bytes = Math.floor(bytes / 2)) {
      const body = JSON.stringify({ narrative: truncateUtf8(header, bytes), facts: [], open_actions: [] });
      if (conservativeOutputTokenEstimate(body) <= outputLimit) return body;
    }
    return JSON.stringify({ narrative: truncateUtf8(header, 16), facts: [], open_actions: [] });
  };
}
