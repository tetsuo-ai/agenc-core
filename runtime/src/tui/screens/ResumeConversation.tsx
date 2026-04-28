/**
 * ResumeConversation — session picker for `--resume`.
 *
 * Enumerates resumable sessions via
 * `runtime/src/session/session-store.ts::listResumableSessions(projectDir)`,
 * presents them in a simple selectable list, and invokes the caller's
 * `onResume(sessionId)` callback when the user picks one. The picker
 * supports keyboard navigation (Up/Down/Enter) and a cancel path
 * (Esc / Ctrl+C) so this surface can stand in for the upstream
 * LogSelector without pulling in upstream-only worktree, agentic
 * search, cross-project, or coordinator-mode integrations.
 *
 * Adaptations from upstream:
 *   - Drops upstream worktree/cross-project resume gating; AgenC has no
 *     `worktreePaths` notion at this layer yet.
 *   - Drops upstream `feature('COORDINATOR_MODE')` and
 *     `feature('CONTEXT_COLLAPSE')` branches.
 *   - Drops the `LogSelector` dependency and the agentic-search hook.
 *     A future tranche can layer in fuzzy filtering by replacing the
 *     simple list with `<FuzzyPicker>`.
 *   - Drops slack/IDE/voice/buddy notification side effects.
 *
 * The actual session restore (rollout replay → AppState rehydration) is
 * the runtime's job and happens behind the `onResume` callback. The
 * picker is purely a UI surface.
 */

import React, { useCallback, useEffect, useState } from "react";

import { Box, Text } from "../ink-public.js";
import { Pane } from "../design-system/Pane.js";
import { Spinner } from "../design-system/Spinner.js";
import { glyphs } from "../design-system/glyphs.js";
import { useKeybinding } from "../keybindings/KeybindingContext.js";
import {
  listResumableSessions,
  type ResumableSession,
} from "../../session/session-store.js";

export interface ResumeConversationProps {
  /**
   * Project directory to scan for resumable sessions. Caller resolves
   * this via `getProjectDir(cwd, projectRootMarkers)` from
   * `session/session-store.ts`.
   */
  readonly projectDir: string;
  /** Invoked when the user picks a session. */
  readonly onResume: (sessionId: string, session: ResumableSession) => void;
  /** Invoked when the user cancels the picker. */
  readonly onCancel?: () => void;
  /**
   * Test seam: pass a precomputed session list instead of scanning
   * disk. When omitted, the picker calls `listResumableSessions()`
   * itself on mount.
   */
  readonly initialSessions?: ReadonlyArray<ResumableSession>;
}

function formatRelativeAge(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return "just now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function NoConversationsMessage(): React.ReactElement {
  return (
    <Pane color="dim">
      <Box flexDirection="column">
        <Text>No conversations found to resume.</Text>
        <Text color="dim">
          Press Esc or Ctrl+C to exit and start a new conversation.
        </Text>
      </Box>
    </Pane>
  );
}

const SessionRow: React.FC<{
  readonly session: ResumableSession;
  readonly selected: boolean;
}> = ({ session, selected }) => {
  const pointer = selected ? glyphs.pointer : " ";
  const labelColor: "accent" | "primary" = selected ? "accent" : "primary";
  return (
    <Box flexDirection="row">
      <Text color={labelColor}>{`${pointer} `}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={labelColor}>{session.sessionId}</Text>
        <Text color="dim">
          {`  └ ${formatRelativeAge(session.lastModified)} · ${formatBytes(session.fileSize)}${
            session.agencVersion ? ` · ${session.agencVersion}` : ""
          }`}
        </Text>
      </Box>
    </Box>
  );
};

export function ResumeConversation({
  projectDir,
  onResume,
  onCancel,
  initialSessions,
}: ResumeConversationProps): React.ReactElement {
  const [sessions, setSessions] = useState<ReadonlyArray<ResumableSession>>(
    initialSessions ?? [],
  );
  const [loading, setLoading] = useState<boolean>(initialSessions === undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (initialSessions !== undefined) return;
    let cancelled = false;
    setLoading(true);
    try {
      const list = listResumableSessions(projectDir);
      if (!cancelled) {
        setSessions(list);
        setLoading(false);
      }
    } catch (err) {
      if (!cancelled) {
        setErrorMessage(
          err instanceof Error ? err.message : String(err ?? "unknown error"),
        );
        setLoading(false);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [projectDir, initialSessions]);

  const moveSelection = useCallback(
    (delta: number) => {
      setSelectedIndex((prev) => {
        if (sessions.length === 0) return 0;
        const next = (prev + delta + sessions.length) % sessions.length;
        return next;
      });
    },
    [sessions.length],
  );

  const confirmSelection = useCallback(() => {
    if (sessions.length === 0) return;
    const picked = sessions[selectedIndex] ?? sessions[0];
    if (!picked) return;
    onResume(picked.sessionId, picked);
  }, [onResume, sessions, selectedIndex]);

  const cancelPicker = useCallback(() => {
    onCancel?.();
  }, [onCancel]);

  useKeybinding("scroll:lineUp", () => moveSelection(-1), "modal");
  useKeybinding("scroll:lineDown", () => moveSelection(1), "modal");
  useKeybinding("modal:confirm", confirmSelection, "modal");
  useKeybinding("modal:cancel", cancelPicker, "modal");
  useKeybinding("app:interrupt", cancelPicker, "modal");

  if (loading) {
    return (
      <Pane>
        <Box>
          <Spinner />
          <Text> Loading conversations…</Text>
        </Box>
      </Pane>
    );
  }

  if (errorMessage) {
    return (
      <Pane color="error">
        <Box flexDirection="column">
          <Text color="error">Failed to enumerate sessions.</Text>
          <Text>{errorMessage}</Text>
        </Box>
      </Pane>
    );
  }

  if (sessions.length === 0) {
    return <NoConversationsMessage />;
  }

  return (
    <Pane color="accent">
      <Box flexDirection="column">
        <Text bold>Resume a conversation</Text>
        <Text dimColor>
          {`${sessions.length} session${sessions.length === 1 ? "" : "s"} · ↑/↓ to move · Enter to resume · Esc to cancel`}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {sessions.map((session, idx) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              selected={idx === selectedIndex}
            />
          ))}
        </Box>
      </Box>
    </Pane>
  );
}

export default ResumeConversation;
