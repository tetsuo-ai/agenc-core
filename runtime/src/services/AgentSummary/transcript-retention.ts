import type { LLMMessage } from "../../llm/types.js";
import type { Message } from "../../types/message.js";
import type { RunAgentProgressEvent } from "../../agents/run-agent.js";
import {
  llmMessageToAgentSummaryMessage,
  runAgentProgressEventToAgentSummaryMessage,
} from "./transcript.js";
import { WEB_FETCH_TOOL_NAME } from "../../tools/WebFetchTool/prompt.js";
import {
  frameUntrustedToolResultContent,
  type UntrustedToolResultKind,
} from "../../tools/untrusted-tool-result-framing.js";

export interface AgentSummaryTranscriptLimits {
  /** Maximum JSON-serialized UTF-8 bytes retained for rolling activity. */
  readonly maxBytes: number;
  /** Maximum retained rolling messages, including the omission marker. */
  readonly maxMessages: number;
  /** Maximum UTF-8 bytes retained for one final AgentSummary tool result. */
  readonly maxToolResultBytes: number;
}

export type AgentSummaryTranscriptLimitOverrides =
  Partial<AgentSummaryTranscriptLimits>;

export const DEFAULT_AGENT_SUMMARY_TRANSCRIPT_LIMITS = Object.freeze({
  maxBytes: 512 * 1024,
  maxMessages: 256,
  maxToolResultBytes: 64 * 1024,
}) satisfies AgentSummaryTranscriptLimits;

const MIN_TRANSCRIPT_BYTES = 512;
const MIN_TRANSCRIPT_MESSAGES = 3;
const MIN_TOOL_RESULT_BYTES = 128;
const EPOCH_TIMESTAMP = new Date(0).toISOString();
const TOOL_RESULT_SAFETY_FRAME_OMISSION =
  "[tool result omitted: safety frame exceeds configured UTF-8 limit]";
const CANONICAL_FRAME_BODY_SENTINEL =
  "agenc-canonical-frame-body-sentinel-7f4d6b17";
const UNTRUSTED_TOOL_RESULT_KINDS = [
  "external",
  "workspace",
] as const satisfies readonly UntrustedToolResultKind[];

type ToolResultProgressEvent = Extract<
  RunAgentProgressEvent,
  { readonly kind: "tool_result" }
>;

type BoundedRawToolResult = {
  readonly originalBytes: number;
  readonly prefix: string;
  readonly reference: string | null;
};

type ToolResultMessageFactory = (result: string) => Message;

type ToolMessageIds = {
  readonly uses: ReadonlySet<string>;
  readonly results: ReadonlySet<string>;
  readonly all: ReadonlySet<string>;
};

function resolvedLimit(
  name: keyof AgentSummaryTranscriptLimits,
  value: number,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `AgentSummary transcript ${name} must be a safe integer >= ${minimum}`,
    );
  }
  return value;
}

function resolveLimits(
  overrides: AgentSummaryTranscriptLimitOverrides,
): AgentSummaryTranscriptLimits {
  const maxBytes = resolvedLimit(
    "maxBytes",
    overrides.maxBytes ?? DEFAULT_AGENT_SUMMARY_TRANSCRIPT_LIMITS.maxBytes,
    MIN_TRANSCRIPT_BYTES,
  );
  const maxMessages = resolvedLimit(
    "maxMessages",
    overrides.maxMessages ??
      DEFAULT_AGENT_SUMMARY_TRANSCRIPT_LIMITS.maxMessages,
    MIN_TRANSCRIPT_MESSAGES,
  );
  const maxToolResultBytes = resolvedLimit(
    "maxToolResultBytes",
    overrides.maxToolResultBytes ??
      DEFAULT_AGENT_SUMMARY_TRANSCRIPT_LIMITS.maxToolResultBytes,
    MIN_TOOL_RESULT_BYTES,
  );
  if (maxToolResultBytes > maxBytes) {
    throw new RangeError(
      "AgentSummary transcript maxToolResultBytes must not exceed maxBytes",
    );
  }
  return { maxBytes, maxMessages, maxToolResultBytes };
}

