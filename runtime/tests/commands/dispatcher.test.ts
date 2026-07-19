import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  dispatchSlashCommand,
  extractFirstLine,
  isBridgeSafeCommand,
  maskSensitiveArgs,
  parseSlashCommand,
} from "./dispatcher.js";
import { CommandRegistry } from "./registry.js";
import type {
  SlashCommand,
  SlashCommandContext,
  SlashCommandResult,
} from "./types.js";

function stubCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    session: {} as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/tmp",
    home: "/home/test",
    ...overrides,
  };
}

function cmd(
  name: string,
  fn: (ctx: SlashCommandContext) => Promise<SlashCommandResult>,
  extra: Partial<SlashCommand> = {},
): SlashCommand {
  return {
    name,
    description: `test ${name}`,
    execute: fn,
    ...extra,
  };
}

describe("parseSlashCommand — happy paths", () => {
  it("parses a bare slash command", () => {
    expect(parseSlashCommand("/help")).toEqual({
      name: "help",
      argsRaw: "",
      isMcp: false,
    });
  });

  it("parses a command with a single arg token", () => {
    expect(parseSlashCommand("/model gpt-5")).toEqual({
      name: "model",
      argsRaw: "gpt-5",
      isMcp: false,
    });
  });

  it("parses a command with multi-word args", () => {
    expect(parseSlashCommand("/search  foo bar  baz")).toEqual({
      name: "search",
      argsRaw: "foo bar  baz",
      isMcp: false,
    });
  });

  it("accepts trailing newline only (I-68-compatible)", () => {
    expect(parseSlashCommand("/model gpt-5\n")).toEqual({
      name: "model",
      argsRaw: "gpt-5",
      isMcp: false,
    });
  });

  it("accepts leading whitespace (trimmed)", () => {
    expect(parseSlashCommand("  /help")).toEqual({
      name: "help",
      argsRaw: "",
      isMcp: false,
    });
  });

  it("strips trailing whitespace on args", () => {
    expect(parseSlashCommand("/model   gpt-5   ")).toEqual({
      name: "model",
      argsRaw: "gpt-5",
      isMcp: false,
    });
  });

  it("recognizes (MCP) syntax", () => {
    expect(parseSlashCommand("/mcp(MCP) list")).toEqual({
      name: "mcp",
      argsRaw: "list",
      isMcp: true,
    });
  });

  it("handles (MCP) with no args", () => {
    expect(parseSlashCommand("/mcp(MCP)")).toEqual({
      name: "mcp",
      argsRaw: "",
      isMcp: true,
    });
  });

  it("parses names with digits and dashes", () => {
    expect(parseSlashCommand("/enter-worktree my-slug-1")).toEqual({
      name: "enter-worktree",
      argsRaw: "my-slug-1",
      isMcp: false,
    });
  });

  it("parses names with underscore", () => {
    expect(parseSlashCommand("/my_cmd arg")).toEqual({
      name: "my_cmd",
      argsRaw: "arg",
      isMcp: false,
    });
  });

  it("parses namespaced skill names", () => {
    expect(parseSlashCommand("/frontend:react:form input")).toEqual({
      name: "frontend:react:form",
      argsRaw: "input",
      isMcp: false,
    });
  });
});

describe("parseSlashCommand — rejections", () => {
  it("rejects empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  it("rejects text without leading slash", () => {
    expect(parseSlashCommand("hello /model")).toBeNull();
  });

  it("rejects bare slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
  });

  it("rejects '/ status' (space between slash and name)", () => {
    expect(parseSlashCommand("/ status")).toBeNull();
  });

  it("rejects uppercase name /Model", () => {
    expect(parseSlashCommand("/Model")).toBeNull();
  });

  it("rejects mixed-case name /mcP", () => {
    expect(parseSlashCommand("/mcP")).toBeNull();
  });

  it("rejects name starting with a digit", () => {
    expect(parseSlashCommand("/1cmd")).toBeNull();
  });

  it("rejects name starting with dash", () => {
    expect(parseSlashCommand("/-foo")).toBeNull();
  });
});

describe("parseSlashCommand — I-68 multi-line fence", () => {
  it("rejects '/model gpt-5\\nextra content'", () => {
    expect(parseSlashCommand("/model gpt-5\nextra content")).toBeNull();
  });

  it("rejects '/model\\ngpt-5'", () => {
    expect(parseSlashCommand("/model\ngpt-5")).toBeNull();
  });

  it("rejects non-empty content at line index 2", () => {
    expect(parseSlashCommand("/model gpt-5\n\nlater content")).toBeNull();
  });

  it("accepts trailing whitespace-only lines", () => {
    expect(parseSlashCommand("/model gpt-5\n   \n\t\n")).toEqual({
      name: "model",
      argsRaw: "gpt-5",
      isMcp: false,
    });
  });

  it("rejects CRLF with follow-up content", () => {
    expect(parseSlashCommand("/model gpt-5\r\nfollow")).toBeNull();
  });

  it("accepts CRLF with empty follow-up line", () => {
    expect(parseSlashCommand("/model gpt-5\r\n")).toEqual({
      name: "model",
      argsRaw: "gpt-5",
      isMcp: false,
    });
  });

  it("rejects mixed whitespace then non-whitespace", () => {
    expect(parseSlashCommand("/model\n \t word")).toBeNull();
  });
});

