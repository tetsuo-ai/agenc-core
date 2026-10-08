import { filesystemRootsForDispatch } from "../tools/filesystem-dispatch-roots.js";
import { stripModelSuppliedAgenCInternalArgs } from "../tools/internal-args.js";
import { sessionDispatchAuthority } from "../tools/session-dispatch-authority.js";
import type { StreamModelRequestContract } from "../phases/stream-model.js";
import { flushOneShotEffectJournal } from "../budget/admitted-tool-call.js";
import { cumulativeUsage } from "./cumulative-usage.js";
import { markLoadedToolNamesDiscovered } from "../tools/deferred-discovery.js";
import { classifyUntrustedToolResult } from "../tools/untrusted-tool-result-framing.js";
import { createToolResultIntegrity } from "./tool-result-integrity.js";
import { modelFacingToolResultContent } from "../phases/execute-tools.js";
/** One-shot bypass turn loop. Session data is finalized once at the terminal boundary. */
import { requiresAtomicSpendAdmission } from "../one-shot-fast-mode.js";
import { createFastContextGuard } from "./fast-context-guard.js";
import type { EventMsg } from "./event-log.js";
import type { LLMMessage, LLMUsage, LLMResponse } from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { buildProviderOptions } from "../phases/stream-model.js";
import type { Terminal } from "./turn-state.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import { buildPrompt, builtTools } from "./run-turn-sampling-request.js";
import { llmMessageToResponseItem } from "./message-history-conversion.js";

const UNKNOWN_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0,
  availability: "unknown" as const, provenance: "synthetic" as const };

