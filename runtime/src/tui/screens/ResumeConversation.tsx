/**
 * ResumeConversation — session picker for `--resume`.
 *
 * Enumerates resumable sessions via
 * `runtime/src/session/session-store.ts::listResumableSessions(projectDir)`,
 * presents them in a simple selectable list, and invokes the caller's
 * `onResume(sessionId)` callback when the user picks one. The picker
 * supports keyboard navigation (Up/Down/Enter), local type-to-filter
 * search over the `ResumableSession` fields AgenC already persists, and
 * a cancel path (Esc / Ctrl+C) so this surface can stand in for the
 * source runtime LogSelector without pulling in source runtime-only worktree,
 * agentic search, cross-project, remote/cloud, IDE, or coordinator-mode
 * integrations.
 *
 * Adaptations from source runtime:
 *   - Drops source runtime worktree/cross-project resume gating; AgenC has no
 *     `worktreePaths` notion at this layer yet.
 *   - Drops source runtime `feature('COORDINATOR_MODE')` and
 *     `feature('CONTEXT_COLLAPSE')` branches.
 *   - Drops the `LogSelector` dependency and the agentic-search hook.
 *     The local search here is intentionally metadata-only: no remote
 *     search, no cloud resume, no IDE/worktree filters, and no fake rows
 *     for state AgenC does not track.
 *   - Drops slack/IDE/voice/buddy notification side effects.
 *
 * The actual session restore (rollout replay → AppState rehydration) is
 * the runtime's job and happens behind the `onResume` callback. The
 * picker is purely a UI surface.
 */

import { basename } from "node:path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Box, Text, useInput } from "../ink-public.js";
import { Pane } from "../design-system/Pane.js";
import { Spinner } from "../design-system/Spinner.js";
import { glyphs } from "../design-system/glyphs.js";
import {
  useActiveKeybindingContext,
  useKeybinding,
  useSetKeybindingContext,
} from "../keybindings/KeybindingContext.js";
import {
  listResumableSessions,
  type ResumableSession,
} from "../../session/session-store.js";
import { listIndexedResumableSessions } from "../../state/resume.js";

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
  /** Optional initial metadata search query, matching OpenClaude's picker entry. */
  readonly initialSearchQuery?: string;
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

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function buildResumeSearchText(session: ResumableSession): string {
  return normalizeSearchText(
    [
      session.sessionId,
      session.summary,
      basename(session.rolloutPath),
      session.agencVersion,
      session.schemaVersion !== undefined
        ? `schema ${session.schemaVersion}`
        : undefined,
      new Date(session.lastModified).toISOString(),
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" "),
  );
}

export function filterResumableSessions(
  sessions: ReadonlyArray<ResumableSession>,
  query: string,
): ReadonlyArray<ResumableSession> {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  if (terms.length === 0) return sessions;
  return sessions.filter((session) => {
    const haystack = buildResumeSearchText(session);
    return terms.every((term) => haystack.includes(term));
  });
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
  const rolloutName = basename(session.rolloutPath);
  const summary =
    session.summary && session.summary !== rolloutName
      ? session.summary
      : session.sessionId;
  return (
    <Box flexDirection="row">
      <Text color={labelColor}>{`${pointer} `}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={labelColor}>{summary}</Text>
        <Text color="dim">
          {`  └ ${session.sessionId} · ${formatRelativeAge(session.lastModified)} · ${formatBytes(session.fileSize)}${
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
  initialSearchQuery,
}: ResumeConversationProps): React.ReactElement {
  const [sessions, setSessions] = useState<ReadonlyArray<ResumableSession>>(
    initialSessions ?? [],
  );
  const [loading, setLoading] = useState<boolean>(initialSessions === undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [query, setQuery] = useState(initialSearchQuery ?? "");
  const setKeybindingContext = useSetKeybindingContext();
  const activeKeybindingContext = useActiveKeybindingContext();
  const initialKeybindingContext = useRef(activeKeybindingContext);

  useEffect(() => {
    setKeybindingContext("modal");
    return () => {
      setKeybindingContext(initialKeybindingContext.current);
    };
  }, [setKeybindingContext]);

  useEffect(() => {
    if (initialSessions !== undefined) return;
    let cancelled = false;
    setLoading(true);
    try {
      const indexed = listIndexedResumableSessions(projectDir);
      const list =
        indexed.length > 0 ? indexed : listResumableSessions(projectDir);
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

  const filteredSessions = useMemo(
    () => filterResumableSessions(sessions, query),
    [sessions, query],
  );

  useEffect(() => {
    setSelectedIndex((prev) => {
      if (filteredSessions.length === 0) return 0;
      return Math.min(prev, filteredSessions.length - 1);
    });
  }, [filteredSessions.length]);

  const moveSelection = useCallback(
    (delta: number) => {
      setSelectedIndex((prev) => {
        if (filteredSessions.length === 0) return 0;
        const next =
          (prev + delta + filteredSessions.length) % filteredSessions.length;
        return next;
      });
    },
    [filteredSessions.length],
  );

  const confirmSelection = useCallback(() => {
    if (filteredSessions.length === 0) return;
    const picked = filteredSessions[selectedIndex] ?? filteredSessions[0];
    if (!picked) return;
    onResume(picked.sessionId, picked);
  }, [onResume, filteredSessions, selectedIndex]);

  const cancelPicker = useCallback(() => {
    onCancel?.();
  }, [onCancel]);

  const cancelSearchOrPicker = useCallback(() => {
    if (query.length > 0) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    onCancel?.();
  }, [onCancel, query.length]);

  useKeybinding("scroll:lineUp", () => moveSelection(-1), "modal");
  useKeybinding("scroll:lineDown", () => moveSelection(1), "modal");
  useKeybinding("modal:confirm", confirmSelection, "modal");
  useKeybinding("modal:cancel", cancelSearchOrPicker, "modal");
  useKeybinding("app:interrupt", cancelPicker, "global");

  useInput((input, key, event) => {
    if (loading) return;
    if (key.escape && query.length > 0) {
      event.stopImmediatePropagation();
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    if (key.backspace || key.delete) {
      event.stopImmediatePropagation();
      setQuery((prev) => prev.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (
      key.ctrl ||
      key.meta ||
      key.super ||
      key.return ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown ||
      key.home ||
      key.end
    ) {
      return;
    }
    const printable = input.replace(/[\r\n\t]/g, "");
    if (printable.length === 0) return;
    event.stopImmediatePropagation();
    setQuery((prev) => prev + printable);
    setSelectedIndex(0);
  });

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

  if (filteredSessions.length === 0) {
    return (
      <Pane color="dim">
        <Box flexDirection="column">
          <Text bold>Resume a conversation</Text>
          <Text dimColor>{`Search: ${query}`}</Text>
          <Text>No matching conversations found.</Text>
          <Text color="dim">
            Press Esc to clear search, or Ctrl+C to exit.
          </Text>
        </Box>
      </Pane>
    );
  }

  return (
    <Pane color="accent">
      <Box flexDirection="column">
        <Text bold>Resume a conversation</Text>
        <Text dimColor>
          {`${filteredSessions.length} of ${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${
            query ? `search: ${query}` : "type to search"
          } · ↑/↓ to move · Enter to resume · Esc to cancel`}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {filteredSessions.map((session, idx) => (
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