describe("extractFirstLine", () => {
  it("returns input as-is for a single line", () => {
    expect(extractFirstLine("hello world")).toBe("hello world");
  });

  it("returns everything before the first newline", () => {
    expect(extractFirstLine("first\nsecond")).toBe("first");
  });

  it("strips trailing CR on CRLF input", () => {
    expect(extractFirstLine("first\r\nsecond")).toBe("first");
  });

  it("returns empty string for empty input", () => {
    expect(extractFirstLine("")).toBe("");
  });
});

describe("maskSensitiveArgs", () => {
  it("returns the redacted marker for non-empty input", () => {
    expect(maskSensitiveArgs("sk-secret-token")).toBe("***redacted***");
  });

  it("returns empty string for empty input (no leaked marker)", () => {
    expect(maskSensitiveArgs("")).toBe("");
  });
});

describe("isBridgeSafeCommand", () => {
  it("allows known-safe commands", () => {
    for (const name of [
      "status",
      "help",
      "hello",
      "model",
      "provider",
      "clear",
      "diff",
    ]) {
      expect(isBridgeSafeCommand(name)).toBe(true);
    }
  });

  it("rejects unsafe commands", () => {
    for (const name of [
      "exit",
      "compact",
      "permissions",
      "config",
      "context",
      "resume",
      "fork",
      "init",
      "plan",
    ]) {
      expect(isBridgeSafeCommand(name)).toBe(false);
    }
  });

  it("rejects unknown commands (closed allowlist)", () => {
    expect(isBridgeSafeCommand("totally-unknown")).toBe(false);
  });
});

