import { describe, expect, test, vi } from "vitest";

import { buildToolRegistry } from "../../../src/tool-registry.js";
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

function registry(session: Session, lightMode: boolean) {
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
  const built = buildToolRegistry({ workspaceRoot: "/tmp", lightMode, getSession: () => session, unifiedExecManager: manager });
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
