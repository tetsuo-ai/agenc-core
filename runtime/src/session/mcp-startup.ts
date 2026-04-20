/**
 * MCP manager attachment seam.
 *
 * The CLI entry point (`bin/agenc.ts`) does not yet construct an
 * `MCPManager` directly — the T9 MCP wiring for the CLI is still
 * deferred to `services.mcpManager` being a live instance. The
 * observer helpers in `observer-wiring.ts` build a ready-to-install
 * `MCPCallObserver`, but until this helper runs the observer is
 * unreferenced and `mcp_tool_call_begin` / `mcp_tool_call_end`
 * events silently drop for any future MCP plumbing.
 *
 * `attachMcpManagerToSession` is the single canonical attach site so
 * every owner (CLI, daemon, tests) wires the observer the same way.
 * Call this BEFORE `manager.start()`; the bridge factory bakes the
 * observer into every per-tool `execute()` closure at creation time,
 * so attaching after `start()` only covers bridges created afterwards.
 *
 * This module also ships `getMcpConfigFromEnv()`, a minimal escape
 * hatch that lets ops inject MCP servers via the
 * `AGENC_MCP_SERVERS` env var until the full `~/.agenc/config.toml`
 * plumbing lands (T10). The env var must be a JSON array of
 * `MCPServerConfig` objects.
 *
 * @module
 */

import type { MCPManager } from "../mcp-client/manager.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
import type { Session } from "./session.js";
import {
  createMCPCallObserverForSlot,
  type SessionSlot,
} from "./observer-wiring.js";

/**
 * Attach a session's MCP call observer to an `MCPManager`. Must run
 * BEFORE `manager.start()` so `mcp_tool_call_begin` /
 * `mcp_tool_call_end` events are captured from the very first bridge.
 *
 * The helper tolerates `sessionSlot.current === null` (the slot may
 * still be unfilled at wiring time) — the slot-bound observer silently
 * drops events until the slot is populated.
 */
export function attachMcpManagerToSession(
  manager: MCPManager,
  session: Session,
  sessionSlot: SessionSlot,
): void {
  if (sessionSlot.current === null) {
    sessionSlot.current = session;
  }
  const observer = createMCPCallObserverForSlot(sessionSlot);
  try {
    manager.setCallObserver(observer);
  } catch (err) {
    // Surface the failure through the session's event log so ops
    // can see that MCP telemetry is missing rather than silently
    // dropping events.
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "error",
        payload: {
          cause: "mcp_observer_attach_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      },
    });
    throw err;
  }
}

/**
 * Read `AGENC_MCP_SERVERS` and parse it as a JSON array of
 * `MCPServerConfig`. Returns `[]` when the env var is unset, empty,
 * or malformed — the caller can still construct an `MCPManager`
 * with an empty config so the observer-attach site remains live.
 *
 * T10 will replace this with a real `~/.agenc/config.toml` resolver.
 */
export function getMcpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MCPServerConfig[] {
  const raw = env.AGENC_MCP_SERVERS;
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is MCPServerConfig =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { name?: unknown }).name === "string",
    );
  } catch {
    return [];
  }
}
