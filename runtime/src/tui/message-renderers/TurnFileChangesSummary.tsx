/**
 * Compact per-turn "files changed" summary, rendered once after an assistant
 * turn's tool activity. Each Write/Edit renders its own collapsed diff card; this
 * adds the missing at-a-glance rollup of WHAT the turn changed:
 *
 *   ⎿ files changed · + index.html  ~ styles.css +4 -1  ~ script.js +12 -3
 *
 * The data is derived from the turn's OWN tool-use blocks (see
 * `deriveTurnFileChanges`), so it is scoped to the turn and reuses the same
 * file path + +N/-M counts and CREATE/EDIT distinction as the diff cards. The
 * caller renders nothing when the turn changed no files (empty list in →
 * `null` out).
 *
 * On-brand: neutral subtle label + a `+` create marker (success) vs a `~` edit
 * marker (agenc), additions in success / removals in error — matching the diff
 * card palette. Long lists wrap to additional rows and collapse past a cap to a
 * "… +N more" tail, so the block never overflows the content row.
 *
 * Each entry's file path is wrapped in `FilePathLink`, the SAME OSC 8 hyperlink
 * the per-file Write/Edit diff cards already render (see `FileWriteTool/UI.tsx`,
 * `FileEditTool/UI.tsx`). So in a click-to-open terminal (iTerm2, kitty, …) the
 * just-built file is openable straight from the rollup — the build session is no
 * longer a dead end. No new keybinding/dispatch wiring into the static
 * transcript and no external process spawning: it reuses the one open-file
 * affordance the transcript already exposes. The visible label stays the short
 * basename (so the compact row never overflows) while the link target is the
 * full path.
 *
 * @module
 */

import React from "react";
import Box from "../ink/components/Box.js";
import ThemedText from "../components/design-system/ThemedText.js";
import { FilePathLink } from "../components/FilePathLink.js";
import type { TurnFileChange } from "../turn-file-changes.js";

/**
 * Max files listed inline before collapsing the remainder to "… +N more". Kept
 * small so a typical multi-file turn shows in full and only a genuinely large
 * batch collapses (the per-file diff cards above already carry the detail).
 */
const MAX_FILES_SHOWN = 8;

/** Render the basename only when a full path would dominate the compact row. */
function shortenFile(file: string): string {
  // Keep short/relative paths intact; collapse long absolute-ish paths to a
  // basename so a single entry can't blow out the row. The diff card above
  // already shows the full path, so the summary can favor brevity.
  if (file.length <= 40) return file;
  const parts = file.split("/");
  const base = parts[parts.length - 1] ?? file;
  return base.length > 0 ? base : file;
}

function FileEntry({ change }: { readonly change: TurnFileChange }): React.ReactNode {
  const isCreate = change.kind === "create";
  // '+' = new file (success), '~' = edited file (agenc) — reusing the diff-card
  // CREATE/EDIT distinction in a single-glyph form.
  const marker = isCreate ? "+" : "~";
  const markerColor = isCreate ? "success" : "agenc";
  const showStats = change.additions > 0 || change.removals > 0;
  return (
    <Box flexDirection="row" flexShrink={0} gap={1}>
      <ThemedText color={markerColor}>{marker}</ThemedText>
      {/* OSC 8 hyperlink to the file so it can be opened from the rollup, with
          the short basename as the visible label and the full path as the link
          target — same affordance the per-file diff cards already render. */}
      <FilePathLink filePath={change.file}>
        <ThemedText color="text2" wrap="truncate-middle">
          {shortenFile(change.file)}
        </ThemedText>
      </FilePathLink>
      {isCreate ? <ThemedText color="success">(new)</ThemedText> : null}
      {showStats ? (
        <Box flexDirection="row" flexShrink={0}>
          {change.additions > 0 ? (
            <ThemedText color="success">{`+${change.additions}`}</ThemedText>
          ) : null}
          {change.additions > 0 && change.removals > 0 ? (
            <ThemedText color="muted3"> </ThemedText>
          ) : null}
          {change.removals > 0 ? (
            <ThemedText color="error">{`-${change.removals}`}</ThemedText>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export function TurnFileChangesSummary({
  changes,
}: {
  readonly changes: readonly TurnFileChange[];
}): React.ReactNode {
  if (changes.length === 0) return null;

  const shown = changes.slice(0, MAX_FILES_SHOWN);
  const hidden = changes.length - shown.length;

  return (
    <Box flexDirection="row" paddingLeft={1} gap={1}>
      {/* Same `⎿` continuation gutter the diff cards / tool results use, so the
          summary reads as a child of the turn's tool activity. */}
      <ThemedText color="muted3">⎿</ThemedText>
      <Box flexDirection="row" flexWrap="wrap" flexGrow={1} columnGap={2}>
        <ThemedText color="subtle">files changed</ThemedText>
        {shown.map(change => (
          <FileEntry key={change.file} change={change} />
        ))}
        {hidden > 0 ? (
          <ThemedText color="inactive">{`… +${hidden} more`}</ThemedText>
        ) : null}
      </Box>
    </Box>
  );
}
