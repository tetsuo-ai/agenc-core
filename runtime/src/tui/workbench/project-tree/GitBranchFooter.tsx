import type React from "react";

import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import Box from "../../ink/components/Box.js";
import ThemedText from "../../components/design-system/ThemedText.js";
import type { ProjectTreeGitBranch } from "../types.js";

/**
 * Renders the branch the workspace is on, in one line, formatted for a narrow
 * column. Returns null outside a repository so the footer keeps its old shape.
 *
 * Order is by how often it changes the reader's mind: branch, then divergence
 * from upstream, then how much is uncommitted. A detached HEAD has no branch
 * name, so the short sha stands in — otherwise the panel would silently show
 * nothing on exactly the checkout where you most want to know where you are.
 */
export function formatGitBranchSummary(
  git: ProjectTreeGitBranch,
  glyphs: { readonly gitBranch: string; readonly arrowUp: string; readonly arrowDown: string },
): string {
  const name = formatGitBranchName(git, glyphs);
  const counters = formatGitBranchCounters(git, glyphs);
  return counters === "" ? name : `${name}  ${counters}`;
}

/** The part that answers "where am I" — always present, always the brightest. */
export function formatGitBranchName(
  git: ProjectTreeGitBranch,
  glyphs: { readonly gitBranch: string },
): string {
  const label = git.branch ?? git.head ?? "detached";
  return git.branch === null && git.head !== null
    ? `${glyphs.gitBranch} ${label} (detached)`
    : `${glyphs.gitBranch} ${label}`;
}

/**
 * Divergence and dirty count. Separated from the name by two spaces and from
 * each other by the interpunct the rest of the chrome uses: at terminal sizes
 * a single space between a word and an arrow glyph reads as one token
 * (`main↑2`), which is exactly the complaint this format answers.
 */
export function formatGitBranchCounters(
  git: ProjectTreeGitBranch,
  glyphs: { readonly arrowUp: string; readonly arrowDown: string },
): string {
  const parts: string[] = [];
  if (git.ahead) parts.push(`${glyphs.arrowUp}${git.ahead}`);
  if (git.behind) parts.push(`${glyphs.arrowDown}${git.behind}`);
  if (git.dirtyCount > 0) parts.push(`${git.dirtyCount}*`);
  return parts.join(" · ");
}

export function GitBranchFooter({
  git,
  onOpen,
}: {
  readonly git: ProjectTreeGitBranch | null | undefined;
  readonly onOpen?: () => void;
}): React.ReactNode {
  if (git === null || git === undefined) return null;
  const glyphs = selectAgenCTuiGlyphs();
  const counters = formatGitBranchCounters(git, glyphs);
  return (
    <Box
      flexShrink={0}
      flexDirection="row"
      gap={1}
      {...(onOpen !== undefined ? { onClick: onOpen } : {})}
    >
      {/*
        The branch name is the one thing in this footer worth reading at a
        glance, so it gets full `text` weight rather than the `inactive` tone
        of the counts above it — at `inactive` against the black panel it was
        reported as hard to read.
      */}
      <ThemedText color="text" bold wrap="truncate-end">
        {formatGitBranchName(git, glyphs)}
      </ThemedText>
      {counters === "" ? null : (
        <ThemedText
          color={git.dirtyCount > 0 ? "warning" : "subtle"}
          wrap="truncate-end"
        >
          {counters}
        </ThemedText>
      )}
    </Box>
  );
}
