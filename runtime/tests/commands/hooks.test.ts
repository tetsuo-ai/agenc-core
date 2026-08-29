import { describe, expect, it, vi } from "vitest";

import hooksCommand from "./hooks.js";
import type { SlashCommandContext } from "./types.js";
import type { Session } from "../session/session.js";
import { ConfiguredHooksRuntime } from "../hooks/configured-hooks.js";
import { createHookExecutionAuthority } from "../hooks/execution-authority.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

function runtime(simpleMode = false): ConfiguredHooksRuntime {
  const r = new ConfiguredHooksRuntime({
    cwd: process.cwd(),
    env: process.env,
    agencHome: "/tmp/agenc-test",
    shellPath: process.env.SHELL ?? "/bin/sh",
    sandboxExecutionBroker: explicitDangerBroker,
    admissionRequired: false,
    runtimeOptions: { simpleMode },
    executionAuthority: createHookExecutionAuthority({
      runtimeOptions: { simpleMode, allowUntrustedHooks: false },
      isWorkspaceTrusted: () => true,
    }),
  });
  r.loadForTesting({
    PreToolUse: [
      {
        matcher: "Read",
        hooks: [{ type: "command", command: "printf ok" }],
      },
    ],
  });
  return r;
}

function ctx(
  argsRaw: string,
  hooksRuntime = runtime(),
  appState?: SlashCommandContext["appState"],
): SlashCommandContext {
  return {
    session: {
      services: { admissionRequired: false, hooksRuntime },
    } as unknown as Session,
    argsRaw,
    cwd: process.cwd(),
    home: "/tmp",
    agencHome: "/tmp/agenc-test",
    ...(appState ? { appState } : {}),
  };
}

describe("/hooks command", () => {
  it("lists configured hooks", async () => {
    const result = await hooksCommand.execute(ctx(""));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("AgenC Hooks");
      expect(result.text).toContain("PreToolUse");
      expect(result.text).toContain("printf ok");
    }
  });

  it("opens the local hooks menu in the TUI", async () => {
    const setToolJSX = vi.fn();
    const result = await hooksCommand.execute(
      ctx("", runtime(), { setToolJSX }),
    );
    expect(result.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    expect(setToolJSX.mock.calls[0]?.[0]).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
  });

  it("opens a bounded unavailable hooks menu when the runtime bridge is absent", async () => {
    const setToolJSX = vi.fn();
    const result = await hooksCommand.execute({
      ...ctx("", undefined, { setToolJSX }),
      session: { services: {} } as unknown as Session,
    });

    expect(result.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    expect(setToolJSX.mock.calls[0]?.[0]).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
  });

  it("shows one configured hook", async () => {
    const result = await hooksCommand.execute(ctx("show PreToolUse 0"));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("Event: PreToolUse");
      expect(result.text).toContain("Command: printf ok");
    }
  });

  it("rejects retired lower-camel event aliases", async () => {
    const result = await hooksCommand.execute(ctx("show preToolUse 0"));
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Events: PreToolUse"),
    });
  });

  it("can disable and enable hooks for the session", async () => {
    const r = runtime();
    let result = await hooksCommand.execute(ctx("disable", r));
    expect(result.kind).toBe("text");
    expect(r.isDisabled()).toBe(true);
    result = await hooksCommand.execute(ctx("enable", r));
    expect(result.kind).toBe("text");
    expect(r.isDisabled()).toBe(false);
  });

  it("runs hook diagnostics explicitly", async () => {
    const result = await hooksCommand.execute(ctx("test PreToolUse 0"));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("AgenC Hook Diagnostics");
      expect(result.text).toContain("success");
    }
  });

  it("reports immutable --bare suppression and cannot enable past it", async () => {
    const r = runtime(true);

    let result = await hooksCommand.execute(ctx("list", r));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("suppressed by immutable --bare mode");
      expect(result.text).toContain("Mutable switch: enabled");
    }

    result = await hooksCommand.execute(ctx("enable", r));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("remain suppressed");
    }
    expect(r.isDisabled()).toBe(false);
    expect(r.isExecutionSuppressed()).toBe(true);

    result = await hooksCommand.execute(ctx("test PreToolUse 0", r));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("Hook test skipped");
      expect(result.text).toContain("immutable --bare mode");
    }
  });
});

