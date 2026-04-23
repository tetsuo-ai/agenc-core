/**
 * Compaction model-call adapter that delegates to the gut runtime's
 * `LLMProvider` factory.
 *
 * The compact subsystem expects an async generator yielding
 * Anthropic-style `stream_event` chunks (matching the upstream
 * openclaude wire shape — `content_block_start` + `text_delta`
 * `content_block_delta` events) plus a terminal `assistant` event
 * carrying the final compacted text and usage.
 *
 * This implementation drives the active gut LLM provider's
 * `chatStream()` and translates each delta into the upstream-shaped
 * stream event consumed by `compactConversation` (see
 * `compact.ts:2068-2095`). Streaming UX surfaces real per-token
 * deltas during compaction so the cockpit "responding" status and
 * response-length counter advance live, matching the original
 * upstream behavior at
 * `/home/tetsuo/git/claude/src/services/api/claude.ts::queryModelWithStreaming`
 * (line 762).
 *
 * What we deliberately do NOT pull in from upstream:
 *   - the Anthropic SDK / `Stream<BetaRawMessageStreamEvent>` graph
 *   - `withRetry` / `withStreamingVCR`: gut providers own their
 *     own retry policy, so a second wrapper would double-retry
 *   - non-streaming fallback: the gut provider's stream path
 *     already returns a complete `LLMResponse` after the stream
 *     drains, so no separate fallback is required here
 *
 * The translation is intentionally narrow: we synthesize one text
 * block (`content_block_start` + N `content_block_delta` events)
 * because that is all the compact consumer reads. Tool-call deltas
 * are not surfaced as compaction never asks the model to invoke
 * tools (it requests a summary).
 */

import { createProvider, resolveProviderNameFromEnv } from "../../provider.js";
import type { LLMMessage, LLMTool, LLMStreamChunk } from "../../types.js";

interface QueryArgs {
  readonly messages: ReadonlyArray<unknown>;
  readonly systemPrompt: unknown;
  readonly thinkingConfig?: unknown;
  readonly tools?: ReadonlyArray<unknown>;
  readonly signal?: AbortSignal;
  readonly options?: {
    readonly model?: string;
    readonly maxOutputTokensOverride?: number;
    readonly querySource?: string;
    readonly [key: string]: unknown;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompactStreamEvent = any;

function flattenSystemPrompt(systemPrompt: unknown): string {
  if (!systemPrompt) return "";
  if (typeof systemPrompt === "string") return systemPrompt;
  if (Array.isArray(systemPrompt)) {
    return systemPrompt
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text?: unknown }).text;
          if (typeof t === "string") return t;
        }
        return "";
      })
      .join("\n");
  }
  if (typeof systemPrompt === "object" && systemPrompt && "text" in systemPrompt) {
    const t = (systemPrompt as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

function adaptMessage(raw: unknown): LLMMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as {
    type?: string;
    role?: string;
    content?: unknown;
    message?: { role?: string; content?: unknown };
  };
  // Upstream openclaude shape: { type: 'user' | 'assistant', message: { role, content } }
  // Gut shape: { role, content }
  const role = m.message?.role ?? m.role ?? m.type;
  const content = m.message?.content ?? m.content;
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  if (typeof content === "string") {
    return { role, content };
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
    return { role, content: text };
  }
  return null;
}

function randomId(): string {
  return Array.from({ length: 4 }, () =>
    Math.random().toString(36).slice(2, 10),
  ).join("-");
}

/**
 * Pump events from a callback-style provider stream into an async
 * iterator. The provider's `chatStream` invokes the `onChunk`
 * callback one or more times before its returned promise resolves;
 * we need those chunks to surface from a generator, in order, with
 * the final `LLMResponse` available afterwards.
 *
 * The queue uses single-resumer back-pressure: each `push` either
 * resolves a parked `next()` waiter or buffers the chunk. The
 * `complete`/`fail` calls flush the terminator so the consumer
 * exits cleanly.
 */
interface ChunkQueue {
  push(chunk: LLMStreamChunk): void;
  complete(): void;
  fail(err: unknown): void;
  drain(): AsyncIterableIterator<LLMStreamChunk>;
}

function createChunkQueue(): ChunkQueue {
  const buffer: LLMStreamChunk[] = [];
  let waiter:
    | {
        resolve: (value: IteratorResult<LLMStreamChunk>) => void;
        reject: (err: unknown) => void;
      }
    | null = null;
  let done = false;
  let error: unknown = null;

  function push(chunk: LLMStreamChunk): void {
    if (done) return;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve({ value: chunk, done: false });
    } else {
      buffer.push(chunk);
    }
  }

  function complete(): void {
    if (done) return;
    done = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve({ value: undefined as unknown as LLMStreamChunk, done: true });
    }
  }

  function fail(err: unknown): void {
    if (done) return;
    done = true;
    error = err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(err);
    }
  }

  function drain(): AsyncIterableIterator<LLMStreamChunk> {
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<LLMStreamChunk>> {
        if (buffer.length > 0) {
          return Promise.resolve({ value: buffer.shift()!, done: false });
        }
        if (error) {
          return Promise.reject(error);
        }
        if (done) {
          return Promise.resolve({
            value: undefined as unknown as LLMStreamChunk,
            done: true,
          });
        }
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject };
        });
      },
    };
  }

  return { push, complete, fail, drain };
}

