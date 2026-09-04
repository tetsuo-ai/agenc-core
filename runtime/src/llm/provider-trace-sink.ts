/**
 * Env-gated per-request provider trace (`AGENC_PROVIDER_TRACE=1`).
 *
 * The Grok adapter already emits `request` / `stream_event` / `response` /
 * `error` trace events through `options.trace.onProviderTraceEvent`, but
 * only the slash-command dispatcher ever consumed them; the main loop had no
 * persisted per-call LLM log (the `agent-logs/<conv>/<callId>.log` files are
 * rotated tool output, not model calls). This sink writes one JSON line per
 * request and one per response or error to
 * `<AGENC_HOME>/agent-logs/<conversationId>/llm-<seq>.jsonl`: the request
 * params minus message bodies (model, `prompt_cache_key`,
 * `previous_response_id`, `reasoning`, `parallel_tool_calls`,
 * `max_output_tokens`, counts for input items and tools), the provider
 * usage, the stream event count and the elapsed milliseconds.
 *
 * With `AGENC_PROVIDER_TRACE_BODIES=1` as well, each request also lands in
 * full as `llm-<seq>.request.json` (secrets redacted): the whole prompt, so
 * two consecutive requests can be diffed byte for byte when the digests say
 * the cached prefix changed. `scripts/eval/prefix-diff.mjs` reads them.
 *
 * Diagnostics only: a write failure disables the sink for the session and
 * never reaches the turn.
 *
 * @module
 */

import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { LLMProviderTraceEvent } from "./types.js";
import { isEnvTruthy } from "../utils/envBoolean.js";
import { redactSecretsInValue } from "../secrets/index.js";

export const PROVIDER_TRACE_ENV = "AGENC_PROVIDER_TRACE";

export function providerTraceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isEnvTruthy(env[PROVIDER_TRACE_ENV]);
}

export const PROVIDER_TRACE_BODIES_ENV = "AGENC_PROVIDER_TRACE_BODIES";

/**
 * Full request bodies are a second opt-in on top of the trace: they hold the
 * whole prompt, so they are never written by the trace flag alone.
 */
export function providerTraceBodiesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return providerTraceEnabled(env) && isEnvTruthy(env[PROVIDER_TRACE_BODIES_ENV]);
}

export interface ProviderTraceSink {
  readonly onProviderTraceEvent: (event: LLMProviderTraceEvent) => void;
  /** Directory receiving `llm-<seq>.jsonl` files. */
  readonly directory: string;
}

interface InFlightRequest {
  readonly seq: number;
  readonly startedAtMs: number;
  readonly path: string;
  streamEvents: number;
  firstStreamEventMs: number | undefined;
}

const MESSAGE_BODY_KEYS: ReadonlySet<string> = new Set([
  "input",
  "messages",
  "instructions",
  "system",
]);

function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "_") start += 1;
  while (end > start && value[end - 1] === "_") end -= 1;
  return value.slice(start, end);
}

