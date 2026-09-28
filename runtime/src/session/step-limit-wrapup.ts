import type { LLMMessage, LLMToolCall, LLMUsage } from "../llm/types.js";
import { runAdmittedModelCall } from "../budget/admitted-model-call.js";
import { buildProviderOptions, type StreamModelRequestContract } from "../phases/stream-model.js";
import type { Session } from "./session.js";
import { usageToTokenCountEvent } from "./event-log.js";
import type { TurnContext } from "./turn-context.js";
import { sanitizeModelOutput } from "../llm/stream-parser.js";

export const STEP_LIMIT_WRAPUP_TIMEOUT_MS = 30_000;
export const STEP_LIMIT_WRAPUP_INSTRUCTION =
  "You have reached the step limit. Stop investigating. Write the final answer now from what you found, " +
  "including findings and conclusions. Say what you could not check. Tools are unavailable.";

function boundedText(text: string, bytes: number): string {
  return Buffer.from(text).subarray(0, bytes).toString("utf8");
}

/** Retain a small recent activity trail independently of context compaction. */
export class StepLimitTrail {
  private readonly entries: string[] = [];
  record(call: LLMToolCall): void {
    this.entries.push(`${boundedText(call.name, 80)} ${boundedText(call.arguments.replace(/\s+/g, " "), 160)}`);
    if (this.entries.length > 12) this.entries.shift();
  }
  fallback(lastText: string): string {
    return [
      "Partial result: stopped at the step limit. Final-answer synthesis was unavailable.",
      boundedText(lastText.trim(), 4_000) || "No assistant findings were recorded.",
      "Recent tool activity (arguments abbreviated):",
      ...this.entries.map((entry) => `- ${entry}`),
      "Unchecked work: the task is incomplete; tool activity alone does not establish findings.",
    ].join("\n");
  }
}

export function stepLimitReminder(completed: number, limit: number): LLMMessage | undefined {
  if (!Number.isFinite(limit) || completed < 1 || completed >= limit) return undefined;
  const remaining = limit - completed;
  if (completed !== Math.ceil(limit * 0.75) && remaining !== 2) return undefined;
  return {
    role: "user",
    content: `Step budget: ${remaining} of ${limit} investigation steps remain. Prioritize your findings and finish your answer; state anything you could not check.`,
    runtimeOnly: { excludeFromDurableHistory: true },
  };
}

/** One admitted wire attempt. No tool executor, retry ladder, or compaction. */
export async function stepLimitWrapup(args: {
  session: Session;
  ctx: TurnContext;
  request: StreamModelRequestContract;
  signal: AbortSignal;
  fallback: string;
}): Promise<{ text: string; usage?: LLMUsage }> {
  const { session, ctx, signal, fallback } = args;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new Error("step-limit wrap-up timed out")), STEP_LIMIT_WRAPUP_TIMEOUT_MS);
  let rejectAbort: (() => void) | undefined;
  try {
    if (controller.signal.aborted) return { text: fallback };
    const request: StreamModelRequestContract = {
      ...args.request,
      tools: [],
      toolChoice: "none",
      parallelToolCalls: false,
      maxOutputTokens: Math.min(args.request.maxOutputTokens ?? 4096, 4096),
    };
    const messages = [...request.input];
    const options = {
      ...buildProviderOptions(request, ctx, controller.signal, session),
      singleWireAttempt: true,
      timeoutMs: STEP_LIMIT_WRAPUP_TIMEOUT_MS,
    };
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const response = await Promise.race([runAdmittedModelCall({
      session, provider: session.services.provider, messages, options,
      stepId: `${ctx.subId}:step-limit-wrapup`,
      sessionId: session.conversationId,
      model: session.config?.model ?? ctx.config.model,
      providerName: session.services.provider.name,
      signal: controller.signal,
      invoke: (admitted) => session.services.provider.chatStream(messages, () => {}, admitted),
    }), aborted]);
    if (response.usage) {
      const event = usageToTokenCountEvent(response.usage);
      if (event.type === "token_count") {
        session.emit({ id: session.nextInternalSubId(), msg: {
          ...event, payload: { ...event.payload,
            ...(response.usage.speed === "fast" ? { speed: "fast" as const } : {}),
            model: response.model, provider: session.services.provider.name },
        } });
      }
    }
    const text = response.error || response.toolCalls?.length
      ? "" : sanitizeModelOutput(response.content ?? "", { strict: true }).text.trim();
    return { text: text ? `Partial result: stopped at the step limit.\n\n${text}` : fallback,
      ...(response.usage ? { usage: response.usage } : {}) };
  } catch {
    return { text: fallback };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}
