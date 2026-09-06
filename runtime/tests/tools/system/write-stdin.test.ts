import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { createWriteStdinTool as createUnboundWriteStdinTool } from "../../../src/tools/system/write-stdin.js";
import {
  UnifiedExecError,
  type ExecCommandToolOutput,
  type UnifiedExecProcessManagerLike,
} from "../../../src/unified-exec/types.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-write-stdin-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A write_stdin tool whose manager answers every write with `outcome`. */
function toolWhoseManager(outcome: () => Promise<ExecCommandToolOutput>) {
  const manager: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: 30_000,
    // Never reached: these tests fail before or inside the write.
    execCommand: vi.fn(async () => undefined as never),
    writeStdin: vi.fn(outcome),
    closeAll: vi.fn(async () => {}),
  };
  return bindExplicitDangerBoundary(
    createUnboundWriteStdinTool({ cwd: root, unifiedExecManager: manager }),
  );
}

function parsed(result: { content: string }): { error?: string; code?: string } {
  return JSON.parse(result.content) as { error?: string; code?: string };
}

/** A write_stdin tool whose manager throws `error` on every write. */
function toolWhoseManagerThrows(error: Error) {
  return toolWhoseManager(async () => {
    throw error;
  });
}

const PRE_WRITE_FAILURES: ReadonlyArray<{
  readonly name: string;
  readonly error: UnifiedExecError;
  readonly chars: string;
}> = [
  {
    name: "an unknown session",
    error: new UnifiedExecError("unknown_process", "Unknown process id 4"),
    chars: "",
  },
  {
    name: "a sandbox-profile mismatch",
    error: new UnifiedExecError(
      "write_stdin",
      "write_stdin requires an existing session with a compatible sandbox profile; a session started with sandbox_permissions is reached by passing the same sandbox_permissions",
    ),
    chars: "",
  },
  {
    name: "a closed stdin",
    error: new UnifiedExecError("stdin_closed", "stdin is closed for this session"),
    chars: "y\n",
  },
];

describe("write_stdin failures before any byte reaches the process", () => {
  // Desktop soak, 2026-09-06: a 35 ms precondition failure was filed as an
  // unknown outcome and blocked every side-effecting tool of the session.
  for (const failure of PRE_WRITE_FAILURES) {
    test(`${failure.name} is a confirmed no-effect failure`, async () => {
      const tool = toolWhoseManagerThrows(failure.error);
      const result = await tool.execute({ session_id: 4, chars: failure.chars });
      expect(result.isError).toBe(true);
      expect(parsed(result).code).toBe(failure.error.code);
      expect(parsed(result).error).toBe(failure.error.message);
      expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    });
  }

  test("a rejected argument is a confirmed no-effect failure", async () => {
    const tool = toolWhoseManager(async () => undefined as never);
    const missing = await tool.execute({ chars: "" });
    expect(missing.isError).toBe(true);
    expect(parsed(missing).error).toBe("session_id must be a number");
    expect(missing.effectDisposition?.disposition).toBe("confirmed_no_effect");

    const removed = await tool.execute({ process_id: 4, session_id: 4 });
    expect(removed.isError).toBe(true);
    expect(removed.effectDisposition?.disposition).toBe("confirmed_no_effect");
  });
});

describe("write_stdin failures after the write started", () => {
  test("a write that failed once bytes may have reached the process stays undecided", async () => {
    const tool = toolWhoseManagerThrows(
      new UnifiedExecError("stdin_write_failed", "failed to write to stdin"),
    );
    const result = await tool.execute({ session_id: 4, chars: "y\n" });
    expect(result.isError).toBe(true);
    expect(parsed(result).code).toBe("stdin_write_failed");
    expect(result.effectDisposition).toBeUndefined();
  });
});

describe("write_stdin reaches a session started in another sandbox", () => {
  test("the schema takes the same sandbox permission fields as exec_command", () => {
    const tool = toolWhoseManager(async () => undefined as never);
    const properties = (tool.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(properties.sandbox_permissions).toMatchObject({
      type: "string",
      enum: ["default", "require_escalated", "with_additional_permissions"],
    });
    expect(properties.additional_permissions).toMatchObject({ type: "object" });
    expect(properties.justification).toMatchObject({ type: "string" });
  });
});