export async function* runMinimalTurn(
  session: Session,
  ctx: TurnContext,
  messages: LLMMessage[],
  instructions: string,
  signal: AbortSignal,
  prepareRequest?: (modelCalls: number, lastResponseUsage: LLMUsage | undefined) => Promise<{ request: StreamModelRequestContract; samplingContext: TurnContext } | null>,
): AsyncGenerator<PhaseEvent, Terminal | { reason: "continue_normal"; modelCalls: number; usage: LLMUsage; lastResponseUsage?: LLMUsage }> {
  // The initial options bound eligibility before any preparation work.
  const request = buildPrompt(messages, builtTools(session, ctx), ctx, instructions);
  let options = buildProviderOptions(request, ctx, signal, session);
  const start = messages.length - 1;
  let fits = createFastContextGuard(options);
  let handoff = false;
  let modelCalls = 0;
  const observations: EventMsg[] = [];
  const responses: LLMResponse[] = [];
  let usage: LLMUsage = UNKNOWN_USAGE;
  let lastResponseUsage: LLMUsage | undefined;
  yield { type: "turn_start", turnIndex: 0 };
  try {
    for (;;) {
      signal.throwIfAborted();
      if (!fits(messages) || requiresAtomicSpendAdmission(session) ||
          (typeof ctx.config?.maxBudgetUsd === "number" && ctx.config.maxBudgetUsd > 0) ||
          modelCalls >= (ctx.config?.maxTurns ?? 100)) {
        handoff = true;
        return { reason: "continue_normal", modelCalls, usage, lastResponseUsage };
      }
      const prepared = prepareRequest ? await prepareRequest(modelCalls, lastResponseUsage) : undefined;
      if (prepared === null) {
        handoff = true;
        return { reason: "continue_normal", modelCalls, usage, lastResponseUsage };
      }
      if (prepared) {
        options = buildProviderOptions(prepared.request, prepared.samplingContext, signal, session);
        // Attachments and permission instructions count toward the same bound.
        // The canonical projection may rewrite the prefix, so use a fresh guard.
        if (!createFastContextGuard(options)(prepared.request.input)) {
          handoff = true;
          return { reason: "continue_normal", modelCalls, usage, lastResponseUsage };
        }
      }
      const response = await session.services.provider.chatStream(prepared?.request.input.slice() ?? messages, () => {}, options);
      modelCalls++;
      responses.push(response);
      if (response.error) throw response.error;
      usage = cumulativeUsage(usage, response.usage);
      lastResponseUsage = response.usage;
      if (response.usage) {
        const { speed, ...usage } = response.usage;
        observations.push({ type: "token_count", payload: {
          ...usage, model: response.model, provider: session.services.provider.name,
          ...(speed === "fast" ? { speed } : {}),
        } });
      }
      signal.throwIfAborted();
      messages.push({ role: "assistant", content: response.content,
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
        ...(response.providerReasoningContent !== undefined ? { providerReasoningContent: response.providerReasoningContent } : {}),
        ...(response.providerReasoningProvenance !== undefined ? { providerReasoningProvenance: response.providerReasoningProvenance } : {}),
      });
      if (response.toolCalls.length === 0) {
        if (response.content) {
          session.emit({ id: session.nextInternalSubId(), msg: { type: "agent_message", payload: { message: response.content } } });
          yield { type: "assistant_text", content: response.content };
        }
        yield { type: "turn_complete", content: response.content, usage, stopReason: "completed" };
        return { reason: "completed" };
      }
      for (const call of response.toolCalls) {
        signal.throwIfAborted();
        let content: string;
        let modelContent: LLMMessage["content"] | undefined;
        let isError = false;
        let metadata: Record<string, unknown> | undefined;
        const started = performance.now();
        observations.push({ type: "tool_call_started", payload: { callId: call.id, toolName: call.name, args: call.arguments } });
        try {
          const result = await session.services.registry.dispatch(call, {
            prepareArguments: args => {
              const projected = filesystemRootsForDispatch(call.name, stripModelSuppliedAgenCInternalArgs(args), {
                approvalResolved: false, sandboxMode: ctx.sandboxPolicy.value, session,
              });
              const authority = {
                ...sessionDispatchAuthority(session, session.services.configStore?.homeContext.path),
                __onProgress: (event: { chunk: string; stream?: "stdout" | "stderr" }) => {
                  observations.push({ type: "tool_progress", payload: {
                    callId: call.id, toolName: call.name, ...event,
                  } });
                },
              };
              for (const [key, value] of Object.entries(authority)) {
                Object.defineProperty(projected, key, { value, enumerable: false, configurable: true, writable: true });
              }
              return projected;
            },
            abortSignal: signal, advertisedToolNames: options.tools?.map(tool => tool.function.name),
          });
          content = result.content;
          metadata = result.metadata;
          markLoadedToolNamesDiscovered(call.name, result, session.services.registry.getDiscoveredToolNames?.());
          const tool = session.services.registry.tools?.find(tool => tool.name === call.name);
          modelContent = modelFacingToolResultContent(call.name, result,
            classifyUntrustedToolResult(call.name, tool), session.services.runtimeOptions?.lightMode === true);
          isError = result.isError === true;
        } catch (error) {
          signal.throwIfAborted();
          isError = true;
          content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
        observations.push({ type: "tool_call_completed", payload: {
          callId: call.id, toolName: call.name, result: content, isError, ...(metadata ? { metadata } : {}), durationMs: performance.now() - started,
        } });
        messages.push({ role: "tool", toolName: call.name, toolCallId: call.id, content: modelContent ?? content });
      }
      // Discovery can reveal new capabilities during this turn.
      const tools = builtTools(session, ctx);
      if (JSON.stringify(tools) !== JSON.stringify(options.tools)) {
        options = { ...options, tools, toolRouting: { allowedToolNames: tools.map(tool => tool.function.name) } };
        fits = createFastContextGuard(options);
      }
    }
  } finally {
    // Request diagnostics are deliberately materialized off the command path.
    for (const response of responses) void response.requestMetrics;
    flushOneShotEffectJournal(session);
    // The one-shot crash contract buffers this run; serialization redacts at close.
    for (const message of messages.slice(start)) {
      if (message.role === "tool" && message.toolCallId && !message.runtimeOnly?.toolResultIntegrity) {
        message.runtimeOnly = { ...message.runtimeOnly, toolResultIntegrity: createToolResultIntegrity({
          runId: session.conversationId, toolCallId: message.toolCallId, content: message.content,
        }) };
      }
    }
    for (const msg of observations) session.emit({ id: session.nextInternalSubId(), msg });
    if (!handoff) {
    await session.state.with(state => { state.history = messages; });
    const store = session.rolloutStore?.store;
    for (const message of messages.slice(start)) {
      store?.appendRollout({ type: "response_item", payload: llmMessageToResponseItem(message) });
    }
    }
  }
}
