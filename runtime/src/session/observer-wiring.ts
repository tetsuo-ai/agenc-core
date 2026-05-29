/**
 * T6 gap #119 — session-level observer wiring for MCP and bash tool
 * lifecycle events.
 *
 * `MCPCallObserver` (runtime/src/mcp-client/tools.ts) and
 * `BashExecObserver` (runtime/src/tools/system/types.ts) are tool-layer
 * hooks with no `Session` dependency: the bridges/factories call them
 * but stay session-agnostic. This module is the single place that
 * bridges those hooks to `session.emit(...)` so `mcp_tool_call_begin` /
 * `mcp_tool_call_end` / `exec_command_begin` / `exec_command_end`
 * EventMsg variants actually land in the event log + rollout (T6).
 *
 * Why this lives here, not in the bin entrypoint: every session owner
 * (CLI, daemon, tests) must wire these the same way to keep the
 * rollout faithful; colocating the helpers with `Session` keeps the
 * canonical wiring close to the consumer that needs it.
 *
 * @module
 */

import type { Session } from "./session.js";
import type { Event } from "./event-log.js";
import type { MCPCallObserver } from "../mcp-client/tools.js";
import type { BashExecObserver } from "../tools/system/types.js";

/**
 * Structural subset of `Session` the wiring helpers actually depend
 * on. Keeping this narrow lets integration tests stub the emitter
 * without constructing a full `Session` container.
 */
export interface ObserverSessionSink {
  nextInternalSubId(): string;
  emit(event: Event): void;
}

// Compile-time check that a `Session` satisfies the narrowed sink.
const _assignable: (s: Session) => ObserverSessionSink = (s) => s;
void _assignable;

/**
 * Late-bound session slot. Callers that have to build observers
 * BEFORE the `Session` exists (tool registries are wired before
 * `new Session(...)` in bin/agenc.ts) allocate a slot, pass it to
 * `createMCPCallObserverForSlot` / `createBashExecObserverForSlot`,
 * and fill the slot once the session is ready. Observers dispatched
 * through an unfilled slot silently drop — which matches the
 * "no session yet, no event log to write to" semantics.
 */
export interface SessionSlot {
  current: ObserverSessionSink | null;
}

/**
 * Build an MCP call observer bound to `session.emit(...)`. Pass the
 * return value to `MCPManager.setCallObserver(...)` before the first
 * `connectServer` call so every bridge sees the observer at creation
 * time. Calling after connect is a no-op for already-connected
 * bridges because the observer is baked into each bridge's
 * `execute()` closure at factory time.
 */
export function createMCPCallObserverForSession(
  session: ObserverSessionSink,
): MCPCallObserver {
  return createMCPCallObserverForSlot({ current: session });
}

/**
 * Slot-bound variant. Safe to build before the Session exists;
 * events emitted while `slot.current === null` are dropped.
 */
export function createMCPCallObserverForSlot(
  slot: SessionSlot,
): MCPCallObserver {
  return {
    onBegin: ({ callId, server, toolName, args }) => {
      const session = slot.current;
      if (!session) return;
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "mcp_tool_call_begin",
          payload: { callId, server, toolName, args },
        },
      });
    },
    onEnd: ({ callId, result, isError, durationMs }) => {
      const session = slot.current;
      if (!session) return;
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "mcp_tool_call_end",
          payload: { callId, result, isError, durationMs },
        },
      });
    },
  };
}

/**
 * Build a bash exec observer bound to `session.emit(...)`. Pass the
 * return value to `buildToolRegistry({ ..., bashExecObserver })` so
 * the `createBashTool` factory routes spawn lifecycle callbacks
 * through the session event log.
 */
export function createBashExecObserverForSession(
  session: ObserverSessionSink,
): BashExecObserver {
  return createBashExecObserverForSlot({ current: session });
}

/**
 * Slot-bound variant. Safe to build before the Session exists;
 * events emitted while `slot.current === null` are dropped.
 */
export function createBashExecObserverForSlot(
  slot: SessionSlot,
): BashExecObserver {
  return {
    onBegin: ({ callId, command, cwd, processId, sessionId, tty }) => {
      const session = slot.current;
      if (!session) return;
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "exec_command_begin",
          payload: {
            callId,
            command,
            cwd,
            ...(processId !== undefined ? { processId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(tty !== undefined ? { tty } : {}),
          },
        },
      });
    },
    onEnd: ({
      callId,
      exitCode,
      stdout,
      stderr,
      durationMs,
      processId,
      sessionId,
      tty,
    }) => {
      const session = slot.current;
      if (!session) return;
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "exec_command_end",
          payload: {
            callId,
            exitCode,
            ...(stdout !== undefined ? { stdout } : {}),
            ...(stderr !== undefined ? { stderr } : {}),
            durationMs,
            ...(processId !== undefined ? { processId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(tty !== undefined ? { tty } : {}),
          },
        },
      });
    },
  };
}