function daemonStatusSnapshot() {
  return {
    sessionId: "session_1",
    available: true,
    sourcePath: "/home/agent/.agenc/config.toml",
    disabled: false,
    issues: [],
    hooks: [
      {
        event: "PreToolUse",
        matcher: "Read",
        command: { type: "command", command: "printf daemon-ok" },
        source: "config",
        sourcePath: "/home/agent/.agenc/config.toml",
        enabled: true,
        index: 0,
      },
    ],
    diagnostics: [],
  };
}

function daemonCtx(
  argsRaw: string,
  overrides?: {
    getDaemonHooksStatus?: () => Promise<unknown>;
    setDaemonHooksDisabled?: (disabled: boolean) => Promise<unknown>;
    hooksRuntime?: ConfiguredHooksRuntime;
    simpleMode?: boolean;
  },
): SlashCommandContext {
  const getDaemonHooksStatus =
    overrides?.getDaemonHooksStatus ?? (async () => daemonStatusSnapshot());
  return {
    // Daemon-backed bridge session: services has no hooksRuntime, only the
    // daemon forwarders, so /hooks must route through the RPC.
    session: {
      services: {
        runtimeOptions: { simpleMode: overrides?.simpleMode ?? false },
        ...(overrides?.hooksRuntime
          ? { hooksRuntime: overrides.hooksRuntime }
          : {}),
      },
      getDaemonHooksStatus,
      ...(overrides?.setDaemonHooksDisabled
        ? { setDaemonHooksDisabled: overrides.setDaemonHooksDisabled }
        : {}),
    } as unknown as Session,
    argsRaw,
    cwd: process.cwd(),
    home: "/tmp",
    agencHome: "/tmp/agenc-test",
  };
}

describe("/hooks command (daemon path)", () => {
  it("renders the daemon's real hooks via the status RPC", async () => {
    const result = await hooksCommand.execute(daemonCtx("list"));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("AgenC Hooks");
      expect(result.text).toContain("PreToolUse");
      expect(result.text).toContain("printf daemon-ok");
    }
  });

  it("does not return the unavailable error when the daemon forwarder exists", async () => {
    const result = await hooksCommand.execute(daemonCtx(""));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).not.toContain(
        "Hooks runtime is not available in this session.",
      );
    }
  });

  it("prefers daemon authority over a local shadow hooks runtime", async () => {
    const localShadow = runtime();
    const result = await hooksCommand.execute(
      daemonCtx("list", { hooksRuntime: localShadow }),
    );

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("printf daemon-ok");
      expect(result.text).not.toContain("printf ok");
    }
  });

  it("toggles hooks through the daemon setDisabled RPC", async () => {
    const setDaemonHooksDisabled = vi.fn(async () => ({
      sessionId: "session_1",
      applied: true,
      disabled: true,
    }));
    const result = await hooksCommand.execute(
      daemonCtx("disable", { setDaemonHooksDisabled }),
    );
    expect(result.kind).toBe("text");
    expect(setDaemonHooksDisabled).toHaveBeenCalledWith(true);
  });

  it("does not claim daemon enable overrides immutable --bare mode", async () => {
    const setDaemonHooksDisabled = vi.fn(async () => ({
      sessionId: "session_1",
      applied: true,
      disabled: false,
    }));
    const result = await hooksCommand.execute(
      daemonCtx("enable", {
        setDaemonHooksDisabled,
        simpleMode: true,
      }),
    );

    expect(result.kind).toBe("text");
    expect(setDaemonHooksDisabled).toHaveBeenCalledWith(false);
    if (result.kind === "text") {
      expect(result.text).toContain("remain suppressed");
      expect(result.text).toContain("immutable --bare mode");
    }
  });

  it("defers /hooks test against the daemon", async () => {
    const result = await hooksCommand.execute(daemonCtx("test PreToolUse 0"));
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain(
        "/hooks test is not yet available against the daemon",
      );
    }
  });

  it("reports unavailable when the daemon session has no hooks runtime", async () => {
    const result = await hooksCommand.execute(
      daemonCtx("list", {
        getDaemonHooksStatus: async () => ({
          sessionId: "session_1",
          available: false,
          sourcePath: "",
          disabled: true,
          issues: [],
          hooks: [],
          diagnostics: [],
        }),
      }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe(
        "Hooks runtime is not available in this session.",
      );
    }
  });
});
