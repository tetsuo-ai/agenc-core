import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildBootstrapToolRegistry } from "../../../src/bin/bootstrap-tool-registry.js";
import { withExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { buildToolRegistry } from "../../../src/tool-registry.js";
import {
  getSelectedProviderEnvironment,
  runWithStartupProviderSelection,
} from "../../../src/utils/model/providers.js";
import { createExecCommandTool } from "../../../src/tools/system/exec-command.js";
import {
  INLINE_PROGRAM_HINT_ENV,
  INLINE_PROGRAM_HINT_MIN_BYTES,
  execFailedTerminally,
  execInlineProgramNote,
  inlineProgramHintEnabled,
  inlineProgramNote,
  measureInlineProgram,
} from "../../../src/tools/system/inline-program-hint.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../../src/unified-exec/types.js";

function output(overrides: Partial<ExecCommandToolOutput> = {}): ExecCommandToolOutput {
  return {
    output: "Traceback (most recent call last):\n  File \"<stdin>\", line 3\nNameError: name 'x' is not defined",
    stdout: "",
    stderr: "Traceback",
    exitCode: 1,
    exit_code: 1,
    durationMs: 12,
    wall_time_seconds: 0.012,
    timedOut: false,
    truncated: false,
    original_token_count: 20,
    ...overrides,
  };
}

/** A program body of about `lines` lines, each distinct, well over the byte floor when lines is large. */
function programLines(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `value_${i} = compute(${i}) + ${i * 7}`).join("\n");
}

const LONG_BODY = programLines(60);
const LONG_HEREDOC = `python3 - <<'EOF'\n${LONG_BODY}\nEOF`;
const LONG_INLINE = `node -e "${LONG_BODY.replaceAll("\n", "; ")}"`;
const SHORT_HEREDOC = "python3 - <<'EOF'\nprint(1)\nEOF";

test.each([
  ["1", true],
  ["true", true],
  ["0", false],
  ["", false],
  [undefined, false],
])("the switch parses %j as %s", (value, expected) => {
  expect(inlineProgramHintEnabled(value === undefined ? {} : { [INLINE_PROGRAM_HINT_ENV]: value })).toBe(expected);
});

describe("measureInlineProgram", () => {
  test("measures a heredoc body up to its delimiter, without the command around it", () => {
    expect(measureInlineProgram(LONG_HEREDOC)).toEqual({ kind: "heredoc", bytes: Buffer.byteLength(LONG_BODY) });
    expect(measureInlineProgram(`cat > tmp/x.py <<"END"\n${LONG_BODY}\nEND\npython3 tmp/x.py`))
      .toEqual({ kind: "heredoc", bytes: Buffer.byteLength(LONG_BODY) });
    expect(measureInlineProgram(`python3 - <<EOF\n${LONG_BODY}\nEOF`)?.bytes).toBe(Buffer.byteLength(LONG_BODY));
    expect(measureInlineProgram(`python3 - <<\\EOF\n${LONG_BODY}\nEOF`)?.bytes).toBe(Buffer.byteLength(LONG_BODY));
  });

  test("a dash heredoc ignores leading tabs on the delimiter line, and an unterminated body runs to the end", () => {
    expect(measureInlineProgram(`python3 - <<-EOF\n\tprint(1)\n\tprint(2)\n\tEOF`))
      .toEqual({ kind: "heredoc", bytes: Buffer.byteLength("\tprint(1)\n\tprint(2)") });
    expect(measureInlineProgram("python3 - <<'EOF'\nprint(1)\nprint(2)"))
      .toEqual({ kind: "heredoc", bytes: Buffer.byteLength("print(1)\nprint(2)") });
    expect(measureInlineProgram("python3 - <<'EOF'")).toEqual({ kind: "heredoc", bytes: 0 });
  });

  test("measures the quoted string after an interpreter's inline-code flag", () => {
    expect(measureInlineProgram(LONG_INLINE)).toEqual({ kind: "inline_code", bytes: Buffer.byteLength(LONG_BODY.replaceAll("\n", "; ")) });
    expect(measureInlineProgram("python3 -u -c 'print(1)'")).toEqual({ kind: "inline_code", bytes: Buffer.byteLength("print(1)") });
    expect(measureInlineProgram("cd app && bash -c 'make && make test'")).toEqual({ kind: "inline_code", bytes: Buffer.byteLength("make && make test") });
    expect(measureInlineProgram('node -e "console.log(\\"a\\")"')).toEqual({ kind: "inline_code", bytes: Buffer.byteLength('console.log(\\"a\\")') });
    expect(measureInlineProgram("perl -e 'print 1")).toEqual({ kind: "inline_code", bytes: Buffer.byteLength("print 1") });
  });

  test("ordinary commands, here-strings and option values carry no program", () => {
    expect(measureInlineProgram("npm test")).toBeUndefined();
    expect(measureInlineProgram("cat <<< 'hello'")).toBeUndefined();
    expect(measureInlineProgram("grep -c 'pattern' file.txt")).toBeUndefined();
    expect(measureInlineProgram("python3 script.py --count 3")).toBeUndefined();
    expect(measureInlineProgram("echo a && echo b")).toBeUndefined();
  });

  test("reports the longer program when a command carries both shapes", () => {
    const cmd = `node -e "x()" && python3 - <<'EOF'\n${LONG_BODY}\nEOF`;
    expect(measureInlineProgram(cmd)).toEqual({ kind: "heredoc", bytes: Buffer.byteLength(LONG_BODY) });
    const inlineFirst = `python3 - <<'EOF'\nprint(1)\nEOF\n${LONG_INLINE}`;
    expect(measureInlineProgram(inlineFirst)?.kind).toBe("inline_code");
  });
});

