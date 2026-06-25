import {
  EXCLUSIVE,
  ToolCallRuntime,
  type ConcurrencyClass,
  type GuardedFn,
  type ToolCallRuntimeOpts,
} from "../concurrency.js";
import type { ToolRuntimeCallContext } from "./context.js";

export interface ToolRuntimeScheduler {
  run<T>(
    klass: ConcurrencyClass,
    fn: GuardedFn<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  runToolCall<T>(
    context: ToolRuntimeCallContext,
    fn: GuardedFn<T>,
  ): Promise<T>;
}

export interface ToolExecutionRuntimeOptions extends ToolCallRuntimeOpts {
  readonly guard?: ToolCallRuntime;
}

export class ToolExecutionRuntime implements ToolRuntimeScheduler {
  private readonly guard: ToolCallRuntime;

  constructor(options: ToolExecutionRuntimeOptions = {}) {
    this.guard = options.guard ?? new ToolCallRuntime(options);
  }

  async run<T>(
    klass: ConcurrencyClass,
    fn: GuardedFn<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.guard.run(klass, fn, signal);
  }

  async runToolCall<T>(
    context: ToolRuntimeCallContext,
    fn: GuardedFn<T>,
  ): Promise<T> {
    return this.guard.run(
      effectiveConcurrencyClass(context),
      fn,
      context.acquireSignal,
    );
  }
}

export function createToolExecutionRuntime(
  options: ToolExecutionRuntimeOptions = {},
): ToolExecutionRuntime {
  return new ToolExecutionRuntime(options);
}

export async function runToolRuntimeCall<T>(
  runtime: ToolRuntimeScheduler | ToolCallRuntime,
  context: ToolRuntimeCallContext,
  fn: GuardedFn<T>,
): Promise<T> {
  if ("runToolCall" in runtime) {
    return runtime.runToolCall(context, fn);
  }
  return runtime.run(
    effectiveConcurrencyClass(context),
    fn,
    context.acquireSignal,
  );
}

function effectiveConcurrencyClass(
  context: ToolRuntimeCallContext,
): ConcurrencyClass {
  if (
    context.supportsParallelToolCalls === false &&
    context.classification.kind !== "background_terminal"
  ) {
    return EXCLUSIVE;
  }
  return context.classification;
}