export async function* queryModelWithStreaming(
  args: QueryArgs,
): AsyncGenerator<CompactStreamEvent, void> {
  const messages: LLMMessage[] = [];
  const sys = flattenSystemPrompt(args.systemPrompt);
  if (sys.length > 0) {
    messages.push({ role: "system", content: sys });
  }
  for (const raw of args.messages) {
    const adapted = adaptMessage(raw);
    if (adapted) messages.push(adapted);
  }

  const providerName = resolveProviderNameFromEnv();
  const provider = createProvider(providerName, {
    ...(args.options?.model ? { model: args.options.model } : {}),
    ...(args.options?.maxOutputTokensOverride
      ? { extra: { maxTokens: args.options.maxOutputTokensOverride } }
      : {}),
    tools: (args.tools ?? []) as ReadonlyArray<LLMTool>,
  });

  const queue = createChunkQueue();
  const chatPromise = provider
    .chatStream(
      messages,
      (chunk) => {
        queue.push(chunk);
      },
      {
        ...(args.signal ? { signal: args.signal } : {}),
      },
    )
    .then(
      (response) => {
        queue.complete();
        return response;
      },
      (err) => {
        queue.fail(err);
        throw err;
      },
    );

  // Track whether we have already opened the synthetic text block.
  // Upstream emits `content_block_start` once before any deltas; we
  // mirror that so the compact consumer's `setStreamMode('responding')`
  // gate fires exactly once when real content begins.
  let openedTextBlock = false;
  // Running accumulator for the assistant text. Most adapters emit
  // incremental deltas, but `LLMStreamChunk.resetBuffer === true`
  // indicates a snapshot rewrite (Grok mitigation path) — when that
  // arrives we discard our accumulator and re-emit the corrected
  // snapshot as a single text_delta.
  let accumulated = "";

  function* openTextBlockIfNeeded(): Generator<CompactStreamEvent> {
    if (openedTextBlock) return;
    openedTextBlock = true;
    yield {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    };
  }

  function* closeTextBlockIfOpen(): Generator<CompactStreamEvent> {
    if (!openedTextBlock) return;
    openedTextBlock = false;
    yield {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    };
  }

  try {
    for await (const chunk of queue.drain()) {
      // Terminal callback — provider signals end of stream. We ignore
      // here because the resolved `chatPromise` carries the
      // authoritative final content and usage.
      if (chunk.done) {
        continue;
      }

      // Snapshot rewrite (Grok partial-reply mitigation). The chunk
      // carries a full-so-far snapshot, not an incremental delta.
      // Anthropic's stream-event protocol has no "replace buffer"
      // primitive, so we close the current text block and open a new
      // one (consumers that segment by content_block boundary will
      // discard the old block; consumers that concatenate everything
      // get the snapshot-as-delta path which is best-effort).
      //
      // Emit only the net-new suffix when the snapshot is a strict
      // extension of the prior accumulator (the common case). When the
      // snapshot diverges, restart the block so the new content is the
      // authoritative buffer.
      if (chunk.resetBuffer === true) {
        const next = chunk.content ?? "";
        const prev = accumulated;
        accumulated = next;
        if (next.length === 0) continue;
        if (next.startsWith(prev)) {
          const suffix = next.slice(prev.length);
          if (suffix.length === 0) continue;
          yield* openTextBlockIfNeeded();
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: suffix },
            },
          };
          continue;
        }
        // Divergent snapshot — close the current block (so consumers
        // can drop accumulated state) and open a fresh one carrying
        // the corrected snapshot.
        yield* closeTextBlockIfOpen();
        yield* openTextBlockIfNeeded();
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: next },
          },
        };
        continue;
      }

      const text = chunk.content ?? "";
      if (text.length === 0) continue;

      accumulated += text;
      yield* openTextBlockIfNeeded();
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
      };
    }

    // Wait for the provider call to settle and grab the
    // authoritative final response. If the stream queue completed
    // cleanly, this resolves immediately.
    const response = await chatPromise;
    const finalText = response.content ?? accumulated;

    // If the provider produced text but never streamed a delta
    // (e.g. an adapter that buffers internally and only fires a
    // terminal `done` chunk), surface it as a single delta so the
    // compact consumer's "responding" state still advances.
    if (!openedTextBlock && finalText.length > 0) {
      yield* openTextBlockIfNeeded();
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: finalText },
        },
      };
    }

    if (openedTextBlock) {
      yield {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      };
    }

    yield {
      type: "assistant",
      uuid: randomId(),
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: finalText }],
        usage: {
          input_tokens: response.usage?.promptTokens ?? 0,
          output_tokens: response.usage?.completionTokens ?? 0,
        },
      },
    };
  } catch (err) {
    // Make sure the chat promise is awaited so we don't leave a
    // dangling unhandled rejection. We rethrow the original error.
    await chatPromise.catch(() => undefined);
    throw err;
  }
}