describe("execFailedTerminally", () => {
  test.each([
    ["non-zero exit", {}, true],
    ["timeout kill", { exitCode: null, exit_code: null, timedOut: true }, true],
    ["signal", { exitCode: null, exit_code: null }, true],
    ["success", { exitCode: 0, exit_code: 0 }, false],
    ["still running", { exitCode: null, exit_code: null, process_id: 7 }, false],
    ["yielded session", { exitCode: null, exit_code: null, session_id: 7 }, false],
    ["detached", { exitCode: null, exit_code: null, detached: true, pid: 9 }, false],
    ["no terminal report", { exitCode: null, exit_code: null, command_outcome: "unavailable" as const }, false],
  ])("%s", (_label, overrides, expected) => {
    expect(execFailedTerminally(output(overrides))).toBe(expected);
  });
});

describe("execInlineProgramNote", () => {
  test("a failed long heredoc gets one note naming the default file tools and the program size", () => {
    const note = execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output() });
    expect(note).toBe(inlineProgramNote(LONG_HEREDOC, undefined));
    expect(note).toContain(`a heredoc program of ${Buffer.byteLength(LONG_BODY)} bytes`);
    expect(note).toContain("with Write");
    expect(note).toContain("fix it with Edit");
    expect(note).toMatch(/^\[note: /u);
    expect(execInlineProgramNote({ enabled: true, cmd: LONG_INLINE, output: output() })).toContain("an inline program string");
  });

  test("the switch off, a passing command, a short program or a live process produce no note", () => {
    expect(execInlineProgramNote({ enabled: false, cmd: LONG_HEREDOC, output: output() })).toBeNull();
    expect(execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output({ exitCode: 0, exit_code: 0 }) })).toBeNull();
    expect(execInlineProgramNote({ enabled: true, cmd: SHORT_HEREDOC, output: output() })).toBeNull();
    expect(execInlineProgramNote({ enabled: true, cmd: "npm test", output: output() })).toBeNull();
    expect(execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output({ exitCode: null, exit_code: null, process_id: 3 }) })).toBeNull();
    expect(Buffer.byteLength(programLines(60))).toBeGreaterThanOrEqual(INLINE_PROGRAM_HINT_MIN_BYTES);
  });

  test("names the session's listed file tools, falls back to unlisted ones, and stays silent without any", () => {
    const applyPatchOnly = () => ({ listed: ["apply_patch"], unlisted: [] });
    const applyNote = execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output(), fileWriteTools: applyPatchOnly });
    expect(applyNote).toContain("with apply_patch");
    expect(applyNote).toContain("fix it with apply_patch");
    expect(applyNote).not.toMatch(/\b(?:Edit|Write)\b/u);

    const unlisted = () => ({ listed: [], unlisted: ["Write", "Edit"], loadWith: "system.searchTools" });
    expect(execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output(), fileWriteTools: unlisted })).toContain("with Write");

    const none = () => ({ listed: [], unlisted: [] });
    expect(execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output(), fileWriteTools: none })).toBeNull();

    const throwing = () => { throw new Error("registry unavailable"); };
    expect(execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output(), fileWriteTools: throwing })).toContain("with Write");
  });

  test("the file tools are listed only when a note is written", () => {
    const fileWriteTools = vi.fn(() => ({ listed: ["Write", "Edit"], unlisted: [] }));
    execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output({ exitCode: 0, exit_code: 0 }), fileWriteTools });
    execInlineProgramNote({ enabled: true, cmd: SHORT_HEREDOC, output: output(), fileWriteTools });
    execInlineProgramNote({ enabled: false, cmd: LONG_HEREDOC, output: output(), fileWriteTools });
    expect(fileWriteTools).not.toHaveBeenCalled();
    execInlineProgramNote({ enabled: true, cmd: LONG_HEREDOC, output: output(), fileWriteTools });
    expect(fileWriteTools).toHaveBeenCalledTimes(1);
  });
});

