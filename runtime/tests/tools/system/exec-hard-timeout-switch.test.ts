import { describe, expect, test, vi } from "vitest";

import { buildToolRegistry } from "../../../src/tool-registry.js";
import { QuickJsCodeModeService } from "../../../src/tools/code-mode/service.js";
import { EXEC_HARD_TIMEOUT_ENV, execHardTimeoutEnabled } from "../../../src/tools/system/exec-timeout-mode.js";
import type { Session } from "../../../src/session/session.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../../src/unified-exec/types.js";
import { withExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

// Coordinator decision for 0.19.26: a timed-out command keeps running as a
// session by default; config.toml `exec_hard_timeout = true` or the session's
// AGENC_EXEC_HARD_TIMEOUT=1 restores the hard timeout, and the exec_command
// schema then says so.

describe("execHardTimeoutEnabled", () => {
  test("is off by default, follows config.toml, and the session environment overrides it", () => {
    expect(execHardTimeoutEnabled({})).toBe(false);
    expect(execHardTimeoutEnabled({}, false)).toBe(false);
    expect(execHardTimeoutEnabled({}, true)).toBe(true);
    expect(execHardTimeoutEnabled({ [EXEC_HARD_TIMEOUT_ENV]: "1" })).toBe(true);
    expect(execHardTimeoutEnabled({ [EXEC_HARD_TIMEOUT_ENV]: "1" }, false)).toBe(true);
    expect(execHardTimeoutEnabled({ [EXEC_HARD_TIMEOUT_ENV]: "0" }, true)).toBe(false);
    expect(execHardTimeoutEnabled({ [EXEC_HARD_TIMEOUT_ENV]: "" }, true)).toBe(true);
  });
});

function sessionWith(options: { readonly env?: Record<string, string>; readonly configured?: boolean } = {}): Session {
  return {
    services: {
      providerEnvironment: options.env ?? {},
      configStore: { current: () => (options.configured === undefined ? {} : { exec_hard_timeout: options.configured }) },
    },
  } as unknown as Session;
}

function registry(session: Session, lightMode: boolean, extra: { readonly codeMode?: boolean } = {}) {
  const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(async (): Promise<ExecCommandToolOutput> => ({
    output: "", stdout: "", stderr: "", exitCode: 0, exit_code: 0, durationMs: 1,
    wall_time_seconds: 0.001, timedOut: false, truncated: false, original_token_count: 0,
  }));
  const manager: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: Number.POSITIVE_INFINITY,
    execCommand,
    writeStdin: vi.fn(),
    closeAll: vi.fn(async () => {}),
  };
  const built = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode, getSession: () => session, unifiedExecManager: manager,
    ...(extra.codeMode === true ? { codeModeService: new QuickJsCodeModeService({ enabled: true }) } : {}),
  });
  return { built, execCommand };
}

function timeoutDescription(built: ReturnType<typeof buildToolRegistry>): string | undefined {
  const exec = built.toLLMTools().find((tool) => tool.function.name === "exec_command")!;
  return (exec.function.parameters.properties as Record<string, { description?: string }>).timeoutMs?.description;
}

describe("the hard-timeout switch in a session", () => {
  test.each([
    ["the session environment", { env: { [EXEC_HARD_TIMEOUT_ENV]: "1" } }],
    ["config.toml", { configured: true }],
  ] as const)("restores the kill and its wording when set in %s", async (_where, setting) => {
    const light = registry(sessionWith(setting), true);
    expect(timeoutDescription(light.built)).toBe("Hard timeout, ms.");
    const exec = light.built.tools.find((tool) => tool.name === "exec_command")!;
    await exec.execute(withExplicitDangerBoundary({ cmd: "sleep 30", timeoutMs: 500 }));
    expect(light.execCommand).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 500, onTimeout: "kill" }));

    const standard = registry(sessionWith(setting), false);
    const full = standard.built.toLLMTools().find((tool) => tool.function.name === "exec_command")!;
    expect(timeoutDescription(standard.built)).toBe("Hard timeout in ms: a command still running then is stopped.");
    expect(full.function.description).not.toContain("or timeoutMs");
  });

  test("leaves the default: the command continues as a session and the schema says so", async () => {
    const light = registry(sessionWith({ env: { [EXEC_HARD_TIMEOUT_ENV]: "0" }, configured: true }), true);
    expect(timeoutDescription(light.built)).toBe("Max wait, ms; then runs on as a session.");
    const exec = light.built.tools.find((tool) => tool.name === "exec_command")!;
    await exec.execute(withExplicitDangerBoundary({ cmd: "sleep 30", timeoutMs: 500 }));
    expect(light.execCommand).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 500, onTimeout: "background" }));
  });
});

