import { describe, expect, it } from "vitest";

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

function ctx(argsRaw: string, hooksRuntime = runtime()): SlashCommandContext {
  return {
    session: {
      services: { hooksRuntime },
    } as unknown as Session,
    argsRaw,
    cwd: process.cwd(),
    home: "/tmp",
    agencHome: "/tmp/agenc-test",
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