function safeSegment(value: string): string {
  if (value !== "." && value !== ".." && /^[a-zA-Z0-9._-]{1,128}$/.test(value)) {
    return value;
  }
  const safe = trimUnderscores(value.replace(/[^a-zA-Z0-9._-]+/g, "_")).slice(0, 80);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${safe.length > 0 ? safe : "unknown"}-${hash}`;
}

function jsonChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const record = tool as Record<string, unknown>;
    const name =
      record.name ??
      (record.function as Record<string, unknown> | undefined)?.name ??
      record.type;
    return typeof name === "string" ? [name] : [];
  });
}

/** Items at the head of the request whose digests the trace records. */
export const TRACE_PREFIX_ITEM_COUNT = 4;

function shortDigest(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Request params with message bodies replaced by sizes and digests. The
 * digests of the leading items (instructions, system messages, the first
 * user message) and of the tool list let two consecutive requests be
 * compared for cache-prefix stability without persisting any body: a
 * prompt-cache miss between calls whose prefix digests are identical is the
 * provider's, one whose digests differ is ours.
 */
export function summarizeProviderRequestParams(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: payload.model ?? null,
    prompt_cache_key: payload.prompt_cache_key ?? null,
    previous_response_id: payload.previous_response_id ?? null,
    reasoning: payload.reasoning ?? null,
    parallel_tool_calls: payload.parallel_tool_calls ?? null,
    max_output_tokens: payload.max_output_tokens ?? null,
  };
  for (const [key, value] of Object.entries(payload)) {
    if (key in out) continue;
    if (MESSAGE_BODY_KEYS.has(key)) {
      if (Array.isArray(value)) {
        out[`${key}_items`] = value.length;
        out[`${key}_prefix_sha256`] = value
          .slice(0, TRACE_PREFIX_ITEM_COUNT)
          .map((item) => shortDigest(item));
      }
      out[`${key}_chars`] = jsonChars(value);
      out[`${key}_sha256`] = shortDigest(value);
      continue;
    }
    if (key === "tools") {
      const names = toolNames(value);
      out.tool_count = names.length;
      out.tool_names = names;
      out.tools_sha256 = shortDigest(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function messageTextChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    const text = (part as Record<string, unknown> | null)?.text;
    if (typeof text === "string") chars += text.length;
  }
  return chars;
}

function summarizeOutputItems(output: readonly unknown[]): {
  readonly outputTextChars: number;
  readonly toolCalls: number;
} {
  let outputTextChars = 0;
  let toolCalls = 0;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "function_call") toolCalls += 1;
    if (record.type === "message") {
      outputTextChars += messageTextChars(record.content);
    }
  }
  return { outputTextChars, toolCalls };
}

function summarizeProviderResponse(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const { outputTextChars, toolCalls } = summarizeOutputItems(output);
  return {
    id: payload.id ?? null,
    status: payload.status ?? null,
    model: payload.model ?? null,
    usage: payload.usage ?? null,
    incomplete_details: payload.incomplete_details ?? null,
    output_items: output.length,
    output_text_chars: outputTextChars,
    tool_calls: toolCalls,
    ...(payload.error !== undefined ? { error: payload.error } : {}),
  };
}


const TRACE_FILE_RE = /^llm-(\d{5,})\.jsonl$/;

/** Highest `llm-<seq>.jsonl` sequence already present, or 0. */
export function highestExistingTraceSeq(directory: string): number {
  let highest = 0;
  try {
    for (const name of readdirSync(directory)) {
      const match = TRACE_FILE_RE.exec(name);
      if (match === null) continue;
      const value = Number.parseInt(match[1] as string, 10);
      if (Number.isSafeInteger(value) && value > highest) highest = value;
    }
  } catch {
    // No directory yet: numbering starts at 1.
  }
  return highest;
}

export function createProviderTraceSink(params: {
  readonly agencHome: string;
  readonly conversationId: string;
  /** Also write each full request as `llm-<seq>.request.json`. */
  readonly bodies?: boolean;
  readonly now?: () => number;
  readonly wallClock?: () => string;
}): ProviderTraceSink {
  const directory = join(
    params.agencHome,
    "agent-logs",
    safeSegment(params.conversationId),
  );
  const now = params.now ?? (() => performance.now());
  const wallClock = params.wallClock ?? (() => new Date().toISOString());
  // Continue after the files already in the directory: a resumed session
  // (daemon restart) creates a new sink for the same conversation, and a
  // counter that restarted at zero appended the new epoch's records into the
  // first epoch's files.
  let seq = highestExistingTraceSeq(directory);
  let inFlight: InFlightRequest | undefined;
  let disabled = false;
  let directoryReady = false;

  const write = (path: string, line: Record<string, unknown>): void => {
    if (disabled) return;
    try {
      if (!directoryReady) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        directoryReady = true;
      }
      appendFileSync(
        path,
        `${JSON.stringify(redactSecretsInValue(line))}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Diagnostics must never fail the turn; stop writing for this session.
      disabled = true;
    }
  };

  const writeBody = (path: string, payload: Record<string, unknown>): void => {
    if (disabled) return;
    try {
      if (!directoryReady) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        directoryReady = true;
      }
      writeFileSync(
        path,
        `${JSON.stringify(redactSecretsInValue(payload))}\n`,
        { mode: 0o600 },
      );
    } catch {
      disabled = true;
    }
  };

  const base = (event: LLMProviderTraceEvent, request: InFlightRequest) => ({
    seq: request.seq,
    ts: wallClock(),
    conversationId: params.conversationId,
    provider: event.provider,
    model: event.model ?? null,
    transport: event.transport,
    ...(event.callPhase !== undefined ? { callPhase: event.callPhase } : {}),
  });

  const onProviderTraceEvent = (event: LLMProviderTraceEvent): void => {
    if (disabled) return;
    if (event.kind === "request") {
      seq += 1;
      const stem = `llm-${String(seq).padStart(5, "0")}`;
      inFlight = {
        seq,
        startedAtMs: now(),
        path: join(directory, `${stem}.jsonl`),
        streamEvents: 0,
        firstStreamEventMs: undefined,
      };
      write(inFlight.path, {
        kind: "request",
        ...base(event, inFlight),
        params: summarizeProviderRequestParams(event.payload),
        ...(event.context !== undefined ? { context: event.context } : {}),
      });
      if (params.bodies === true) {
        writeBody(join(directory, `${stem}.request.json`), event.payload);
      }
      return;
    }
    if (inFlight === undefined) return;
    if (event.kind === "stream_event") {
      inFlight.streamEvents += 1;
      inFlight.firstStreamEventMs ??= now() - inFlight.startedAtMs;
      return;
    }
    const request = inFlight;
    inFlight = undefined;
    const elapsedMs = Math.max(0, Math.round(now() - request.startedAtMs));
    write(request.path, {
      kind: event.kind,
      ...base(event, request),
      elapsedMs,
      firstStreamEventMs:
        request.firstStreamEventMs === undefined
          ? null
          : Math.round(request.firstStreamEventMs),
      streamEvents: request.streamEvents,
      ...(event.kind === "response"
        ? { response: summarizeProviderResponse(event.payload) }
        : { error: event.payload }),
      ...(event.context !== undefined ? { context: event.context } : {}),
    });
  };

  return { onProviderTraceEvent, directory };
}