// The schema is not the only place the model reads exec_command's
// description: code mode embeds it in exec's description and ALL_TOOLS, and
// system.searchTools returns it. With the switch on, none may promise that a
// command keeps running past timeoutMs; with it off, the text stays as it was,
// byte for byte, so the prompt cache is unchanged.
const DEFAULT_DESCRIPTION =
  "Run a shell command in the workspace and return its stdout and stderr: inspection, tests, builds and other terminal work. Change source files with Edit, MultiEdit or Write; rm and mv are fine here for deleting or renaming. Call tools directly; never run a command just to print notes or placeholders.\n\nA command still running after yield_time_ms or timeoutMs returns a session_id and keeps running in the background: write_stdin polls it (chars='') or sends input, kill_process stops it, and a later result reports when it ends. Linux sandbox: run servers and clients in one command; background jobs have private loopback. Start other long jobs with background: true, not trailing & or nohup (refused); every other process a command leaves behind is stopped when it returns. A server or other service that must outlive the command and the session needs detach: true (outside the sandbox, including an approved require_escalated launch); the result carries its pid and log file.";
const HARD_DESCRIPTION = DEFAULT_DESCRIPTION.replace("after yield_time_ms or timeoutMs", "after yield_time_ms");

async function searchedDescription(built: ReturnType<typeof buildToolRegistry>): Promise<string | undefined> {
  const search = built.tools.find((tool) => tool.name === "system.searchTools")!;
  const result = await search.execute({ query: "exec_command shell command" });
  const parsed = JSON.parse(result.content) as { results: { name: string; description?: string }[] };
  return parsed.results.find((entry) => entry.name === "exec_command")?.description;
}

function codeModeExecDescription(built: ReturnType<typeof buildToolRegistry>): string {
  return built.toLLMTools().find((tool) => tool.function.name === "exec")!.function.description!;
}

describe("the hard-timeout wording on every surface", () => {
  test.each([
    ["the session environment", { env: { [EXEC_HARD_TIMEOUT_ENV]: "1" } }],
    ["config.toml", { configured: true }],
  ] as const)("code mode and system.searchTools say timeoutMs stops the command when set in %s", async (_where, setting) => {
    const standard = registry(sessionWith(setting), false, { codeMode: true });
    expect(standard.built.tools.find((tool) => tool.name === "exec_command")!.description).toBe(HARD_DESCRIPTION);
    expect(codeModeExecDescription(standard.built)).toContain(HARD_DESCRIPTION);
    expect(codeModeExecDescription(standard.built)).not.toContain("or timeoutMs");
    expect(await searchedDescription(standard.built)).toBe(HARD_DESCRIPTION);
  });

  test("keeps every default text byte for byte while the switch is off", async () => {
    const standard = registry(sessionWith(), false, { codeMode: true });
    expect(standard.built.tools.find((tool) => tool.name === "exec_command")!.description).toBe(DEFAULT_DESCRIPTION);
    expect(codeModeExecDescription(standard.built)).toContain(DEFAULT_DESCRIPTION);
    expect(await searchedDescription(standard.built)).toBe(DEFAULT_DESCRIPTION);
    const full = standard.built.toLLMTools().find((tool) => tool.function.name === "exec_command")!;
    expect(full.function.description).toBe(DEFAULT_DESCRIPTION);
    expect(timeoutDescription(standard.built))
      .toBe("Wait limit in ms. A command still running then is not stopped: it keeps running as a session (session_id).");
  });
});
