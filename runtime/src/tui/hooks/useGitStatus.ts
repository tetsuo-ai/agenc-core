import { useEffect, useRef, useState } from 'react';
import { useTerminalFocus } from '../ink.js';
import { useStatusTurnBusy } from '../context/statusEffortContext.js';
import { probeGitStatus, type GitStatus } from '../git-status.js';
import type { AgenCBridgeSession } from '../session-types.js';

export type GitStatusSession = Pick<AgenCBridgeSession, 'cwd' | 'sessionConfiguration'>;
/** A live fan-out of session events, without replay. */
export type GitStatusEvents = { subscribeToEvents(cb: (event: unknown) => void): () => void };
const REFRESH_MS = 30_000;

function isToolCompletion(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const record = event as { type?: string; msg?: { type?: string } };
  const type = record.msg?.type ?? record.type;
  return type === 'tool_result' || type === 'tool_call_completed' ||
    type === 'exec_command_end' || type === 'mcp_tool_call_end' || type === 'patch_apply_end';
}

/**
 * No input subscription. Coalesce busy refreshes into one follow-up after the probe.
 * Listen only to the shell's live fan-out: this chrome remounts whenever the
 * composer returns (after every approval), and a fresh daemon replay
 * subscription is refused once the session passes the replay capacity.
 */
export function useGitStatus(cwd: string, enabled: boolean, events?: GitStatusEvents): GitStatus | null {
  const focused = useTerminalFocus();
  const turnBusy = useStatusTurnBusy();
  const [snapshot, setSnapshot] = useState<{ cwd: string; status: GitStatus | null } | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let running = false;
    let dirty = false;
    const refresh = () => {
      if (cancelled) return;
      if (running) { dirty = true; return; }
      running = true;
      void probeGitStatus(cwd).then(status => {
        if (!cancelled) setSnapshot({ cwd, status });
      }).finally(() => {
        running = false;
        if (dirty && !cancelled) { dirty = false; refresh(); }
      });
    };
    refreshRef.current = refresh;
    const onEvent = (event: unknown) => { if (isToolCompletion(event)) refresh(); };
    const unsubscribeEvents = events?.subscribeToEvents(onEvent);
    const interval = setInterval(refresh, REFRESH_MS);
    interval.unref?.();
    return () => {
      cancelled = true;
      refreshRef.current = null;
      clearInterval(interval);
      unsubscribeEvents?.();
    };
  }, [cwd, enabled, events]);
  useEffect(() => { refreshRef.current?.(); }, [cwd, enabled, events, focused, turnBusy]);
  return enabled && snapshot?.cwd === cwd ? snapshot.status : null;
}
