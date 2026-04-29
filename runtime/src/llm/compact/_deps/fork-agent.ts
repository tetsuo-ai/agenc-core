/**
 * Forked-subagent runner for compact's cache-sharing path.
 *
 * Hand-port of the upstream openclaude `runForkedAgent` (utils/forkedAgent.ts).
 * The fork shares cache-critical params with the parent so the Anthropic
 * prompt cache key matches and the parent's cached prefix is reused.
 *
 * What "fork" means here, scoped to compact:
 *   - The compact summary is a single model call with `maxTurns: 1` and
 *     no tools (see `createCompactCanUseTool`); there is no nested tool
 *     loop, no MCP server set, no worktree, no permission prompt UI.
 *   - The cache-safe contract is: send the parent's `forkContextMessages`
 *     prefix + `promptMessages` suffix with the same `systemPrompt`,
 *     `tools`, and `model` so the server-side cache key collides with
 *     the parent's most recent main-loop request.
 *   - The runtime returns the assistant turn from that single call along
 *     with `totalUsage` so compact can both render the summary and emit
 *     the `tengu_compact_cache_sharing_success` telemetry event.
 *
 * Why this lives in `_deps/` instead of `runtime/src/agents/`:
 *   - `agents/run-agent.ts` and `agents/delegate.ts` are the heavy
 *     subagent-runner surface (child Session, MCP startup, hooks,
 *     permission flow, mailbox progress events). Compact's "fork" is
 *     intentionally none of those things — it is one cache-shared
 *     model call. Routing through the subagent runner would drag in
 *     irrelevant lifecycle, defeat `maxTurns: 1`, and risk altering
 *     the cache key by adding extra system context.
 *   - The gut LLM provider is reached directly via the existing
 *     `_deps/api-client.ts::queryModelWithStreaming` adapter, which is
 *     already cache-safe (it does not synthesize extra system messages
 *     beyond the caller-provided `systemPrompt`).
 *
 * What is NOT yet wired through gut's LLM boundary:
 *   - `cache_creation_input_tokens` / `cache_read_input_tokens`. The
 *     gut `LLMUsage` interface (runtime/src/llm/types.ts) carries only
 *     `promptTokens` / `completionTokens`; the Anthropic adapter's
 *     `mergeAnthropicUsage` explicitly drops the cache fields before
 *     they reach the provider boundary. Server-side cache hits still
 *     occur (the request is shaped to be cache-safe) and still reduce
 *     real billed cost, but the per-call cache split is not currently
 *     observable through the gut adapter contract. Until LLMUsage is
 *     extended, those fields are reported as 0 in `totalUsage`. The
 *     compact telemetry path (`tengu_compact_cache_sharing_success`)
 *     accepts zeros without altering correctness.
 */

import { queryModelWithStreaming } from "./api-client.js";

export interface CacheSafeParams {
  readonly systemPrompt: unknown;
  /** Parent context messages prepended to promptMessages for cache prefix reuse. */
  readonly forkContextMessages?: ReadonlyArray<unknown>;
  /** Inert here — preserved on the type to mirror upstream cacheSafeParams. */
  readonly userContext?: Record<string, string>;
  /** Inert here — preserved on the type to mirror upstream cacheSafeParams. */
  readonly systemContext?: Record<string, string>;
  readonly tools?: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
}

export interface RunForkedAgentArgs {
  readonly promptMessages: ReadonlyArray<unknown>;
  readonly cacheSafeParams: CacheSafeParams;
  readonly canUseTool?: unknown;
  readonly querySource?: string;
  readonly forkLabel?: string;
  readonly signal?: AbortSignal;
  /** Caps output tokens. CAUTION mirrors upstream — see compact.ts:1918. */
  readonly maxOutputTokensOverride?: number;
  /**
   * Compact-only `maxTurns: 1` enforcement. The compact `canUseTool`
   * denies every tool, and `queryModelWithStreaming` already issues a
   * single chat call (no internal tool loop), so this is structurally
   * satisfied by the call shape; the field is accepted for upstream
   * parity and validated at runtime so future callers cannot silently
   * widen the contract.
   */
  readonly maxTurns?: number;
  readonly skipCacheWrite?: boolean;
  /** Optional override bag — only `abortController` is consumed today. */
  readonly overrides?: {
    readonly abortController?: AbortController;
  };
  readonly model?: string;
  readonly [key: string]: unknown;
}

