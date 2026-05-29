import { describe, expect, it, vi } from "vitest";

import hooksCommand from "./hooks.js";
import type { SlashCommandContext } from "./types.js";
import type { Session } from "../session/session.js";
import { ConfiguredHooksRuntime } from "../hooks/configured-hooks.js";

function runtime(): ConfiguredHooksRuntime {
  const r = new ConfiguredHooksRuntime({
    cwd: process.cwd(),
    env: process.env,
    agencHome: "/tmp/agenc-test",
    shellPath: process.env.SHELL ?? "/bin/sh",
    // These tests exercise hook diagnostics/dispatch; treat the workspace as
    // trusted (production establishes trust before command hooks run).
    isWorkspaceTrusted: () => true,
  });
  r.load({
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
      services: { hooksRuntime },
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
});
