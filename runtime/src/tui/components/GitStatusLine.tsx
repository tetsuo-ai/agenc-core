import React from 'react';
import { Box } from '../ink.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useGitStatus, type GitStatusEvents, type GitStatusSession } from '../hooks/useGitStatus.js';
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js';
import { selectAgenCTuiGlyphs } from '../glyphs.js';
import type { GitStatus } from '../git-status.js';
import { stringWidth } from '../ink/stringWidth.js';
import { truncateMiddleToWidth } from '../../utils/truncate.js';
import ThemedText from './design-system/ThemedText.js';

export function formatGitStatus(status: GitStatus | null, columns: number, glyph: string): string {
  if (!status) return '';
  const width = Number.isFinite(columns) ? Math.max(0, Math.trunc(columns)) : 0;
  const prefix = `${glyph} `;
  if (width < stringWidth(prefix) + 1) return '';
  const branch = `${prefix}${status.branch}`;
  const sync = [status.ahead > 0 ? `↑${status.ahead}` : '', status.behind > 0 ? `↓${status.behind}` : ''].filter(Boolean).join(' ');
  const facts = [status.changed > 0 ? `${status.changed} changed` : '', sync].filter(Boolean);
  while (facts.length > 0) {
    const label = [branch, ...facts].join(' · ');
    if (stringWidth(label) <= width) return label;
    facts.pop();
  }
  return prefix + truncateMiddleToWidth(status.branch, width - stringWidth(prefix));
}

export function GitStatusLine({ status, columns }: { status: GitStatus | null; columns: number }): React.ReactNode {
  const label = formatGitStatus(status, Math.max(0, columns - 4), selectAgenCTuiGlyphs().gitBranch);
  if (!label) return null;
  return (
    <Box width={columns} paddingX={2} height={1} flexShrink={0} justifyContent="flex-end" overflow="hidden">
      <ThemedText color="subtle" wrap="truncate-end">{label}</ThemedText>
    </Box>
  );
}

export function GitStatusChrome({ session, events }: {
  session: GitStatusSession;
  /** The shell's live event fan-out. Never the session's own daemon replay subscription. */
  events?: GitStatusEvents;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const enabled = useAppStateMaybeOutsideOfProvider(state => state.settings.tui?.gitStatusEnabled) !== false;
  const cwd = session.cwd ?? session.sessionConfiguration?.cwd ?? process.cwd();
  const status = useGitStatus(cwd, enabled, events);
  return <GitStatusLine status={status} columns={columns} />;
}
