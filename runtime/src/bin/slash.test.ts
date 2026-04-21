/**
 * Tests for the W3 `runSlashCommand` wrapper in `src/bin/slash.ts`.
 *
 * Scope:
 *   - Non-slash input is skipped (CLI forwards as a normal user prompt).
 *   - Known command (`/help`) routes through the dispatcher + full
 *     default registry and returns a non-error result.
 *   - Unknown commands surface as `unknown` (readable CLI routing).
 *   - I-68 fence: multi-line input is rejected (`skip`).
 *   - Bridge allowlist filter: non-bridge-safe commands are blocked
 *     when `opts.bridge === true`; bridge-safe commands pass through.
 *   - The dispatcher is wired with the Wave 2 registry (coverage
 *     spot-check for a representative command set).
 *
 * The tests use a minimal fake session whose `services` only carry
 * the fields the commands consulted below actually read.
 */

import { describe, it, expect } from "vitest";

import {
  isBridgeSafeCommand,
  runSlashCommand,
  type SlashCommandRunContext,
} from "./slash.js";
import { buildDefaultRegistry } from "../commands/registry.js";
import type { Session } from "../session/session.js";

function stubSession(): Session {
  // Commands invoked from `runSlashCommand` in this test only touch
  // `session.services` + `session.nextInternalSubId()`; the rest of the
  // Session surface is unreachable along this path.
  return {
    services: {},
    nextInternalSubId: () => "sub-test-1",
    emit: () => {
      /* no-op — events don't affect dispatch in these tests */
    },
  } as unknown as Session;
}

function stubCtx(overrides: Partial<SlashCommandRunContext> = {}): SlashCommandRunContext {
  return {
    session: stubSession(),
    cwd: "/tmp",
    home: "/home/test",
    ...overrides,
  };
}

describe("runSlashCommand — skip / parse gating", () => {
  it("returns { kind: 'skip' } for non-slash input", async () => {
    const result = await runSlashCommand("hello world", stubCtx());
    expect(result).toEqual({ kind: "skip" });
  });

  it("returns { kind: 'skip' } for empty input", async () => {
    const result = await runSlashCommand("", stubCtx());
    expect(result).toEqual({ kind: "skip" });
  });

  it("I-68: returns { kind: 'skip' } when a slash line is followed by non-whitespace lines", async () => {
    // The dispatcher's parser enforces I-68; when a following line has
    // non-whitespace content we reject the parse (null), which surfaces
    // to the caller as `skip`.
    const result = await runSlashCommand("/help\nsome extra text", stubCtx());
    expect(result).toEqual({ kind: "skip" });
  });

  it("accepts a trailing newline only (I-68-compatible)", async () => {
    // `/help\n` with no follow-up content must parse + dispatch.
    const result = await runSlashCommand("/help\n", stubCtx());
    expect(result.kind).toBe("dispatched");
  });
});

describe("runSlashCommand — known-command dispatch", () => {
  it("routes /help through the dispatcher with a text result", async () => {
    const result = await runSlashCommand("/help", stubCtx());
    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") throw new Error("unreachable");
    // /help emits text even with no registry-backed state (W1-F
    // dispatcher + W3 registry combo).
    expect(result.result.kind).toBe("text");
    // The W3 registry is fully populated, so `/help` must list real
    // commands rather than the "registry pending" fallback.
    if (result.result.kind !== "text") throw new Error("unreachable");
    expect(result.result.text).toContain("/help");
  });

  it("unknown commands surface as { kind: 'unknown' }", async () => {
    const result = await runSlashCommand(
      "/definitely-not-a-real-command",
      stubCtx(),
    );
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("unreachable");
    expect(result.message).toMatch(/Unknown command/);
    expect(result.message).toContain("/definitely-not-a-real-command");
  });
});

describe("runSlashCommand — bridge allowlist", () => {
  it("blocks a non-bridge-safe command when opts.bridge is true", async () => {
    // `/exit` is intentionally NOT on the bridge-safe list (it mutates
    // process state). Bridged callers must be rejected before dispatch.
    const result = await runSlashCommand("/exit", stubCtx(), { bridge: true });
    expect(result.kind).toBe("blocked_by_bridge");
    if (result.kind !== "blocked_by_bridge") throw new Error("unreachable");
    expect(result.message).toContain("/exit");
    expect(result.message).toMatch(/bridge/i);
    // Sanity: the isBridgeSafeCommand gate agrees.
    expect(isBridgeSafeCommand("exit")).toBe(false);
  });

  it("allows a bridge-safe command (/help) when opts.bridge is true", async () => {
    expect(isBridgeSafeCommand("help")).toBe(true);
    const result = await runSlashCommand("/help", stubCtx(), { bridge: true });
    expect(result.kind).toBe("dispatched");
  });

  it("ignores the bridge gate when opts.bridge is not set", async () => {
    // Local CLI path: every registered command dispatches, including
    // commands that would be unsafe over a bridge.
    const result = await runSlashCommand("/exit", stubCtx());
    expect(result.kind).toBe("dispatched");
  });
});

describe("buildDefaultRegistry — W3 coverage spot-check", () => {
  // Keep this small sanity sweep alongside the other tests so the W3
  // wiring tests fail loudly if a Wave 2 command is accidentally dropped
  // from the default registry.
  const REQUIRED_COMMANDS = [
    "help",
    "status",
    "init",
    "diff",
    "exit",
    "clear",
    "context",
    "keybindings",
    "resume",
    "fork",
    "plan",
    "permissions",
    "config",
    "model",
    "provider",
    "compact",
    "enter-worktree",
    "exit-worktree",
  ];

  it("exposes every Wave 1 + Wave 2 command by name", () => {
    const reg = buildDefaultRegistry();
    for (const name of REQUIRED_COMMANDS) {
      expect(reg.has(name)).toBe(true);
    }
  });
});
