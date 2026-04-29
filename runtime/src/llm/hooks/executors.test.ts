import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultHookExecutor } from "./executors.js";
import type { HookContext, HookDefinition, LLMToolCall } from "./types.js";

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-hook-exec-"));
  createdDirs.push(dir);
  return dir;
}

function preToolUseContext(
  overrides: Partial<HookContext> & { cwd?: string } = {},
): HookContext {
  const toolCall: LLMToolCall = {
    id: "call-1",
    name: "system.bash",
    arguments: "{\"command\":\"echo hi\"}",
  };
  return {
    event: "PreToolUse",
    sessionId: "session-1",
    toolCall,
    parsedInput: { command: "echo hi" },
    transcriptPath: "/tmp/transcript.jsonl",
    ...overrides,
  } as HookContext;
}

describe("defaultHookExecutor command path", () => {
  it("writes upstream-compatible stdin JSON to the shell", async () => {
    const dir = createTempDir();
    const captured = join(dir, "stdin.json");
    const definition: HookDefinition = {
      event: "PreToolUse",
      kind: "command",
      target: `cat > ${JSON.stringify(captured)}`,
    };

    const outcome = await defaultHookExecutor(
      definition,
      preToolUseContext({ cwd: dir }),
    );
    expect(outcome.action).toBe("noop");

    const body = readFileSync(captured, "utf8").trim();
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.session_id).toBe("session-1");
    expect(parsed.hook_event_name).toBe("PreToolUse");
    expect(parsed.tool_name).toBe("system.bash");
    expect(parsed.tool_use_id).toBe("call-1");
    expect(parsed.tool_input).toEqual({ command: "echo hi" });
    expect(parsed.transcript_path).toBe("/tmp/transcript.jsonl");
    expect(parsed.cwd).toBe(dir);
  });

  it("maps exit code 2 to deny with the stderr message", async () => {
    const definition: HookDefinition = {
      event: "PreToolUse",
      kind: "command",
      target: "echo blocked by gate 1>&2; exit 2",
    };
    const outcome = await defaultHookExecutor(definition, preToolUseContext({ cwd: undefined }));
    expect(outcome.action).toBe("deny");
    expect(outcome.message).toContain("blocked by gate");
  });

  it("treats other non-zero exit codes as non-blocking noop", async () => {
    const definition: HookDefinition = {
      event: "PreToolUse",
      kind: "command",
      target: "echo transient failure 1>&2; exit 1",
    };
    const outcome = await defaultHookExecutor(definition, preToolUseContext({ cwd: undefined }));
    expect(outcome.action).toBe("noop");
    expect(outcome.message).toContain("transient failure");
  });

  it("includes error + is_interrupt for PostToolUseFailure payloads", async () => {
    const dir = createTempDir();
    const captured = join(dir, "stdin.json");
    const definition: HookDefinition = {
      event: "PostToolUseFailure",
      kind: "command",
      target: `cat > ${JSON.stringify(captured)}`,
    };

    const toolCall: LLMToolCall = {
      id: "call-42",
      name: "system.writeFile",
      arguments: "{}",
    };
    const context: HookContext = {
      event: "PostToolUseFailure",
      sessionId: "session-2",
      toolCall,
      errorMessage: "disk full",
      parsedInput: { path: "/tmp/x" },
      isInterrupt: true,
      cwd: dir,
    };

    const outcome = await defaultHookExecutor(definition, context);
    expect(outcome.action).toBe("noop");

    const parsed = JSON.parse(readFileSync(captured, "utf8").trim()) as Record<string, unknown>;
    expect(parsed.hook_event_name).toBe("PostToolUseFailure");
    expect(parsed.error).toBe("disk full");
    expect(parsed.is_interrupt).toBe(true);
    expect(parsed.tool_input).toEqual({ path: "/tmp/x" });
    expect(parsed.tool_use_id).toBe("call-42");
  });
});
