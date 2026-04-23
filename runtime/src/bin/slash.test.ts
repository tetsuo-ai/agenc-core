/**
 * Tests for the `runSlashCommand` wrapper in `src/bin/slash.ts`.
 *
 * After the openclaude-port gut, the canonical slash-command registry
 * + dispatcher (formerly under `src/commands/**`) has been removed.
 * The bin entry point now sits on top of the per-dir
 * `_deps/commands.ts` shim, which:
 *   - provides a permissive parser for `/name args…`
 *   - returns `Unknown command: /<name>` for every dispatch
 *   - exposes an empty bridge-safe allowlist
 *   - returns a no-op default registry
 *
 * As a result, real command behavior (`/help`, `/exit`, …), the
 * registry coverage spot-check, and bridge-allowlist gating no longer
 * exercise live functionality and have been removed. What remains:
 *   - non-slash / empty input is rejected as `skip`
 *   - unknown slash commands surface as `kind: "unknown"` for routing
 *   - the bridge gate still blocks every command (allowlist is empty)
 *     when `opts.bridge === true`
 */

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
});

describe("runSlashCommand — bridge allowlist", () => {
  it("blocks any command when opts.bridge is true (empty allowlist after gut)", async () => {
    // The lean rebuild's `_deps/commands.ts` shim ships an empty
    // BRIDGE_SAFE set, so every command is rejected over the bridge
    // path until a real allowlist is reintroduced.
    const result = await runSlashCommand("/anything", stubCtx(), { bridge: true });
    expect(result.kind).toBe("blocked_by_bridge");
    if (result.kind !== "blocked_by_bridge") throw new Error("unreachable");
    expect(result.message).toContain("/anything");
    expect(result.message).toMatch(/bridge/i);
    expect(isBridgeSafeCommand("anything")).toBe(false);
  });

  it("ignores the bridge gate when opts.bridge is not set", async () => {
    // Local CLI path: the dispatcher is reached (and surfaces
    // unknown-command as `unknown`).
    const result = await runSlashCommand("/anything", stubCtx());
    expect(result.kind).toBe("unknown");
  });
});
