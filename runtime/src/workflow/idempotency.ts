import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface EffectExecutionContext {
  readonly idempotencyKey?: string;
  readonly pipelineId?: string;
  readonly stepName?: string;
  readonly stepIndex?: number;
  readonly runId?: string;
  readonly channel?: string;
}

const effectExecutionContextStore =
  new AsyncLocalStorage<EffectExecutionContext>();

export function runWithEffectExecutionContext<T>(
  context: EffectExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return effectExecutionContextStore.run(context, fn);
}

export function getCurrentEffectExecutionContext():
  | EffectExecutionContext
  | undefined {
  return effectExecutionContextStore.getStore();
}

export function buildPipelineEffectIdempotencyKey(params: {
  readonly pipelineId: string;
  readonly stepName: string;
  readonly stepIndex: number;
}): string {
  return `pipeline:${params.pipelineId}:step:${params.stepIndex}:${params.stepName}`;
}

export function deriveEffectIdempotencyKey(params: {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: Record<string, unknown>;
  readonly executionContext?: EffectExecutionContext;
}): string {
  if (params.executionContext?.idempotencyKey) {
    return params.executionContext.idempotencyKey;
  }

  const toolProvidedIdempotencyKey =
    typeof params.args.idempotencyKey === "string" &&
    params.args.idempotencyKey.trim().length > 0
      ? params.args.idempotencyKey.trim()
      : undefined;
  if (toolProvidedIdempotencyKey) {
    return `${params.toolName}:${toolProvidedIdempotencyKey}`;
  }

  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: params.sessionId,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        args: params.args,
      }),
    )
    .digest("hex");
  return `tool:${digest}`;
}

