import { createHash, randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { runAdmittedToolCall } from "src/budget/admitted-tool-call";
import { EventLog, type Event } from "src/session/event-log";
import type { Session } from "src/session/session";
import { createWriteStdinTool } from "src/tools/system/write-stdin";
import type {
  ExecCommandToolOutput,
  UnifiedExecProcessManagerLike,
} from "src/unified-exec/types";
import { UnifiedExecError } from "src/unified-exec/types";
import { UnifiedExecProcessExitedBeforeWriteError } from "src/unified-exec/process-manager";
import { bindExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";

// gaphunt3 #4: write_stdin must report an error when the underlying PTY
// process was killed by a signal (exitCode === null, no process_id) instead
// of silently reporting success. Mirrors the exec-command discriminator
// (process_id !== undefined => still-alive yielded process; otherwise the
// null exitCode means the process terminated and the call is an error).

function baseOutput(
  overrides: Partial<ExecCommandToolOutput>,
): ExecCommandToolOutput {
  return {
    output: "",
    stdout: "",
    stderr: "",
    exitCode: null,
    exit_code: null,
    durationMs: 1,
    wall_time_seconds: 0.001,
    timedOut: false,
    truncated: false,
    original_token_count: 0,
    ...overrides,
  };
}

function makeManager(
  output: ExecCommandToolOutput,
): UnifiedExecProcessManagerLike {
  return {
    maxTimeoutMs: 30_000,
    execCommand: vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
      async () => output,
    ),
    writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(
      async () => output,
    ),
    closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
  };
}

function admittedWriteStdinHarness(): {
  readonly effectEvents: Event[];
  readonly session: Session;
} {
  const effectEvents: Event[] = [];
  const eventLog = new EventLog();
  eventLog.subscribe((event) => effectEvents.push(event));
  const session = {
    conversationId: `write-stdin-effect-${randomUUID()}`,
    eventLog,
    rolloutStore: { assertToolAdmissionAllowed: vi.fn() },
    emit: (event: Event) => eventLog.emit(event),
    services: { admissionRequired: false },
  } as unknown as Session;
  return { effectEvents, session };
}

describe("write_stdin isError on signal kill (gaphunt3 #4)", () => {
  test("flags a signal-killed process (exitCode null, no process_id) as isError", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({
          exitCode: null,
          exit_code: null,
          // No process_id => process is gone, not yielded.
          process_id: undefined,
          timedOut: false,
        }),
      ),
    }));

    const result = await tool.execute({ session_id: 1, chars: "" });

    // Before the fix this was `undefined` (silent success); after, true.
    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_committed",
      evidenceKind: "provider_receipt",
      evidenceRef: "tool:system.write-stdin:process-exit",
    });
  });

  test("flags a timed-out kill (exitCode null, no process_id, timedOut) as isError", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({
          exitCode: null,
          exit_code: null,
          process_id: undefined,
          timedOut: true,
        }),
      ),
    }));

    const result = await tool.execute({ session_id: 1, chars: "" });

    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_committed",
      evidenceKind: "provider_receipt",
      evidenceRef: "tool:system.write-stdin:process-exit",
    });
  });

  test("does NOT flag a still-alive yielded process (exitCode null, process_id set)", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({
          exitCode: null,
          exit_code: null,
          // process_id present => still alive, can resume via write_stdin.
          process_id: 7,
          timedOut: false,
        }),
      ),
    }));

    const result = await tool.execute({ session_id: 7, chars: "" });

    expect(result.isError).toBeUndefined();
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_committed",
      evidenceKind: "provider_receipt",
      evidenceRef: "tool:system.write-stdin:process-yield",
    });
  });

  test("does NOT flag a clean completion (exitCode 0)", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({ exitCode: 0, exit_code: 0 }),
      ),
    }));

    const result = await tool.execute({ session_id: 1, chars: "" });

    expect(result.isError).toBeUndefined();
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_committed",
      evidenceKind: "provider_receipt",
      evidenceRef: "tool:system.write-stdin:process-exit",
    });
  });

  test("flags a non-zero exit code as isError", async () => {
    const tool = bindExplicitDangerBoundary(createWriteStdinTool({
      unifiedExecManager: makeManager(
        baseOutput({ exitCode: 1, exit_code: 1 }),
      ),
    }));

    const result = await tool.execute({ session_id: 1, chars: "" });

    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_committed",
      evidenceKind: "provider_receipt",
      evidenceRef: "tool:system.write-stdin:process-exit",
    });
  });

  test("settles an exit-1 poll and permits the next admitted tool call", async () => {
    const writeStdin = vi
      .fn<UnifiedExecProcessManagerLike["writeStdin"]>()
      .mockResolvedValueOnce(
        baseOutput({ exitCode: 1, exit_code: 1, stderr: "failed\n" }),
      )
      .mockResolvedValueOnce(
        baseOutput({
          output: "continued\n",
          exitCode: 0,
          exit_code: 0,
          stdout: "continued\n",
        }),
      );
    const manager: UnifiedExecProcessManagerLike = {
      maxTimeoutMs: 30_000,
      execCommand: vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => baseOutput({ exitCode: 0, exit_code: 0 }),
      ),
      writeStdin,
      closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(
        async () => {},
      ),
    };
    const tool = bindExplicitDangerBoundary(
      createWriteStdinTool({
        cwd: process.cwd(),
        unifiedExecManager: manager,
      }),
    );
    const state = admittedWriteStdinHarness();
    const firstArgs = { session_id: 19, chars: "" };

    const failedPoll = await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-write-stdin",
      callId: "call-exit-1",
      tool,
      args: firstArgs,
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return tool.execute(firstArgs);
      },
    });

    expect(failedPoll).toMatchObject({
      isError: true,
      effectDisposition: {
        disposition: "confirmed_committed",
        evidenceKind: "provider_receipt",
        evidenceRef: "tool:system.write-stdin:process-exit",
      },
    });
    expect(
      state.effectEvents.filter(
        (event) => event.msg.type === "effect_unknown_outcome",
      ),
    ).toHaveLength(0);
    expect(state.effectEvents.at(-1)?.msg).toMatchObject({
      type: "effect_result",
      payload: { outcome: "committed", effectBoundary: "crossed" },
    });

    const followupArgs = { session_id: 20, chars: "" };
    const followup = await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-write-stdin",
      callId: "call-followup",
      tool,
      args: followupArgs,
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return tool.execute(followupArgs);
      },
    });

    expect(followup.isError).toBeUndefined();
    expect(String(followup.content)).toContain("continued");
    expect(writeStdin).toHaveBeenCalledTimes(2);
    expect(state.effectEvents.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_result",
      "effect_intent",
      "effect_result",
    ]);
  });

  test("settles an exited buffered PTY receipt and permits the next admitted call", async () => {
    const exited = baseOutput({
      output: "FINAL_BUFFERED_OUTPUT\n",
      stdout: "FINAL_BUFFERED_OUTPUT\n",
      exitCode: 7,
      exit_code: 7,
    });
    const writeStdin = vi
      .fn<UnifiedExecProcessManagerLike["writeStdin"]>()
      .mockRejectedValueOnce(
        new UnifiedExecProcessExitedBeforeWriteError(21, exited),
      )
      .mockResolvedValueOnce(
        baseOutput({
          output: "followup-ok\n",
          stdout: "followup-ok\n",
          exitCode: 0,
          exit_code: 0,
        }),
      );
    const manager: UnifiedExecProcessManagerLike = {
      maxTimeoutMs: 30_000,
      execCommand: vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(
        async () => baseOutput({ exitCode: 0, exit_code: 0 }),
      ),
      writeStdin,
      closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(
        async () => {},
      ),
    };
    const tool = bindExplicitDangerBoundary(
      createWriteStdinTool({
        cwd: process.cwd(),
        unifiedExecManager: manager,
      }),
    );
    const state = admittedWriteStdinHarness();
    const racedArgs = { session_id: 21, chars: "echo late\n" };

    const raced = await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-write-stdin-race",
      callId: "call-exited-before-input",
      tool,
      args: racedArgs,
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return tool.execute(racedArgs);
      },
    });

    expect(raced).toMatchObject({
      isError: true,
      effectDisposition: {
        disposition: "confirmed_committed",
        evidenceKind: "provider_receipt",
        evidenceRef: "tool:system.write-stdin:process-exit-before-input",
      },
      metadata: {
        sessionId: 21,
        processExitedBeforeInput: true,
      },
    });
    expect(String(raced.content)).toContain("FINAL_BUFFERED_OUTPUT");
    expect(String(raced.content)).toContain(
      "Process 21 exited before input could be written",
    );
    const receiptMaterial = JSON.stringify({
      sessionId: 21,
      inputBytes: Buffer.byteLength(racedArgs.chars, "utf8"),
      inputAccepted: false,
      exitCode: 7,
      processId: null,
      timedOut: false,
      durationMs: 1,
    });
    expect(raced.effectDisposition?.evidenceSha256).toBe(
      createHash("sha256").update(receiptMaterial, "utf8").digest("hex"),
    );
    expect(
      state.effectEvents.filter(
        (event) => event.msg.type === "effect_unknown_outcome",
      ),
    ).toHaveLength(0);

    const followupArgs = { session_id: 22, chars: "" };
    const followup = await runAdmittedToolCall({
      session: state.session,
      turnId: "turn-write-stdin-race",
      callId: "call-after-exited-receipt",
      tool,
      args: followupArgs,
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        return tool.execute(followupArgs);
      },
    });

    expect(followup.isError).toBeUndefined();
    expect(String(followup.content)).toContain("followup-ok");
    expect(writeStdin).toHaveBeenCalledTimes(2);
    expect(state.effectEvents.map((event) => event.msg.type)).toEqual([
      "effect_intent",
      "effect_result",
      "effect_intent",
      "effect_result",
    ]);
  });

  test("settles deterministic pre-dispatch refusals as confirmed no-effect", async () => {
    const manager = makeManager(baseOutput({ exitCode: 0, exit_code: 0 }));
    vi.mocked(manager.writeStdin).mockRejectedValueOnce(
      new UnifiedExecError("unknown_process", "Unknown process id 404"),
    );
    const tool = bindExplicitDangerBoundary(
      createWriteStdinTool({ unifiedExecManager: manager }),
    );

    const invalid = await tool.execute({ session_id: "not-a-number" });
    expect(invalid.effectDisposition).toMatchObject({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef: "tool:system.write-stdin:input-validation",
    });

    const missing = await tool.execute({ session_id: 404, chars: "" });
    expect(missing).toMatchObject({
      isError: true,
      effectDisposition: {
        disposition: "confirmed_no_effect",
        evidenceKind: "boundary_not_crossed",
        evidenceRef: "tool:system.write-stdin:pre-dispatch-refusal",
      },
    });
  });

  test("does not claim no-effect for ambiguous post-write failures or aborts", async () => {
    const manager = makeManager(baseOutput({ exitCode: 0, exit_code: 0 }));
    vi.mocked(manager.writeStdin)
      .mockRejectedValueOnce(
        new UnifiedExecError("write_stdin", "failed to write to stdin"),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("operation aborted"), { name: "AbortError" }),
      );
    const tool = bindExplicitDangerBoundary(
      createWriteStdinTool({
        cwd: process.cwd(),
        unifiedExecManager: manager,
      }),
    );

    const writeFailed = await tool.execute({
      session_id: 1,
      chars: "printf ok\\n\n",
    });
    expect(writeFailed).toMatchObject({ isError: true });
    expect(writeFailed.effectDisposition).toBeUndefined();

    const aborted = await tool.execute({
      session_id: 1,
      chars: "printf ok\\n\n",
    });
    expect(aborted).toMatchObject({ isError: true });
    expect(aborted.effectDisposition).toBeUndefined();
  });
});