export interface RunForkedAgentResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly messages: any[];
  readonly totalUsage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    /** See module doc — gut's LLMUsage does not carry this yet. */
    readonly cache_creation_input_tokens: number;
    /** See module doc — gut's LLMUsage does not carry this yet. */
    readonly cache_read_input_tokens: number;
  };
}

/**
 * Runs one forked, cache-safe model call and returns the assistant
 * turn plus aggregated usage.
 *
 * Cache-safety contract preserved from upstream:
 *   - The wire-level message stream is `forkContextMessages` followed
 *     by `promptMessages`, matching the parent's prefix exactly so the
 *     Anthropic prompt cache key collides.
 *   - `systemPrompt`, `tools`, and `model` are forwarded verbatim.
 *   - Output token cap is left undefined unless the caller explicitly
 *     opts in; clamping `max_tokens` would also clamp Anthropic's
 *     `budget_tokens` and invalidate the cache key (see compact.ts
 *     :1918 for the same warning at the call site).
 *
 * Single-turn enforcement:
 *   - The underlying `queryModelWithStreaming` makes exactly one chat
 *     call. Callers that pass `maxTurns` other than 1 are rejected so
 *     the no-tools, single-call contract cannot drift silently.
 */
export async function runForkedAgent(
  args: RunForkedAgentArgs,
): Promise<RunForkedAgentResult> {
  if (args.maxTurns !== undefined && args.maxTurns !== 1) {
    throw new Error(
      `runForkedAgent: maxTurns must be 1 for the compact fork (received ${args.maxTurns}). ` +
        `The compact path issues a single tool-less model call by contract.`,
    );
  }

  const {
    systemPrompt,
    tools,
    forkContextMessages,
  } = args.cacheSafeParams;

  // Wire shape mirrors upstream forkedAgent.ts:524 —
  //   `[...forkContextMessages, ...promptMessages]`
  // The parent context prefix is what the server-side prompt cache
  // matches against. Without it, the fork would issue an unrelated
  // request and miss the cache entirely (the prior stub did exactly
  // this and silently dropped cache sharing on the floor).
  const wireMessages: unknown[] = [];
  if (forkContextMessages && forkContextMessages.length > 0) {
    wireMessages.push(...forkContextMessages);
  }
  wireMessages.push(...args.promptMessages);

  // Resolve the abort signal. Upstream wires the parent's
  // abortController via createSubagentContext; here we accept either
  // a top-level `signal` or `overrides.abortController.signal`. If
  // both are provided, the explicit `signal` wins (it is the more
  // direct caller intent and is what `queryModelWithStreaming`
  // forwards verbatim to the provider).
  const overrideSignal = args.overrides?.abortController?.signal;
  const effectiveSignal = args.signal ?? overrideSignal;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collectedMessages: any[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  const queryArgs: Parameters<typeof queryModelWithStreaming>[0] = {
    messages: wireMessages,
    systemPrompt,
    tools: tools ?? [],
    ...(effectiveSignal ? { signal: effectiveSignal } : {}),
    options: {
      ...(args.model ? { model: args.model } : {}),
      ...(args.maxOutputTokensOverride
        ? { maxOutputTokensOverride: args.maxOutputTokensOverride }
        : {}),
      ...(args.querySource ? { querySource: args.querySource } : {}),
    },
  };

  for await (const event of queryModelWithStreaming(queryArgs)) {
    if (!event || typeof event !== "object") continue;
    const ev = event as { type?: string; message?: { usage?: unknown } };
    if (ev.type === "assistant") {
      collectedMessages.push(event);
      const usage = ev.message?.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      // `input_tokens` and `output_tokens` are real numbers from the
      // provider response (synthesized by api-client.ts from
      // `LLMUsage.promptTokens` / `LLMUsage.completionTokens`).
      // Cache-split fields are not available through gut's adapter
      // boundary today — see module doc.
      inputTokens += usage?.input_tokens ?? 0;
      outputTokens += usage?.output_tokens ?? 0;
    }
    // `stream_event` chunks (content_block_start/delta/stop) are
    // intentionally not surfaced upward. Compact's cache-sharing
    // path consumes `result.messages` only and reads the final text
    // via `getLastAssistantMessage` + `getAssistantMessageText`.
  }

  return {
    messages: collectedMessages,
    totalUsage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
