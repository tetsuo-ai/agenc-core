import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PipelineExecutor,
  type Pipeline,
  type PipelineStep,
  type PipelineExecutorConfig,
} from "./pipeline.js";
import type { MemoryBackend } from "../memory/types.js";
import type { ApprovalEngine } from "../gateway/approvals.js";
import type { ProgressTracker } from "../gateway/progress.js";
import { createMockMemoryBackend } from "../memory/test-utils.js";
import { WorkflowStateError } from "./errors.js";
import { RuntimeSchemaCompatibilityError } from "./schema-version.js";

// ============================================================================
// Helpers
// ============================================================================

function createMockToolHandler(
  results: Record<string, string> = {},
  errors: Record<string, Error> = {},
): (name: string, args: Record<string, unknown>) => Promise<string> {
  return vi.fn(async (name: string) => {
    if (errors[name]) throw errors[name];
    return results[name] ?? `result-of-${name}`;
  });
}

function createPipeline(
  steps: PipelineStep[],
  id = "test-pipeline",
): Pipeline {
  return {
    id,
    steps,
    context: { results: {} },
    createdAt: Date.now(),
  };
}

function createExecutor(
  overrides: Partial<PipelineExecutorConfig> = {},
): PipelineExecutor {
  return new PipelineExecutor({
    toolHandler: createMockToolHandler(),
    memoryBackend: createMockMemoryBackend(),
    ...overrides,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("PipelineExecutor", () => {
  describe("execute()", () => {
    it("executes all steps and returns completed", async () => {
      const handler = createMockToolHandler({
        "system.bash": "file1.ts",
        "system.http": '{"ok":true}',
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "list", tool: "system.bash", args: { command: "ls" } },
        { name: "fetch", tool: "system.http", args: { url: "http://x" } },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.completedSteps).toBe(2);
      expect(result.totalSteps).toBe(2);
      expect(result.context.results["list"]).toBe("file1.ts");
      expect(result.context.results["fetch"]).toBe('{"ok":true}');
    });

    it("uses per-execution tool handler override when provided", async () => {
      const baseHandler = createMockToolHandler({ "tool.a": "base-result" });
      const overrideHandler = vi
        .fn()
        .mockResolvedValue("override-result");
      const executor = createExecutor({ toolHandler: baseHandler });
      const pipeline = createPipeline([
        { name: "step-a", tool: "tool.a", args: {} },
      ]);

      const result = await executor.execute(pipeline, 0, {
        toolHandler: overrideHandler,
      });

      expect(result.status).toBe("completed");
      expect(result.context.results["step-a"]).toBe("override-result");
      expect(overrideHandler).toHaveBeenCalledWith("tool.a", {});
      expect(baseHandler).not.toHaveBeenCalled();
    });

    it("emits step execution events for deterministic observability", async () => {
      const events: Array<Record<string, unknown>> = [];
      const handler = createMockToolHandler({
        "tool.a": "a-result",
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "step-a", tool: "tool.a", args: { value: 1 } },
      ]);

      const result = await executor.execute(pipeline, 0, {
        onEvent: (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
      });

      expect(result.status).toBe("completed");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "step_state_changed",
            pipelineId: "test-pipeline",
            stepName: "step-a",
            state: "running",
            tool: "tool.a",
            args: { value: 1 },
          }),
          expect.objectContaining({
            type: "step_started",
            pipelineId: "test-pipeline",
            stepName: "step-a",
            tool: "tool.a",
            args: { value: 1 },
          }),
          expect.objectContaining({
            type: "step_finished",
            pipelineId: "test-pipeline",
            stepName: "step-a",
            tool: "tool.a",
            args: { value: 1 },
            result: "a-result",
          }),
          expect.objectContaining({
            type: "step_state_changed",
            pipelineId: "test-pipeline",
            stepName: "step-a",
            state: "completed",
            previousState: "running",
            tool: "tool.a",
            args: { value: 1 },
          }),
        ]),
      );
    });

    it("returns failed on tool error with abort policy", async () => {
      const handler = createMockToolHandler(
        {},
        { "system.bash": new Error("command not found") },
      );
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "run", tool: "system.bash", args: { command: "bad" } },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("command not found");
      expect(result.completedSteps).toBe(0);
    });

    it("returns failed when a resolved tool result reports a timeout", async () => {
      const handler = createMockToolHandler({
        "system.bash":
          '{"exitCode":null,"timedOut":true,"stdout":"FAIL  Tests failed. Watching for file changes...","stderr":"Error: No path found"}',
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "run", tool: "system.bash", args: { command: "npm", args: ["test"] } },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Tool timed out before completing.");
      expect(result.error).toContain("Error: No path found");
      expect(result.completedSteps).toBe(0);
    });

    it("emits raw result and semantic error when a deterministic step fails", async () => {
      const events: Array<Record<string, unknown>> = [];
      const handler = createMockToolHandler({
        "system.bash":
          '{"exitCode":null,"timedOut":true,"stdout":"FAIL  Tests failed. Watching for file changes...","stderr":"Error: No path found"}',
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "run", tool: "system.bash", args: { command: "npm", args: ["test"] } },
      ]);

      await executor.execute(pipeline, 0, {
        onEvent: (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
      });

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "step_finished",
            stepName: "run",
            result:
              '{"exitCode":null,"timedOut":true,"stdout":"FAIL  Tests failed. Watching for file changes...","stderr":"Error: No path found"}',
            error: expect.stringContaining("Tool timed out before completing."),
          }),
        ]),
      );
    });

    it("skips failed step with skip policy", async () => {
      const handler = createMockToolHandler(
        { "tool.b": "b-result" },
        { "tool.a": new Error("a failed") },
      );
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "step-a", tool: "tool.a", args: {}, onError: "skip" },
        { name: "step-b", tool: "tool.b", args: {} },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.completedSteps).toBe(2);
      expect(result.context.results["step-a"]).toContain("SKIPPED");
      expect(result.context.results["step-b"]).toBe("b-result");
    });

    it("retries on failure with retry policy", async () => {
      let callCount = 0;
      const handler = vi.fn(async () => {
        callCount++;
        if (callCount <= 1) throw new Error("transient");
        return "success";
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "flaky", tool: "flaky", args: {}, onError: "retry", maxRetries: 2 },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.context.results["flaky"]).toBe("success");
    });

    it("fails after exhausting retries", async () => {
      const events: Array<Record<string, unknown>> = [];
      const handler = vi.fn(async () => {
        throw new Error("always fails");
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "bad", tool: "bad", args: {}, onError: "retry", maxRetries: 2 },
      ]);

      const result = await executor.execute(pipeline, 0, {
        onEvent: (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
      });

      expect(result.status).toBe("failed");
      // Initial call + 2 retries = 3 total calls
      expect(handler).toHaveBeenCalledTimes(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "step_state_changed",
            stepName: "bad",
            state: "retry_pending",
          }),
          expect.objectContaining({
            type: "step_state_changed",
            stepName: "bad",
            state: "failed",
            previousState: "running",
          }),
        ]),
      );
    });

    it("rejects concurrent execution of same pipeline", async () => {
      let resolveFirst: (() => void) | undefined;
      const handler = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = () => resolve("done");
          }),
      );
      const executor = createExecutor({ toolHandler: handler });
      const pipeline = createPipeline([
        { name: "slow", tool: "slow", args: {} },
      ]);

      // Start first execution (don't await — it will block on the handler)
      const firstPromise = executor.execute(pipeline);
      // Give the event loop time to enter the handler
      await new Promise((r) => setTimeout(r, 10));

      // Second execution should fail immediately
      const second = await executor.execute(pipeline);

      expect(second.status).toBe("failed");
      expect(second.error).toContain("already running");

      // Clean up: resolve the first execution
      resolveFirst?.();
      await firstPromise;
    });

    it("halts when step requires approval and rule matches", async () => {
      const events: Array<Record<string, unknown>> = [];
      const approvalEngine = {
        requiresApproval: vi.fn().mockReturnValue({ tool: "wallet.*", description: "needs approval" }),
      } as unknown as ApprovalEngine;
      const handler = createMockToolHandler();
      const executor = createExecutor({ toolHandler: handler, approvalEngine });
      const pipeline = createPipeline([
        { name: "safe", tool: "system.bash", args: {} },
        { name: "dangerous", tool: "wallet.sign", args: {}, requiresApproval: true },
      ]);

      const result = await executor.execute(pipeline, 0, {
        onEvent: (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
      });

      expect(result.status).toBe("halted");
      expect(result.resumeFrom).toBe(1);
      expect(result.completedSteps).toBe(1);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "step_state_changed",
            stepName: "dangerous",
            state: "blocked_on_approval",
            reason: 'Approval required for tool "wallet.sign"',
          }),
        ]),
      );
    });

    it("continues when requiresApproval but no matching rule", async () => {
      const approvalEngine = {
        requiresApproval: vi.fn().mockReturnValue(null),
      } as unknown as ApprovalEngine;
      const handler = createMockToolHandler();
      const executor = createExecutor({ toolHandler: handler, approvalEngine });
      const pipeline = createPipeline([
        { name: "step", tool: "safe.tool", args: {}, requiresApproval: true },
      ]);

      const result = await executor.execute(pipeline);

      expect(result.status).toBe("completed");
    });

    it("saves checkpoints during execution", async () => {
      const backend = createMockMemoryBackend();
      const handler = createMockToolHandler();
      const executor = createExecutor({ toolHandler: handler, memoryBackend: backend });
      const pipeline = createPipeline([
        { name: "a", tool: "tool.a", args: {} },
        { name: "b", tool: "tool.b", args: {} },
      ]);

      await executor.execute(pipeline);

      // Checkpoint set for each step (running) then deleted on completion
      expect(backend.set).toHaveBeenCalled();
      expect(backend.delete).toHaveBeenCalledWith("pipeline:test-pipeline");
    });

    it("starts from a given step index", async () => {
      const handler = createMockToolHandler({
        "tool.b": "b-result",
      });
      const executor = createExecutor({ toolHandler: handler });
      const pipeline: Pipeline = {
        id: "resume-test",
        steps: [
          { name: "a", tool: "tool.a", args: {} },
          { name: "b", tool: "tool.b", args: {} },
        ],
        context: { results: { a: "already-done" } },
        createdAt: Date.now(),
      };

      const result = await executor.execute(pipeline, 1);

      expect(result.status).toBe("completed");
      expect(result.completedSteps).toBe(2);
      expect(result.context.results["a"]).toBe("already-done");
      expect(result.context.results["b"]).toBe("b-result");
    });

    it("tracks progress when progressTracker is provided", async () => {
      const progressTracker = {
        append: vi.fn(),
      } as unknown as ProgressTracker;
      const handler = createMockToolHandler();
      const executor = createExecutor({
        toolHandler: handler,
        progressTracker,
      });
      const pipeline = createPipeline([
        { name: "step1", tool: "tool", args: {} },
      ]);

      await executor.execute(pipeline);

      expect(progressTracker.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "task_completed",
          summary: expect.stringContaining("step1"),
        }),
      );
    });
  });

  describe("resume()", () => {
    it("resumes from checkpoint", async () => {
      const backend = createMockMemoryBackend();
      const handler = createMockToolHandler({ "tool.b": "resumed-b" });
      const executor = createExecutor({
        toolHandler: handler,
        memoryBackend: backend,
      });
      const updatedAt = Date.now();

      // Manually insert a checkpoint
      await backend.set("pipeline:p1", {
        schemaVersion: 1,
        pipelineId: "p1",
        pipeline: {
          id: "p1",
          steps: [
            { name: "a", tool: "tool.a", args: {} },
            { name: "b", tool: "tool.b", args: {} },
          ],
          context: { results: {} },
          createdAt: Date.now(),
        },
        stepIndex: 1,
        context: { results: { a: "old-a" } },
        status: "halted",
        updatedAt,
        provenance: {
          schemaVersion: 1,
          source: "live_runtime",
          trust: "trusted",
          recordedAt: updatedAt,
        },
      });

      const result = await executor.resume("p1");

      expect(result.status).toBe("completed");
      expect(result.context.results["a"]).toBe("old-a");
      expect(result.context.results["b"]).toBe("resumed-b");
    });

    it("migrates legacy unversioned checkpoints during listing and rewrites them with schema versions", async () => {
      const backend = createMockMemoryBackend();
      const executor = createExecutor({
        memoryBackend: backend,
      });
      const updatedAt = Date.now();

      await backend.set("pipeline:p-migrate", {
        pipelineId: "p-migrate",
        pipeline: {
          id: "p-migrate",
          steps: [
            { name: "a", tool: "tool.a", args: {} },
            { name: "b", tool: "tool.b", args: {} },
          ],
          context: { results: {} },
          createdAt: Date.now(),
        },
        stepIndex: 1,
        context: { results: { a: "old-a" } },
        status: "halted",
        updatedAt,
      });

      (executor as unknown as { active: Set<string> }).active.add("p-migrate");
      const active = await executor.listActive();
      expect(active).toHaveLength(1);
      expect(active[0]?.provenance?.trust).toBe("needs_revalidation");
      const persisted = await backend.get<{ schemaVersion?: number }>(
        "pipeline:p-migrate",
      );
      expect(persisted?.schemaVersion).toBe(1);
    });

    it("rejects migrated checkpoints before resume and persists revalidation provenance", async () => {
      const backend = createMockMemoryBackend();
      const executor = createExecutor({ memoryBackend: backend });

      await backend.set("pipeline:p-legacy", {
        pipelineId: "p-legacy",
        pipeline: {
          id: "p-legacy",
          steps: [
            { name: "a", tool: "tool.a", args: {} },
            { name: "b", tool: "tool.b", args: {} },
          ],
          context: { results: {} },
          createdAt: Date.now(),
        },
        stepIndex: 1,
        context: { results: { a: "old-a" } },
        status: "halted",
        updatedAt: Date.now(),
      });

      await expect(executor.resume("p-legacy")).rejects.toBeInstanceOf(
        WorkflowStateError,
      );
      await expect(executor.resume("p-legacy")).rejects.toThrow(
        /requires provenance revalidation before resume/,
      );

      const persisted = await backend.get<{
        schemaVersion?: number;
        provenance?: {
          trust?: string;
          source?: string;
          reasons?: readonly string[];
        };
      }>("pipeline:p-legacy");
      expect(persisted?.schemaVersion).toBe(1);
      expect(persisted?.provenance?.source).toBe("migrated_checkpoint");
      expect(persisted?.provenance?.trust).toBe("needs_revalidation");
      expect(persisted?.provenance?.reasons).toContain("schema_migrated");
    });

    it("fails loudly when a persisted checkpoint uses an unsupported schema version", async () => {
      const backend = createMockMemoryBackend();
      const executor = createExecutor({ memoryBackend: backend });

      await backend.set("pipeline:p-bad", {
        schemaVersion: 999,
        pipelineId: "p-bad",
        pipeline: {
          id: "p-bad",
          steps: [{ name: "a", tool: "tool.a", args: {} }],
          context: { results: {} },
          createdAt: Date.now(),
        },
        stepIndex: 0,
        context: { results: {} },
        status: "halted",
        updatedAt: Date.now(),
      });

      await expect(executor.resume("p-bad")).rejects.toBeInstanceOf(
        RuntimeSchemaCompatibilityError,
      );
    });

    it("throws WorkflowStateError when no checkpoint found", async () => {
      const executor = createExecutor();

      await expect(executor.resume("nonexistent")).rejects.toThrow(
        /No checkpoint found/,
      );
    });

    it("uses per-execution tool handler override during resume", async () => {
      const backend = createMockMemoryBackend();
      const baseHandler = createMockToolHandler({ "tool.b": "base-b" });
      const overrideHandler = vi.fn().mockResolvedValue("override-b");
      const executor = createExecutor({
        toolHandler: baseHandler,
        memoryBackend: backend,
      });
      const updatedAt = Date.now();

      await backend.set("pipeline:p2", {
        schemaVersion: 1,
        pipelineId: "p2",
        pipeline: {
          id: "p2",
          steps: [
            { name: "a", tool: "tool.a", args: {} },
            { name: "b", tool: "tool.b", args: {} },
          ],
          context: { results: {} },
          createdAt: Date.now(),
        },
        stepIndex: 1,
        context: { results: { a: "old-a" } },
        status: "halted",
        updatedAt,
        provenance: {
          schemaVersion: 1,
          source: "live_runtime",
          trust: "trusted",
          recordedAt: updatedAt,
        },
      });

      const result = await executor.resume("p2", {
        toolHandler: overrideHandler,
      });

      expect(result.status).toBe("completed");
      expect(result.context.results["b"]).toBe("override-b");
      expect(overrideHandler).toHaveBeenCalledWith("tool.b", {});
      expect(baseHandler).not.toHaveBeenCalled();
    });

    it("emits resumed lifecycle state when continuing from a checkpoint", async () => {
      const backend = createMockMemoryBackend();
      const events: Array<Record<string, unknown>> = [];
      const handler = createMockToolHandler({ "tool.b": "resumed-b" });
      const executor = createExecutor({
        toolHandler: handler,
        memoryBackend: backend,
      });
      const updatedAt = Date.now();

      await backend.set("pipeline:p3", {
        schemaVersion: 1,
        pipelineId: "p3",
        pipeline: {
          id: "p3",
          steps: [
            { name: "a", tool: "tool.a", args: {} },
            { name: "b", tool: "tool.b", args: {} },
          ],
          context: { results: {} },
          createdAt: Date.now(),
        },
        stepIndex: 1,
        context: { results: { a: "old-a" } },
        status: "halted",
        updatedAt,
        provenance: {
          schemaVersion: 1,
          source: "live_runtime",
          trust: "trusted",
          recordedAt: updatedAt,
        },
      });

      await executor.resume("p3", {
        onEvent: (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
      });

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "step_state_changed",
            pipelineId: "p3",
            stepName: "b",
            state: "resumed",
            reason: "Resumed deterministic execution from step 2",
          }),
        ]),
      );
    });
  });

  describe("listActive()", () => {
    it("returns empty when no pipelines active", async () => {
      const executor = createExecutor();
      const active = await executor.listActive();
      expect(active).toEqual([]);
    });
  });

  describe("remove()", () => {
    it("removes checkpoint and clears from active set", async () => {
      const backend = createMockMemoryBackend();
      const executor = createExecutor({ memoryBackend: backend });

      // Execute a pipeline to make it active, then remove
      let resolveHandler: (() => void) | undefined;
      const slowExecutor = createExecutor({
        memoryBackend: backend,
        toolHandler: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              resolveHandler = () => resolve("done");
            }),
        ),
      });
      const pipeline = createPipeline([
        { name: "slow", tool: "slow", args: {} },
      ], "removable");

      const execPromise = slowExecutor.execute(pipeline);
      // Let the executor start running
      await new Promise((r) => setTimeout(r, 10));
      await slowExecutor.remove("removable");
      resolveHandler?.();
      await execPromise;

      expect(backend.delete).toHaveBeenCalledWith("pipeline:removable");
    });
  });
});