describe("exec_command result", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-inline-program-hint-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  function manager(result: ExecCommandToolOutput): UnifiedExecProcessManagerLike {
    return {
      maxTimeoutMs: 30_000,
      execCommand: vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(async () => result),
      writeStdin: vi.fn<UnifiedExecProcessManagerLike["writeStdin"]>(async () => result),
      closeAll: vi.fn<UnifiedExecProcessManagerLike["closeAll"]>(async () => {}),
    };
  }

  test("a Light session with the hint appends the note after the failed result's footer", async () => {
    const tool = createExecCommandTool({
      cwd: root, allowedPaths: [root], lightMode: true, inlineProgramHint: true, unifiedExecManager: manager(output()),
    });
    const result = await tool.execute(withExplicitDangerBoundary({ cmd: LONG_HEREDOC }));
    expect(result.isError).toBe(true);
    const content = String(result.content);
    expect(content).toContain("NameError");
    expect(content).toMatch(/\[exec exit_code=1 [^\n]*\]\n\n\[note: this failed command carried a heredoc program of \d+ bytes\./u);
    expect(content.endsWith("instead of resending the whole program.]")).toBe(true);
    expect(result.metadata).toMatchObject({ exitCode: 1, command: LONG_HEREDOC });
  });

  test("the same failure without the hint, outside Light, or after a passing run carries no note", async () => {
    const withoutHint = createExecCommandTool({ cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager(output()) });
    const offLight = createExecCommandTool({ cwd: root, allowedPaths: [root], inlineProgramHint: true, unifiedExecManager: manager(output()) });
    const passing = createExecCommandTool({
      cwd: root, allowedPaths: [root], lightMode: true, inlineProgramHint: true,
      unifiedExecManager: manager(output({ exitCode: 0, exit_code: 0, output: "ok", stdout: "ok", stderr: "" })),
    });
    for (const tool of [withoutHint, offLight]) {
      const result = await tool.execute(withExplicitDangerBoundary({ cmd: LONG_HEREDOC }));
      expect(result.isError).toBe(true);
      expect(String(result.content)).not.toContain("[note:");
      expect(String(result.content)).toMatch(/\[exec exit_code=1 [^\n]*\]$/u);
    }
    const ok = await passing.execute(withExplicitDangerBoundary({ cmd: LONG_HEREDOC }));
    expect(ok.isError).toBeUndefined();
    expect(String(ok.content)).not.toContain("[note:");
  });

  test("the hint rides the registry option into the Light exec_command tool", async () => {
    const result = output();
    const execManager = manager(result);
    const on = buildToolRegistry({
      workspaceRoot: root, lightMode: true, inlineProgramHint: true, requireAdmission: false, unifiedExecManager: execManager,
    });
    const off = buildToolRegistry({
      workspaceRoot: root, lightMode: true, requireAdmission: false, unifiedExecManager: execManager,
    });
    const onTool = on.tools.find((tool) => tool.name === "exec_command");
    const offTool = off.tools.find((tool) => tool.name === "exec_command");
    expect(onTool).toBeDefined();
    expect(offTool).toBeDefined();
    expect(String((await onTool!.execute(withExplicitDangerBoundary({ cmd: LONG_HEREDOC }))).content)).toContain("[note: this failed command carried a heredoc program");
    expect(String((await offTool!.execute(withExplicitDangerBoundary({ cmd: LONG_HEREDOC }))).content)).not.toContain("[note:");
  });

  test("the bootstrap reads the switch from the captured session environment, and only a Light session applies it", async () => {
    // runWithStartupProviderSelection captures the environment through the
    // daemon client allowlist, as a daemon-owned session does; the bootstrap
    // registry reads the switch from that environment, like the other
    // per-session tool switches.
    const execManager = manager(output());
    const contentWith = (environment: Record<string, string>, lightMode: boolean) =>
      runWithStartupProviderSelection(
        { provider: "deepseek", model: "deepseek-flash", environment },
        async () => {
          const registry = buildBootstrapToolRegistry({
            workspaceRoot: root,
            agencHome: join(root, "home"),
            environment: getSelectedProviderEnvironment(),
            mcpManager: {
              getTools: () => [],
              effectiveServers: async () => new Map(),
              toolPluginProvenance: async () => null,
            } as never,
            csvAgentJobsRepositories: {
              async withRepository(): Promise<never> {
                throw new Error("CSV repositories are not used by this test");
              },
            },
            getSession: () => null,
            emitWarning: () => {},
            toolRegistryOptions: { lightMode, requireAdmission: false, unifiedExecManager: execManager },
          });
          const tool = registry.tools.find((candidate) => candidate.name === "exec_command");
          expect(tool).toBeDefined();
          return String((await tool!.execute(withExplicitDangerBoundary({ cmd: LONG_HEREDOC }))).content);
        },
      );

    expect(await contentWith({ [INLINE_PROGRAM_HINT_ENV]: "1" }, true)).toContain("[note: this failed command carried a heredoc program");
    expect(await contentWith({}, true)).not.toContain("[note:");
    expect(await contentWith({ [INLINE_PROGRAM_HINT_ENV]: "1" }, false)).not.toContain("[note:");
  });
});