describe("dispatchSlashCommand", () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it("dispatches a known command and returns its text result", async () => {
    registry.register(
      cmd("echo", async (ctx) => ({
        kind: "text",
        text: `args=${ctx.argsRaw}`,
      })),
    );
    const out = await dispatchSlashCommand(
      { name: "echo", argsRaw: "hi there", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.result).toEqual({ kind: "text", text: "args=hi there" });
    expect(out.immediate).toBe(false);
  });

  it("dispatches via alias", async () => {
    registry.register(
      cmd(
        "status",
        async () => ({ kind: "text", text: "ok" }),
        { aliases: ["stat"] },
      ),
    );
    const out = await dispatchSlashCommand(
      { name: "stat", argsRaw: "", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.result).toEqual({ kind: "text", text: "ok" });
    expect(out.trace.name).toBe("status");
    expect(out.trace.aliasUsed).toBe("stat");
  });

  it("returns { kind: 'error' } for unknown commands", async () => {
    const out = await dispatchSlashCommand(
      { name: "does-not-exist", argsRaw: "", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.result).toEqual({
      kind: "error",
      message: "Unknown command: /does-not-exist",
    });
  });

  it("does not expand unknown slash commands as skills", async () => {
    const out = await dispatchSlashCommand(
      { name: "review-pr", argsRaw: "123", isMcp: false },
      stubCtx({
        session: {
          conversationId: "session-1",
          services: {
            skillsManager: {
              resolveSkill: async (name: string) =>
                name === "review-pr"
                  ? {
                      name,
                      description: "Review a pull request",
                      path: "/skills/review-pr/SKILL.md",
                      root: "/skills/review-pr",
                      scope: "project",
                      userInvocable: true,
                    }
                  : null,
              renderSkill: async () => ({
                skill: {
                  name: "review-pr",
                  description: "Review a pull request",
                  path: "/skills/review-pr/SKILL.md",
                  root: "/skills/review-pr",
                  scope: "project",
                },
                content: "Review PR 123",
              }),
              recordInvokedSkill: vi.fn(),
              skillsForConfig: async () => ({ invokedSkills: [] }),
            },
          },
        } as unknown as SlashCommandContext["session"],
      }),
      registry,
    );

    expect(out.result).toEqual({
      kind: "error",
      message: "Unknown command: /review-pr",
    });
    expect(out.trace.name).toBe("review-pr");
  });

  it("does not probe model-only skills from slash dispatch", async () => {
    const resolveSkill = vi.fn(async () => ({
      name: "hidden",
      description: "Hidden",
      path: "/skills/hidden/SKILL.md",
      root: "/skills/hidden",
      scope: "project",
      userInvocable: false,
    }));
    const out = await dispatchSlashCommand(
      { name: "hidden", argsRaw: "", isMcp: false },
      stubCtx({
        session: {
          services: {
            skillsManager: {
              resolveSkill,
              skillsForConfig: async () => ({ invokedSkills: [] }),
            },
          },
        } as unknown as SlashCommandContext["session"],
      }),
      registry,
    );

    expect(out.result).toEqual({
      kind: "error",
      message: "Unknown command: /hidden",
    });
    expect(resolveSkill).not.toHaveBeenCalled();
  });

  it("returns { kind: 'skip' } when the cwd has a file matching the unknown name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-dispatcher-"));
    try {
      writeFileSync(path.join(dir, "notes.txt"), "data");
      const out = await dispatchSlashCommand(
        { name: "notes.txt", argsRaw: "", isMcp: false },
        stubCtx({ cwd: dir }),
        registry,
      );
      expect(out.result).toEqual({ kind: "skip" });
      expect(out.trace.resultKind).toBe("skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns { kind: 'skip' } for extensionless cwd files when no command is registered", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-dispatcher-"));
    try {
      writeFileSync(path.join(dir, "notes"), "data");
      const parsed = parseSlashCommand("/notes");
      expect(parsed).not.toBeNull();
      const out = await dispatchSlashCommand(
        parsed!,
        stubCtx({ cwd: dir }),
        registry,
      );
      expect(out.result).toEqual({ kind: "skip" });
      expect(out.trace.resultKind).toBe("skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches thrown exceptions from execute and surfaces them as errors", async () => {
    registry.register(
      cmd("boom", async () => {
        throw new Error("kaboom");
      }),
    );
    const out = await dispatchSlashCommand(
      { name: "boom", argsRaw: "", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.result).toEqual({ kind: "error", message: "kaboom" });
  });

  it("rejects userInvocable: false commands", async () => {
    registry.register(
      cmd(
        "internal",
        async () => ({ kind: "text", text: "should not reach" }),
        { userInvocable: false },
      ),
    );
    const out = await dispatchSlashCommand(
      { name: "internal", argsRaw: "", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.result.kind).toBe("error");
    if (out.result.kind === "error") {
      expect(out.result.message).toMatch(/not user-invocable/);
    }
  });

  it("rejects disabled commands before execute runs", async () => {
    const execute = vi.fn(async () => ({ kind: "text", text: "nope" } as const));
    registry.register(
      cmd("gated", execute, { isEnabled: () => false }),
    );
    const out = await dispatchSlashCommand(
      { name: "gated", argsRaw: "", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.result.kind).toBe("error");
    if (out.result.kind === "error") {
      expect(out.result.message).toContain("disabled");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(out.trace.resultKind).toBe("error");
  });

  it("masks sensitive args in the emitted trace", async () => {
    registry.register(
      cmd(
        "apikey",
        async () => ({ kind: "text", text: "saved" }),
        { sensitive: true },
      ),
    );
    const out = await dispatchSlashCommand(
      { name: "apikey", argsRaw: "sk-very-secret", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.trace.sensitive).toBe(true);
    expect(out.trace.argsRaw).toBe("***redacted***");
    expect(out.trace.argsRaw).not.toContain("sk-very-secret");
  });

  it("exposes immediate=true flag to caller", async () => {
    registry.register(
      cmd(
        "exit",
        async () => ({ kind: "exit", code: 0 }),
        { immediate: true },
      ),
    );
    const out = await dispatchSlashCommand(
      { name: "exit", argsRaw: "", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.immediate).toBe(true);
    expect(out.trace.immediate).toBe(true);
  });

  it("forwards argsRaw to the command via ctx, not the stub", async () => {
    const spy = vi.fn(async (ctx: SlashCommandContext) => ({
      kind: "text",
      text: ctx.argsRaw,
    } as SlashCommandResult));
    registry.register(cmd("echo", spy));
    await dispatchSlashCommand(
      { name: "echo", argsRaw: "PARSED", isMcp: false },
      stubCtx({ argsRaw: "OLD" }),
      registry,
    );
    expect(spy.mock.calls[0]![0].argsRaw).toBe("PARSED");
  });

  it("does not leak sensitive args when execute throws", async () => {
    registry.register(
      cmd(
        "secret-op",
        async () => {
          throw new Error("failed");
        },
        { sensitive: true },
      ),
    );
    const out = await dispatchSlashCommand(
      { name: "secret-op", argsRaw: "top-secret", isMcp: false },
      stubCtx(),
      registry,
    );
    expect(out.trace.argsRaw).toBe("***redacted***");
    expect(out.result.kind).toBe("error");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
