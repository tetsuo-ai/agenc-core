import React, { useEffect, useState } from "react";

import ThemedText from "../components/design-system/ThemedText.js";
import { selectAgenCTuiGlyphs } from "../glyphs.js";
import Box from "../ink/components/Box.js";
import { useInputCapture } from "../keybindings/useKeybinding.js";
import { collectGitDetail, type GitDetail } from "./project-tree/gitDetail.js";
import {
  formatGitBranchName,
  formatGitBranchCounters,
} from "./project-tree/GitBranchFooter.js";
import type { ProjectTreeGitBranch } from "./types.js";

const VISIBLE_CHANGES = 12;

/**
 * The panel behind the WORKSPACE footer branch chip: where the repository is,
 * what HEAD is, and what is uncommitted right now.
 *
 * Read on open rather than polled — it is a thing you look at, not a thing you
 * watch, and the footer chip already carries the live counters.
 */
export function GitDetailOverlay({
  cwd,
  git,
  onClose,
}: {
  readonly cwd: string;
  readonly git: ProjectTreeGitBranch | null | undefined;
  readonly onClose: () => void;
}): React.ReactElement {
  const glyphs = selectAgenCTuiGlyphs();
  const [detail, setDetail] = useState<GitDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    void collectGitDetail(cwd).then((value) => {
      if (!cancelled) setDetail(value);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // A read-only panel, but it owns the keyboard while open: consume in the
  // Modal capture phase so esc closes THIS and not whatever is underneath.
  useInputCapture(
    React.useCallback(
      (input, key) => {
        if (key.escape || input.toLowerCase() === "q") onClose();
        return true;
      },
      [onClose],
    ),
    { context: "Modal", isActive: true },
  );

  const counters = git ? formatGitBranchCounters(git, glyphs) : "";
  const hidden = Math.max(0, (detail?.changes.length ?? 0) - VISIBLE_CHANGES);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <ThemedText color="text" bold>
          {git ? formatGitBranchName(git, glyphs) : `${glyphs.gitBranch} git`}
        </ThemedText>
        {counters ? (
          <ThemedText color={git && git.dirtyCount > 0 ? "warning" : "subtle"}>
            {counters}
          </ThemedText>
        ) : null}
        {git?.upstream ? (
          <ThemedText color="inactive">{`→ ${git.upstream}`}</ThemedText>
        ) : null}
      </Box>

      {detail === null ? (
        <ThemedText color="inactive">reading git{glyphs.ellipsis}</ThemedText>
      ) : detail.error !== undefined ? (
        <ThemedText color="error">{detail.error}</ThemedText>
      ) : (
        <>
          <Row label="HEAD" value={`${detail.head ?? "—"}  ${detail.subject ?? ""}`} />
          <Row label="author" value={detail.author ?? "—"} />
          <Row label="date" value={detail.date ?? "—"} />
          <Row label="path" value={detail.root ?? "—"} />
          <Box marginTop={1}>
            <ThemedText color="subtle">
              {detail.changes.length === 0
                ? "working tree clean"
                : `${detail.changes.length} changed`}
            </ThemedText>
          </Box>
          {detail.changes.slice(0, VISIBLE_CHANGES).map((change) => (
            <Box key={`${change.code}:${change.path}`} flexDirection="row" gap={1}>
              <ThemedText color={change.staged ? "success" : "warning"}>
                {change.code}
              </ThemedText>
              <ThemedText color="text2" wrap="truncate-middle">
                {change.path}
              </ThemedText>
            </Box>
          ))}
          {hidden > 0 ? (
            <ThemedText color="inactive">{`${glyphs.ellipsis} +${hidden} more`}</ThemedText>
          ) : null}
        </>
      )}

      <Box marginTop={1}>
        <ThemedText color="inactive">esc to close</ThemedText>
      </Box>
    </Box>
  );
}

function Row({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1}>
      <Box width={7} flexShrink={0}>
        <ThemedText color="inactive">{label}</ThemedText>
      </Box>
      <ThemedText color="text2" wrap="truncate-middle">
        {value}
      </ThemedText>
    </Box>
  );
}