function messageContent(message: Message): readonly unknown[] {
  if (typeof message !== "object" || message === null) return [];
  const envelope = (message as { readonly message?: unknown }).message;
  if (typeof envelope !== "object" || envelope === null) return [];
  const content = (envelope as { readonly content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function toolMessageIds(message: Message): ToolMessageIds {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const block of messageContent(message)) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as {
      readonly type?: unknown;
      readonly id?: unknown;
      readonly tool_use_id?: unknown;
    };
    if (
      record.type === "tool_use" &&
      typeof record.id === "string" &&
      record.id.length > 0
    ) {
      uses.add(record.id);
    }
    if (
      record.type === "tool_result" &&
      typeof record.tool_use_id === "string" &&
      record.tool_use_id.length > 0
    ) {
      results.add(record.tool_use_id);
    }
  }
  return { uses, results, all: new Set([...uses, ...results]) };
}

function serializedMessageBytes(message: Message): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function serializedArrayBytes(payloadBytes: number, count: number): number {
  return 2 + payloadBytes + Math.max(0, count - 1);
}

function utf8Prefix(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Suffix(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function persistedOutputReference(text: string): string | null {
  const match =
    /^<persisted-output>\r?\n(?<reference>Output too large \([^\r\n]+\)\. Full output saved to: [^\r\n]+)(?:\r?\n[\s\S]*)?<\/persisted-output>\s*$/u.exec(
      text,
    );
  const reference = match?.groups?.reference;
  return reference === undefined
    ? null
    : `<persisted-output>\n${reference}\n</persisted-output>`;
}

function offloadedOutputReference(text: string): string | null {
  return (
    /^(\[full output \(~[^\r\n]+ saved to [^\r\n]+:\])(?:\r?\n|$)/u.exec(
      text,
    )?.[1] ?? null
  );
}

function webFetchOutputReference(text: string): string | null {
  return (
    /(?:^|\r?\n\r?\n)(\[Binary content \([^\r\n]+\) also saved to [^\r\n]+\])$/u.exec(
      text,
    )?.[1] ?? null
  );
}

function durableToolResultReference(
  text: string,
  producingToolName: string,
): string | null {
  return (
    persistedOutputReference(text) ??
    offloadedOutputReference(text) ??
    (producingToolName === WEB_FETCH_TOOL_NAME
      ? webFetchOutputReference(text)
      : null)
  );
}

function composeRawToolResult(
  bounded: BoundedRawToolResult,
  maxBytes: number,
): string {
  if (bounded.originalBytes <= maxBytes) return bounded.prefix;
  const rawMarker =
    `\n[tool result truncated; original UTF-8 size: ${bounded.originalBytes} bytes]`;
  const marker = utf8Prefix(rawMarker, maxBytes);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const referenceBudget = Math.max(0, maxBytes - markerBytes - 1);
  const boundedReference = bounded.reference === null
    ? ""
    : utf8Suffix(bounded.reference, referenceBudget);
  const separator = boundedReference.length === 0 ? "" : "\n";
  const reservedBytes =
    markerBytes +
    Buffer.byteLength(separator, "utf8") +
    Buffer.byteLength(boundedReference, "utf8");
  const prefix = utf8Prefix(
    bounded.prefix,
    Math.max(0, maxBytes - reservedBytes),
  );
  return `${prefix}${marker}${separator}${boundedReference}`;
}

function boundRawToolResult(
  text: string,
  producingToolName: string,
  maxBytes: number,
): BoundedRawToolResult {
  const originalBytes = Buffer.byteLength(text, "utf8");
  return {
    originalBytes,
    prefix: utf8Prefix(text, maxBytes),
    reference: durableToolResultReference(text, producingToolName),
  };
}

function oldestLinkedMessageIndexes(
  messages: ReadonlyArray<Message>,
): ReadonlySet<number> {
  const indexes = new Set<number>([0]);
  const linkedIds = new Set(toolMessageIds(messages[0]!).all);
  let changed = linkedIds.size > 0;
  while (changed) {
    changed = false;
    for (let index = 1; index < messages.length; index += 1) {
      if (indexes.has(index)) continue;
      const ids = toolMessageIds(messages[index]!).all;
      if (![...ids].some((id) => linkedIds.has(id))) continue;
      indexes.add(index);
      for (const id of ids) linkedIds.add(id);
      changed = true;
    }
  }
  return indexes;
}

function convertedToolResultMessage(
  event: ToolResultProgressEvent,
  result: string,
  index: number,
): Message {
  const message = runAgentProgressEventToAgentSummaryMessage(
    result === event.result ? event : { ...event, result },
    index,
  );
  if (message === null) {
    throw new Error("AgentSummary tool result conversion returned no message");
  }
  return message;
}

function toolResultText(message: Message): string {
  for (const block of messageContent(message)) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as {
      readonly type?: unknown;
      readonly content?: unknown;
    };
    if (record.type !== "tool_result") continue;
    if (typeof record.content === "string") return record.content;
    if (!Array.isArray(record.content)) continue;
    return record.content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const text = (part as { readonly text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("\n");
  }
  throw new Error("AgentSummary tool result conversion lost its text content");
}

function toolResultTextBytes(message: Message): number {
  return Buffer.byteLength(toolResultText(message), "utf8");
}

function replaceToolResultText(message: Message, text: string): Message {
  const envelope = (message as {
    readonly message: {
      readonly content: ReadonlyArray<unknown>;
    };
  }).message;
  return {
    ...message,
    message: {
      ...envelope,
      content: envelope.content.map((block) => {
        if (typeof block !== "object" || block === null) return block;
        const record = block as { readonly type?: unknown };
        return record.type === "tool_result"
          ? { ...record, content: [{ type: "text", text }] }
          : block;
      }),
    },
  } as Message;
}

function boundedToolResultMessage(
  sourceResult: string,
  producingToolName: string,
  maxBytes: number,
  createMessage: ToolResultMessageFactory,
): Message {
  const bounded = boundRawToolResult(
    sourceResult,
    producingToolName,
    maxBytes,
  );
  const boundedResult = composeRawToolResult(bounded, maxBytes);
  const initial = createMessage(boundedResult);
  if (toolResultTextBytes(initial) <= maxBytes) return initial;

  const empty = createMessage("");
  if (toolResultTextBytes(empty) > maxBytes) {
    return replaceToolResultText(
      initial,
      utf8Prefix(TOOL_RESULT_SAFETY_FRAME_OMISSION, maxBytes),
    );
  }

  let best = empty;
  let low = 1;
  let high = maxBytes;
  while (low <= high) {
    const candidateBudget = low + Math.floor((high - low) / 2);
    const candidateResult = composeRawToolResult(bounded, candidateBudget);
    const candidate = createMessage(candidateResult);
    if (toolResultTextBytes(candidate) <= maxBytes) {
      best = candidate;
      low = candidateBudget + 1;
    } else {
      high = candidateBudget - 1;
    }
  }
  return best;
}

function initialToolResultText(message: LLMMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function canonicalWebFetchResultBody(
  content: LLMMessage["content"],
  pairedToolName: string | undefined,
): string | null {
  if (pairedToolName !== WEB_FETCH_TOOL_NAME || typeof content !== "string") {
    return null;
  }
  for (const kind of UNTRUSTED_TOOL_RESULT_KINDS) {
    const template = frameUntrustedToolResultContent(
      pairedToolName,
      CANONICAL_FRAME_BODY_SENTINEL,
      kind,
    );
    if (typeof template !== "string") continue;
    const bodyOffset = template.indexOf(CANONICAL_FRAME_BODY_SENTINEL);
    if (bodyOffset < 0) continue;
    const prefix = template.slice(0, bodyOffset);
    const suffix = template.slice(
      bodyOffset + CANONICAL_FRAME_BODY_SENTINEL.length,
    );
    if (!content.startsWith(prefix) || !content.endsWith(suffix)) continue;
    const body = content.slice(prefix.length, content.length - suffix.length);
    // Canonical framing remains owned by the shared framing layer: only an
    // exact round trip can unwrap, so nested and lookalike frames fail closed.
    if (
      frameUntrustedToolResultContent(pairedToolName, body, kind) === content
    ) {
      return body;
    }
  }
  return null;
}

function boundedInitialMessage(
  message: LLMMessage,
  index: number,
  maxToolResultBytes: number,
  toolNamesByCallId: ReadonlyMap<string, string>,
): Message {
  if (message.role !== "tool" || !message.toolCallId) {
    return llmMessageToAgentSummaryMessage(message, index);
  }
  const pairedToolName = toolNamesByCallId.get(message.toolCallId);
  const recordedToolName = message.toolName?.trim();
  const producingToolName =
    pairedToolName ??
    (recordedToolName && recordedToolName.length > 0
      ? recordedToolName
      : "unknown_tool");
  const normalizedMessage =
    message.toolName === producingToolName
      ? message
      : { ...message, toolName: producingToolName };
  const canonicalBody = canonicalWebFetchResultBody(
    normalizedMessage.content,
    pairedToolName,
  );
  const sourceMessage = canonicalBody === null
    ? normalizedMessage
    : { ...normalizedMessage, content: canonicalBody };
  const rawResult = initialToolResultText(sourceMessage);
  return boundedToolResultMessage(
    rawResult,
    producingToolName,
    maxToolResultBytes,
    (result) =>
      llmMessageToAgentSummaryMessage(
        result === rawResult
          ? sourceMessage
          : { ...sourceMessage, content: result },
        index,
      ),
  );
}

function boundedProgressMessage(
  event: RunAgentProgressEvent,
  index: number,
  maxToolResultBytes: number,
): Message | null {
  return event.kind === "tool_result"
    ? boundedToolResultMessage(
        event.result,
        event.toolName,
        maxToolResultBytes,
        (result) => convertedToolResultMessage(event, result, index),
      )
    : runAgentProgressEventToAgentSummaryMessage(event, index);
}

function omissionMarker(
  omittedMessages: number,
  omittedBytes: number,
): Message {
  return {
    type: "user",
    uuid: "agent-summary-rolling-omission",
    timestamp: EPOCH_TIMESTAMP,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `[Earlier rolling agent activity omitted: ${omittedMessages} ` +
            `messages / ${omittedBytes} serialized UTF-8 bytes.]`,
        },
      ],
    },
  } as Message;
}

/**
 * Immutable fork context plus a bounded rolling activity window.
 *
 * The rolling window is measured as a JSON array in serialized UTF-8 bytes.
 * Tool-linked messages are evicted as a connected unit, so interleaved calls
 * and results cannot leave either half of a completed pair behind.
 */
export class AgentSummaryTranscript {
  private readonly forkContextMessages: ReadonlyArray<Message>;
  private readonly limits: AgentSummaryTranscriptLimits;
  private rollingMessages: Message[] = [];
  private rollingPayloadBytes = 0;
  private omittedMessages = 0;
  private omittedBytes = 0;
  private nextMessageIndex: number;
  private revisionValue = 0;

  constructor(
    initialMessages: ReadonlyArray<LLMMessage>,
    limitOverrides: AgentSummaryTranscriptLimitOverrides = {},
  ) {
    this.limits = resolveLimits(limitOverrides);
    const toolNamesByCallId = new Map<string, string>();
    this.forkContextMessages = Object.freeze(
      initialMessages.map((message, index) => {
        for (const toolCall of message.toolCalls ?? []) {
          toolNamesByCallId.set(toolCall.id, toolCall.name);
        }
        return boundedInitialMessage(
          message,
          index,
          this.limits.maxToolResultBytes,
          toolNamesByCallId,
        );
      }),
    );
    this.nextMessageIndex = this.forkContextMessages.length;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get messages(): ReadonlyArray<Message> {
    const marker = this.currentOmissionMarker();
    return marker === null
      ? [...this.forkContextMessages, ...this.rollingMessages]
      : [...this.forkContextMessages, marker, ...this.rollingMessages];
  }

  record(event: RunAgentProgressEvent): void {
    if (event.kind === "message" && event.isInitialReplay === true) return;
    const message = boundedProgressMessage(
      event,
      this.nextMessageIndex,
      this.limits.maxToolResultBytes,
    );
    if (message === null) return;
    this.nextMessageIndex += 1;
    this.revisionValue += 1;

    const ids = toolMessageIds(message);
    if (
      ids.results.size > 0 &&
      [...ids.results].some((id) => !this.hasRollingToolUse(id))
    ) {
      this.noteOmitted([message]);
      this.enforceLimits();
      return;
    }

    this.rollingMessages.push(message);
    this.rollingPayloadBytes += serializedMessageBytes(message);
    this.enforceLimits();
  }

  private hasRollingToolUse(id: string): boolean {
    return this.rollingMessages.some((message) =>
      toolMessageIds(message).uses.has(id),
    );
  }

  private currentOmissionMarker(): Message | null {
    return this.omittedMessages === 0
      ? null
      : omissionMarker(this.omittedMessages, this.omittedBytes);
  }

  private retainedRollingSize(): {
    readonly bytes: number;
    readonly messages: number;
  } {
    const marker = this.currentOmissionMarker();
    const markerCount = marker === null ? 0 : 1;
    const markerBytes = marker === null ? 0 : serializedMessageBytes(marker);
    const messages = this.rollingMessages.length + markerCount;
    return {
      bytes: serializedArrayBytes(
        this.rollingPayloadBytes + markerBytes,
        messages,
      ),
      messages,
    };
  }

  private enforceLimits(): void {
    while (true) {
      const retained = this.retainedRollingSize();
      if (
        retained.bytes <= this.limits.maxBytes &&
        retained.messages <= this.limits.maxMessages
      ) {
        return;
      }
      if (this.rollingMessages.length === 0) {
        throw new Error("AgentSummary omission marker exceeds transcript limits");
      }
      this.noteOmitted(this.removeOldestLinkedUnit());
    }
  }

  private removeOldestLinkedUnit(): Message[] {
    const indexes = oldestLinkedMessageIndexes(this.rollingMessages);
    const removed = this.rollingMessages.filter((_message, index) =>
      indexes.has(index),
    );
    this.rollingMessages = this.rollingMessages.filter(
      (_message, index) => !indexes.has(index),
    );
    this.rollingPayloadBytes -= removed.reduce(
      (total, message) => total + serializedMessageBytes(message),
      0,
    );
    return removed;
  }

  private noteOmitted(messages: ReadonlyArray<Message>): void {
    this.omittedMessages += messages.length;
    this.omittedBytes += messages.reduce(
      (total, message) => total + serializedMessageBytes(message),
      0,
    );
  }
}
