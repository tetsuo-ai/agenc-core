import { validateToolCall } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import { filesystemRootsForDispatch } from "../tools/filesystem-dispatch-roots.js";
import { stripModelSuppliedAgenCInternalArgs } from "../tools/internal-args.js";
import { sessionDispatchAuthority } from "../tools/session-dispatch-authority.js";
import { attachPreflightRuntimeContext } from "../tools/router.js";
import { createTurnDiffTracker, parseToolName } from "../tools/context.js";
import type { StreamModelRequestContract } from "../phases/stream-model.js";
import { flushOneShotEffectJournal } from "../budget/admitted-tool-call.js";
import { cumulativeUsage } from "./cumulative-usage.js";
import { markLoadedToolNamesDiscovered } from "../tools/deferred-discovery.js";
import { classifyUntrustedToolResult } from "../tools/untrusted-tool-result-framing.js";
import { createToolResultIntegrity } from "./tool-result-integrity.js";
import { toolResultMessage } from "../phases/execute-tools.js";
/** One-shot bypass turn loop. Session data is finalized once at the terminal boundary. */
import { requiresAtomicSpendAdmission } from "../one-shot-fast-mode.js";
import { createFastContextGuard } from "./fast-context-guard.js";
import type { EventMsg } from "./event-log.js";
import type { LLMMessage, LLMUsage, LLMResponse } from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { assistantMessageFromResponse, buildProviderOptions } from "../phases/stream-model.js";
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
): AsyncGenerator<PhaseEvent, Terminal | { reason: "continue_normal"; modelCalls: number; usage: LLMUsage; lastResponseUsage?: LLMUsage; recoveryResponse?: LLMResponse }> {
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
  const tracker = createTurnDiffTracker();
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
        // prepareRequest owns a fresh canonical snapshot. This loop uses it
        // once; transfer its already-cloned schemas instead of cloning twice.
        options = buildProviderOptions(prepared.request, prepared.samplingContext, signal, session, true);
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
      if (response.finishReason !== undefined && response.finishReason !== "stop" && response.finishReason !== "tool_calls") {
        // The response was already paid for. Transfer it before any tool dispatch
        // or completion publication; canonical recovery owns the next decision.
        handoff = true;
        return { reason: "continue_normal", modelCalls, usage, lastResponseUsage, recoveryResponse: response };
      }
      const toolCalls = response.finishReason === undefined ? response.toolCalls
        : assistantMessageFromResponse(response, false, session.services.provider.name).toolCalls
          .map(call => validateToolCall(call) ?? call);
      messages.push({ role: "assistant", content: response.content,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(response.providerReasoningContent !== undefined ? { providerReasoningContent: response.providerReasoningContent } : {}),
        ...(response.providerReasoningProvenance !== undefined ? { providerReasoningProvenance: response.providerReasoningProvenance } : {}),
      });
      if (toolCalls.length === 0) {
        if (response.content) {
          session.emit({ id: session.nextInternalSubId(), msg: { type: "agent_message", payload: { message: response.content } } });
          yield { type: "assistant_text", content: response.content };
        }
        yield { type: "turn_complete", content: response.content, usage, stopReason: "completed" };
        return { reason: "completed" };
      }
      for (const call of toolCalls) {
        signal.throwIfAborted();
        let tool: Tool | undefined;
        let content: string;
        let modelMessage: LLMMessage | undefined;
        let isError = false;
        let metadata: Record<string, unknown> | undefined;
        const started = performance.now();
        observations.push({ type: "tool_call_started", payload: { callId: call.id, toolName: call.name, args: call.arguments } });
        try {
          const result = await session.services.registry.dispatch(call, {
            prepareArguments: (args, selectedTool) => {
              tool = selectedTool;
              const projected = filesystemRootsForDispatch(call.name, stripModelSuppliedAgenCInternalArgs(args), {
                approvalResolved: false, sandboxMode: ctx.sandboxPolicy.value, session,
              });
              const authority = sessionDispatchAuthority(session, session.services.configStore?.homeContext.path, true);
              authority.__onProgress = (event: { chunk: string; stream?: "stdout" | "stderr" }) => {
                  observations.push({ type: "tool_progress", payload: {
                    callId: call.id, toolName: call.name, ...event,
                  } });
              };
              for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(authority))) {
                Object.defineProperty(projected, key, { ...descriptor, enumerable: false });
              }
              if (tool !== undefined && ctx.approvalPolicy !== undefined && ctx.sandboxPolicy !== undefined) {
                // Tool implementations consult this authenticated invocation
                // for current permission mode, protected roots and ownership.
                // Attach the canonical context without rebuilding preflight.
                attachPreflightRuntimeContext(tool, projected, {
                  session, turn: ctx, tracker, callId: call.id, toolName: parseToolName(call.name),
                  payload: { kind: "function", arguments: call.arguments }, source: "direct",
                }, { approvalPolicy: ctx.approvalPolicy.value, sandboxMode: ctx.sandboxPolicy.value });
              }
              return projected;
            },
            abortSignal: signal, advertisedToolNames: options.tools?.map(tool => tool.function.name),
          });
          content = result.content;
          metadata = result.metadata;
          markLoadedToolNamesDiscovered(call.name, result, session.services.registry.getDiscoveredToolNames?.());
          modelMessage = toolResultMessage(session.conversationId, call.id, call.name, result,
            classifyUntrustedToolResult(call.name, tool), session.services.runtimeOptions?.lightMode === true, true);
          isError = result.isError === true;
        } catch (error) {
          signal.throwIfAborted();
          isError = true;
          content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
        const elapsed = performance.now() - started;
        const validationOnly = metadata?.kind === "input_validation";
        if (validationOnly) metadata = { ...metadata, validationDurationMs: elapsed };
        observations.push({ type: "tool_call_completed", payload: {
          callId: call.id, toolName: call.name, result: content, isError, ...(metadata ? { metadata } : {}), durationMs: validationOnly ? 0 : elapsed,
        } });
        messages.push(modelMessage ?? { role: "tool", toolName: call.name, toolCallId: call.id, content });
      }
      // Canonical preparation refreshes discovery and its guard on the next
      // iteration. Standalone callers still need this explicit refresh.
      if (!prepareRequest) {
        const tools = builtTools(session, ctx);
        if (JSON.stringify(tools) !== JSON.stringify(options.tools)) {
          options = { ...options, tools, toolRouting: { allowedToolNames: tools.map(tool => tool.function.name) } };
          fits = createFastContextGuard(options);
        }
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
