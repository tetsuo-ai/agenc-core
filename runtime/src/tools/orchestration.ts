/**
 * Tool-batch orchestration helpers for the AgenC tools runtime.
 *
 * @module
 */

import type { LLMToolCall } from "../llm/types.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { ToolUseBlock } from "../session/turn-state.js";
import {
  StreamingToolExecutor,
  type StreamingToolExecutorOptions,
  type StreamingToolUpdate,
} from "./streaming-executor.js";
import { validateToolArgs } from "./execution.js";
import type { Tool } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Concurrency cap
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10;

export function resolveMaxToolUseConcurrency(): number {
  const raw = process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
  if (!raw) return DEFAULT_MAX_TOOL_USE_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOOL_USE_CONCURRENCY;
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────
// Batch partitioning
// ─────────────────────────────────────────────────────────────────────

export interface ToolBatch {
  readonly isConcurrencySafe: boolean;
  readonly blocks: readonly ToolUseBlock[];
}

function inputRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function toolIsConcurrencySafe(
  tool: Tool | undefined,
  input: unknown,
): boolean {
  const parsedInput = inputRecord(input);
  if (!tool || !parsedInput || !tool.isConcurrencySafe) return false;
  const schemaResult = validateToolArgs(
    tool.inputSchema as Record<string, unknown> | undefined,
    parsedInput,
  );
  if (!schemaResult.valid) return false;
  try {
    return Boolean(tool.isConcurrencySafe(parsedInput));
  } catch {
    return false;
  }
}

/**
 * Partition tool-use blocks into consecutive safe batches and single
 * exclusive blocks. This mirrors the service-level orchestration rule:
 * only blocks whose own tool definition marks the parsed invocation
 * concurrency-safe can share a batch.
 */
export function partitionToolCalls(
  toolUseBlocks: readonly ToolUseBlock[],
  registry: Pick<ToolRegistry, "tools">,
): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const block of toolUseBlocks) {
    const tool = registry.tools.find((candidate) => candidate.name === block.name);
    const safe = toolIsConcurrencySafe(tool as Tool | undefined, block.input);
    const last = batches.at(-1);
    if (safe && last?.isConcurrencySafe) {
      batches[batches.length - 1] = {
        isConcurrencySafe: true,
        blocks: [...last.blocks, block],
      };
    } else {
      batches.push({ isConcurrencySafe: safe, blocks: [block] });
    }
  }
  return batches;
}

// ─────────────────────────────────────────────────────────────────────
// runTools
// ─────────────────────────────────────────────────────────────────────

export interface RunToolsUpdate<TContext> {
  readonly update?: StreamingToolUpdate;
  readonly newContext: TContext;
}

export interface RunToolsOptions<TContext>
  extends Omit<StreamingToolExecutorOptions, "registry" | "maxConcurrency"> {
  readonly registry: ToolRegistry;
  readonly initialContext: TContext;
  readonly maxConcurrency?: number;
  readonly setInProgressToolUseIds?: (
    update: (prev: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
  readonly contextModifierForUpdate?: (
    update: StreamingToolUpdate,
  ) => ((context: TContext) => TContext) | null | undefined;
}

function serializeToolInput(input: unknown): string {
  try {
    const serialized = JSON.stringify(input ?? {});
    return serialized === undefined ? "{}" : serialized;
  } catch {
    return "{}";
  }
}

function toolCallFromBlock(
  block: ToolUseBlock,
  supplied: ReadonlyMap<string, LLMToolCall>,
): LLMToolCall {
  const existing = supplied.get(block.id);
  if (existing) return existing;
  return {
    id: block.id,
    name: block.name,
    arguments: serializeToolInput(block.input),
  };
}

function updateInProgress<TContext>(
  opts: RunToolsOptions<TContext>,
  id: string,
  action: "add" | "delete",
): void {
  opts.setInProgressToolUseIds?.((prev) => {
    const next = new Set(prev);
    if (action === "add") next.add(id);
    else next.delete(id);
    return next;
  });
}

function buildExecutor<TContext>(
  opts: RunToolsOptions<TContext>,
): StreamingToolExecutor {
  return new StreamingToolExecutor({
    ...opts,
    registry: opts.registry,
    maxConcurrency:
      opts.maxConcurrency ?? resolveMaxToolUseConcurrency(),
  });
}

/**
 * Execute a completed set of tool-use blocks in the same high-level
 * shape as the service orchestration path: consecutive safe blocks run
 * in one concurrent batch, exclusive blocks run serially, in-progress
 * IDs are marked around execution, and context modifiers from a safe
 * batch are deferred until every block in that batch has drained.
 */
export async function* runTools<TContext>(
  toolUseBlocks: readonly ToolUseBlock[],
  toolCalls: readonly LLMToolCall[],
  opts: RunToolsOptions<TContext>,
): AsyncGenerator<RunToolsUpdate<TContext>, TContext> {
  let currentContext = opts.initialContext;
  const callsById = new Map(toolCalls.map((call) => [call.id, call] as const));

  for (const batch of partitionToolCalls(toolUseBlocks, opts.registry)) {
    if (batch.isConcurrencySafe) {
      const executor = buildExecutor(opts);
      const queuedModifiers = new Map<
        string,
        Array<(context: TContext) => TContext>
      >();

      for (const block of batch.blocks) {
        updateInProgress(opts, block.id, "add");
        executor.addTool(block, toolCallFromBlock(block, callsById));
      }
      executor.close();

      for await (const update of executor.getRemainingUpdates()) {
        if (update.kind === "result") {
          updateInProgress(opts, update.result.toolCall.id, "delete");
        }
        const modifier = opts.contextModifierForUpdate?.(update);
        if (modifier && update.kind === "result") {
          const id = update.result.toolCall.id;
          const existing = queuedModifiers.get(id) ?? [];
          queuedModifiers.set(id, [...existing, modifier]);
        }
        yield { update, newContext: currentContext };
      }

      for (const block of batch.blocks) {
        const modifiers = queuedModifiers.get(block.id);
        if (!modifiers) continue;
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext);
        }
      }
      yield { newContext: currentContext };
      continue;
    }

    for (const block of batch.blocks) {
      const executor = buildExecutor(opts);
      updateInProgress(opts, block.id, "add");
      executor.addTool(block, toolCallFromBlock(block, callsById));
      executor.close();

      for await (const update of executor.getRemainingUpdates()) {
        if (update.kind === "result") {
          updateInProgress(opts, update.result.toolCall.id, "delete");
        }
        const modifier = opts.contextModifierForUpdate?.(update);
        if (modifier) currentContext = modifier(currentContext);
        yield { update, newContext: currentContext };
      }
    }
  }

  return currentContext;
}
