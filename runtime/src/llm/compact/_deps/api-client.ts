/**
 * Compaction model-call adapter that delegates to the gut runtime's
 * `LLMProvider` factory. The compact subsystem expects an async
 * generator yielding Anthropic-style `stream_event` chunks plus a
 * terminal `assistant` event; this implementation calls the active
 * provider via `chat()` and then yields a single `assistant` event
 * carrying the full compacted text.
 *
 * Streaming UX is degraded compared to the upstream openclaude impl
 * (no token-level deltas surface to the cockpit during compaction),
 * but the compaction summary itself is produced correctly. A
 * future tranche can wire `chatStream()` to surface per-chunk deltas.
 */

import { createProvider, resolveProviderNameFromEnv } from "../../provider.js";
import type { LLMMessage, LLMTool } from "../../types.js";

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
  const response = await provider.chat(messages, {
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const text = response.content ?? "";
  // Yield a synthesized stream_event so call sites that watch
  // `event.event.type === 'content_block_start'` for streaming UI
  // updates fire once before the terminal `assistant` event.
  yield {
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "text" },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  if (text.length > 0) {
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }
  yield {
    type: "assistant",
    uuid: randomId(),
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input_tokens: response.usage?.promptTokens ?? 0,
        output_tokens: response.usage?.completionTokens ?? 0,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
