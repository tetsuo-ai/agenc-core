/**
 * Tests for the `runSlashCommand` wrapper in `src/bin/slash.ts`.
 *
 * After T11 restoration the canonical slash-command registry +
 * dispatcher (under `src/commands/**`) is wired through the
 * per-dir `_deps/commands.ts` shim. The bin entry routes parsed
 * slash input through the real dispatcher, so the tests below
 * exercise both the wrapper-level routing variants (skip /
 * passthrough / unknown / blocked_by_bridge) and a smoke test
 * that a real registered command (`/help`) returns a `dispatched`
 * outcome rather than `Unknown command`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  isBridgeSafeCommand,
  runSlashCommand,
  type SlashCommandRunContext,
} from "./slash.js";
import type { Session } from "../session/session.js";

function stubSession(): Session {
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

  it("returns { kind: 'skip' } when a multi-line slash-prefixed input violates I-68", async () => {
    const result = await runSlashCommand("/help\nfollowup", stubCtx());
    expect(result).toEqual({ kind: "skip" });
  });
});

describe("runSlashCommand — unknown command routing", () => {
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

  it("passes extensionless cwd files through as prompt input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-slash-"));
    try {
      writeFileSync(join(dir, "README"), "read me");
      const result = await runSlashCommand("/README", stubCtx({ cwd: dir }));
      expect(result).toEqual({ kind: "passthrough", input: "/README" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let cwd files shadow registered commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-slash-"));
    try {
      writeFileSync(join(dir, "help"), "not a command");
      const result = await runSlashCommand("/help", stubCtx({ cwd: dir }));
      expect(result.kind).toBe("dispatched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runSlashCommand — bridge allowlist", () => {
  it("blocks bridge-unsafe commands when opts.bridge is true", async () => {
    const result = await runSlashCommand("/exit", stubCtx(), { bridge: true });
    expect(result.kind).toBe("blocked_by_bridge");
    if (result.kind !== "blocked_by_bridge") throw new Error("unreachable");
    expect(result.message).toContain("/exit");
    expect(result.message).toMatch(/bridge/i);
    expect(isBridgeSafeCommand("exit")).toBe(false);
  });

  it("allows bridge-safe commands when opts.bridge is true", async () => {
    // `/help` is on the BRIDGE_SAFE allowlist (read-only command).
    const result = await runSlashCommand("/help", stubCtx(), { bridge: true });
    expect(result.kind).not.toBe("blocked_by_bridge");
    expect(isBridgeSafeCommand("help")).toBe(true);
  });

  it("allows canonical /model-provider over the bridge", async () => {
    const result = await runSlashCommand(
      "/model-provider openai gpt-5",
      stubCtx(),
      { bridge: true },
    );
    expect(result.kind).not.toBe("blocked_by_bridge");
    expect(isBridgeSafeCommand("model-provider")).toBe(true);
  });

  it("ignores the bridge gate when opts.bridge is not set", async () => {
    // Local CLI path: the dispatcher is reached and `/help` runs.
    const result = await runSlashCommand("/help", stubCtx());
    expect(result.kind).toBe("dispatched");
  });
});

describe("runSlashCommand — real command dispatch smoke", () => {
  it("/help returns a dispatched text result (registry is live)", async () => {
    const result = await runSlashCommand("/help", stubCtx());
    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") throw new Error("unreachable");
    expect(result.result.kind).toBe("text");
    if (result.result.kind !== "text") throw new Error("unreachable");
    // Real /help text should mention the command surface.
    expect(result.result.text.length).toBeGreaterThan(0);
  });

  it("/provider dispatches through the canonical /model-provider command", async () => {
    const result = await runSlashCommand("/provider openai gpt-5", stubCtx());
    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") throw new Error("unreachable");
    expect(result.outcome.trace.name).toBe("model-provider");
    expect(result.outcome.trace.aliasUsed).toBe("provider");
  });
});
