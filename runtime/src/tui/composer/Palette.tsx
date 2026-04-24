/**
 * Palette — popover suggestion list for slash-command and @-mention
 * autocomplete.
 *
 * This component is rendered by the composer (Wave 3-A) whenever the user
 * types a `/` or `@` trigger. The caller controls mount/unmount; `<Palette>`
 * assumes it is visible for the lifetime of the React element and does not
 * own the trigger detection logic itself.
 *
 * Behavior summary:
 *   - Ranks `items` against `query` using a three-tier match:
 *     prefix > word-boundary > subsequence. Ties broken by shorter label.
 *   - Highlights matched characters with the accent color from `theme`.
 *   - Renders up to `maxRows` items (default 8). When the result set is
 *     larger, a dimmed "… N more" row is appended at the bottom.
 *   - Wires up Up/Down/Enter/Escape via the shared keybinding context.
 *     The palette binds to the same `history:prev` / `history:next` /
 *     `chat:submit` / `chat:cancel` commands the chat input uses, on the
 *     "chat" binding context. Because the caller only renders `<Palette>`
 *     while the trigger is live, the chat input is expected to suppress
 *     its own Up/Down/Enter handling during that window.
 *
 * The fuzzy matcher is exported separately as `fuzzyMatch` so tests can
 * exercise its ranking behavior without having to drive keypresses.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { useKeybinding } from "../keybindings/KeybindingContext.js";
import {
  getDisplayForCommand,
  getDisplaysForCommand,
} from "../keybindings/shortcutFormat.js";
import { theme } from "../theme.js";

/** Shape of a single palette entry. */
export interface PaletteItem {
  /** Stable React key. Also used as a tiebreaker in fuzzy ranking. */
  readonly id: string;
  /** Label shown in the list. Matched against `query`. */
  readonly label: string;
  /** Secondary dimmed line. Not matched against `query`. */
  readonly description?: string;
  /** Extra search terms such as aliases. */
  readonly keywords?: readonly string[];
  /** What gets inserted into the composer on select. */
  readonly value: string;
}

/** Props accepted by `<Palette>`. See component comment for details. */
export interface PaletteProps {
  /** Which trigger opened this palette. Used for future trigger-specific UI. */
  readonly trigger: "/" | "@";
  /** Text the user has typed after the trigger. */
  readonly query: string;
  /** Candidate items. Pre-filtered or full; the ranker filters further. */
  readonly items: readonly PaletteItem[];
  /** Max visible rows. Defaults to 8. */
  readonly maxRows?: number;
  /** Placement relative to the composer; caller decides from cursor Y. */
  readonly placement: "above" | "below";
  /** Fired when the user confirms (Enter) on a suggestion. */
  readonly onSelect: (item: PaletteItem) => void;
  /** Fired when the user dismisses the palette (Escape). */
  readonly onClose: () => void;
}

interface RankedItem {
  readonly item: PaletteItem;
  /**
   * Character indices in `item.label` that matched the query, in order.
   * Used by the renderer to highlight matches.
   */
  readonly matches: readonly number[];
  /** Tier: 0=prefix, 1=word-boundary, 2=subsequence. Lower is better. */
  readonly tier: number;
  /** Tiebreak for non-label hits: label > keyword > description. */
  readonly targetPriority: number;
}

const WORD_BOUNDARY_RE = /[\s_\-/@.:]/;

/**
 * Decide whether position `idx` in `haystack` sits on a word boundary.
 * Position 0 is always a boundary; positions immediately after a separator
 * or at a camelCase transition count as boundaries too.
 */
function isWordBoundary(haystack: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = haystack[idx - 1];
  if (prev === undefined) return false;
  if (WORD_BOUNDARY_RE.test(prev)) return true;
  const cur = haystack[idx];
  if (cur === undefined) return false;
  // camelCase transition: previous is lower, current is upper.
  if (prev === prev.toLowerCase() && cur !== cur.toLowerCase()) return true;
  return false;
}

/**
 * Attempt to match every character of `query` against `haystack` in order.
 * Returns the list of matching indices on success, `null` on failure.
 *
 * When `boundaryOnly` is true, each matched position must sit on a word
 * boundary (see `isWordBoundary`). That drives the "word-boundary" tier
 * below without having to re-scan the haystack.
 */
function subsequenceIndices(
  haystack: string,
  query: string,
  boundaryOnly: boolean,
): number[] | null {
  if (query.length === 0) return [];
  const hs = haystack.toLowerCase();
  const q = query.toLowerCase();
  const out: number[] = [];
  let hi = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const needle = q[qi];
    let found = -1;
    while (hi < hs.length) {
      if (hs[hi] === needle) {
        if (!boundaryOnly || isWordBoundary(haystack, hi)) {
          found = hi;
          hi += 1;
          break;
        }
      }
      hi += 1;
    }
    if (found === -1) return null;
    out.push(found);
  }
  return out;
}

interface MatchTarget {
  readonly text: string;
  readonly offset: number;
  readonly targetPriority: number;
  readonly exposeMatches: boolean;
}

function buildMatchTargets(item: PaletteItem): MatchTarget[] {
  const targets: MatchTarget[] = [];
  const trimmedLabel =
    item.label.startsWith("/") || item.label.startsWith("@")
      ? item.label.slice(1)
      : item.label;
  targets.push({
    text: trimmedLabel,
    offset: trimmedLabel === item.label ? 0 : 1,
    targetPriority: 0,
    exposeMatches: true,
  });
  for (const keyword of item.keywords ?? []) {
    if (typeof keyword !== "string" || keyword.trim().length === 0) continue;
    targets.push({
      text: keyword.trim(),
      offset: 0,
      targetPriority: 1,
      exposeMatches: false,
    });
  }
  if (typeof item.description === "string" && item.description.trim().length > 0) {
    targets.push({
      text: item.description.trim(),
      offset: 0,
      targetPriority: 2,
      exposeMatches: false,
    });
  }
  return targets;
}

function chooseBetterRank(
  current: RankedItem | null,
  next: RankedItem,
): RankedItem {
  if (current === null) return next;
  if (next.tier < current.tier) return next;
  if (next.tier > current.tier) return current;
  if (next.targetPriority < current.targetPriority) return next;
  return current;
}

function rankItem(item: PaletteItem, query: string): RankedItem | null {
  let best: RankedItem | null = null;

  for (const target of buildMatchTargets(item)) {
    const lower = target.text.toLowerCase();
    const qLower = query.toLowerCase();
    if (lower.startsWith(qLower)) {
      const matches: number[] = [];
      for (let i = 0; i < query.length; i += 1) {
        matches.push(i + target.offset);
      }
      best = chooseBetterRank(best, {
        item,
        matches: target.exposeMatches ? matches : [],
        tier: 0,
        targetPriority: target.targetPriority,
      });
      continue;
    }

    const boundary = subsequenceIndices(target.text, query, true);
    if (boundary !== null) {
      best = chooseBetterRank(best, {
        item,
        matches: target.exposeMatches
          ? boundary.map((idx) => idx + target.offset)
          : [],
        tier: 1,
        targetPriority: target.targetPriority,
      });
      continue;
    }

    const plain = subsequenceIndices(target.text, query, false);
    if (plain !== null) {
      best = chooseBetterRank(best, {
        item,
        matches: target.exposeMatches
          ? plain.map((idx) => idx + target.offset)
          : [],
        tier: 2,
        targetPriority: target.targetPriority,
      });
    }
  }

  return best;
}

/**
 * Rank `items` against `query`. Items that fail every match tier are
 * dropped. The remaining list is sorted by (tier asc, label-length asc,
 * id asc) so the UI ordering is deterministic for tests.
 *
 * Exported so unit tests can exercise the ranker directly without mounting
 * React.
 */
export function fuzzyMatch(
  items: readonly PaletteItem[],
  query: string,
): PaletteItem[] {
  if (query.length === 0) {
    // No query: preserve the caller's order but still copy so callers
    // can't mutate the result array.
    return items.slice();
  }

  const ranked: RankedItem[] = [];

  for (const item of items) {
    const rankedItem = rankItem(item, query);
    if (rankedItem !== null) ranked.push(rankedItem);
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.targetPriority !== b.targetPriority) {
      return a.targetPriority - b.targetPriority;
    }
    const lenDiff = a.item.label.length - b.item.label.length;
    if (lenDiff !== 0) return lenDiff;
    if (a.item.id < b.item.id) return -1;
    if (a.item.id > b.item.id) return 1;
    return 0;
  });

  return ranked.map((entry) => entry.item);
}

/**
 * Internal variant of `fuzzyMatch` that preserves the match indices so
 * the renderer can highlight them without having to re-compute the
 * subsequence.
 */
function fuzzyMatchWithIndices(
  items: readonly PaletteItem[],
  query: string,
): RankedItem[] {
  if (query.length === 0) {
    return items.map((item) => ({
      item,
      matches: [],
      tier: 0,
      targetPriority: 0,
    }));
  }

  const ranked: RankedItem[] = [];

  for (const item of items) {
    const rankedItem = rankItem(item, query);
    if (rankedItem !== null) ranked.push(rankedItem);
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.targetPriority !== b.targetPriority) {
      return a.targetPriority - b.targetPriority;
    }
    const lenDiff = a.item.label.length - b.item.label.length;
    if (lenDiff !== 0) return lenDiff;
    if (a.item.id < b.item.id) return -1;
    if (a.item.id > b.item.id) return 1;
    return 0;
  });

  return ranked;
}

/**
 * Render a single label with the matched character indices highlighted
 * in the accent color. Non-matching runs render in the selected/unselected
 * default color passed in via `baseColor`.
 */
function renderLabelSegments(
  label: string,
  matchIndices: readonly number[],
  baseColor: Color | undefined,
  accentColor: Color,
  selected: boolean,
): React.ReactNode[] {
  const matchSet = new Set(matchIndices);
  const nodes: React.ReactNode[] = [];
  let buffer = "";
  let bufferIsMatch = false;

  const flush = (keySeed: number): void => {
    if (buffer.length === 0) return;
    if (bufferIsMatch) {
      nodes.push(
        <Text key={`m-${keySeed}`} color={accentColor} inverse={selected} bold>
          {buffer}
        </Text>,
      );
    } else if (baseColor !== undefined) {
      nodes.push(
        <Text key={`t-${keySeed}`} color={baseColor} inverse={selected}>
          {buffer}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={`t-${keySeed}`} inverse={selected}>
          {buffer}
        </Text>,
      );
    }
    buffer = "";
  };

  for (let i = 0; i < label.length; i += 1) {
    const isMatch = matchSet.has(i);
    if (buffer.length === 0) {
      bufferIsMatch = isMatch;
      buffer = label[i] ?? "";
      continue;
    }
    if (isMatch === bufferIsMatch) {
      buffer += label[i] ?? "";
    } else {
      flush(i);
      bufferIsMatch = isMatch;
      buffer = label[i] ?? "";
    }
  }
  flush(label.length);

  return nodes;
}

/**
 * The palette popover. Pure presentation + keyboard navigation — the
 * caller owns trigger detection, placement decisions, and the insert
 * flow on select.
 */
export const Palette: React.FC<PaletteProps> = ({
  trigger,
  query,
  items,
  maxRows = 8,
  placement: _placement,
  onSelect,
  onClose,
}) => {
  const ranked = useMemo(
    () => fuzzyMatchWithIndices(items, query),
    [items, query],
  );

  const totalMatches = ranked.length;
  const visibleCount = Math.min(maxRows, totalMatches);

  const [selectedIdx, setSelectedIdx] = useState(0);

  // Whenever the visible list shrinks (e.g. query tightened), clamp the
  // selection so it doesn't point past the end. We keep selection at the
  // top when the list is empty so the next render after a type doesn't
  // briefly flash an out-of-bounds highlight.
  useEffect(() => {
    if (totalMatches === 0) {
      if (selectedIdx !== 0) setSelectedIdx(0);
      return;
    }
    if (selectedIdx >= totalMatches) {
      setSelectedIdx(totalMatches - 1);
    }
  }, [selectedIdx, totalMatches]);

  const moveUp = useCallback(() => {
    if (totalMatches === 0) return;
    setSelectedIdx((prev) => (prev <= 0 ? totalMatches - 1 : prev - 1));
  }, [totalMatches]);

  const moveDown = useCallback(() => {
    if (totalMatches === 0) return;
    setSelectedIdx((prev) => (prev >= totalMatches - 1 ? 0 : prev + 1));
  }, [totalMatches]);

  const confirm = useCallback(() => {
    if (totalMatches === 0) {
      onClose();
      return;
    }
    const chosen = ranked[selectedIdx]?.item;
    if (chosen === undefined) return;
    onSelect(chosen);
  }, [onClose, onSelect, ranked, selectedIdx, totalMatches]);

  const dismiss = useCallback(() => {
    onClose();
  }, [onClose]);

  // Bind to the chat context so the same Up/Down/Enter/Escape that drive
  // the composer input are captured while the palette is visible. The
  // composer is expected to be the only other subscriber and to coordinate
  // with the palette via the caller's render gate.
  useKeybinding("history:prev", moveUp, "chat");
  useKeybinding("history:next", moveDown, "chat");
  useKeybinding("chat:submit", confirm, "chat");
  useKeybinding("chat:acceptSuggestion", confirm, "chat");
  useKeybinding("chat:cancel", dismiss, "chat");

  // Theme colors arrive typed as raw strings so they can carry either ansi
  // names (fallback theme) or the watch primitives' hex/rgb shapes. The Ink
  // components narrow this down to `Color` at the prop boundary; the cast
  // here is safe because the color runtime (`colorize`) also accepts the
  // fallback `"cyan"` / `"yellow"` / `"gray"` names used by DEFAULT_THEME.
  const borderColor = theme.colors.accent as Color;
  const dimColor = theme.colors.dim as Color;
  const accentColor = theme.colors.accent as Color;
  const hintLine = useMemo(() => {
    const acceptKeys = [
      ...getDisplaysForCommand("chat:acceptSuggestion", "chat"),
      ...getDisplaysForCommand("chat:submit", "chat"),
    ];
    const uniqueAcceptKeys = Array.from(new Set(acceptKeys));
    const up = getDisplayForCommand("history:prev", "chat") ?? "Up";
    const down = getDisplayForCommand("history:next", "chat") ?? "Down";
    return `${
      trigger === "/" ? "Commands" : "Mentions"
    }  ${uniqueAcceptKeys.join("/")} accept  ${up}/${down} move`;
  }, [trigger]);

  if (totalMatches === 0) {
    return (
      <Box
        borderStyle="single"
        borderColor={borderColor}
        paddingX={1}
        flexDirection="column"
      >
        <Text color={dimColor}>(no matches)</Text>
      </Box>
    );
  }

  const visibleStart = Math.max(
    0,
    Math.min(
      selectedIdx - Math.floor(visibleCount / 2),
      Math.max(0, totalMatches - visibleCount),
    ),
  );
  const visibleEnd = Math.min(totalMatches, visibleStart + visibleCount);
  const overflowAbove = visibleStart;
  const overflowBelow = Math.max(0, totalMatches - visibleEnd);
  const visible = ranked.slice(visibleStart, visibleEnd);

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={dimColor}>{hintLine}</Text>
      {overflowAbove > 0 ? (
        <Text color={dimColor}>… {overflowAbove} above</Text>
      ) : null}
      {visible.map((entry, idx) => {
        const absoluteIdx = visibleStart + idx;
        const isSelected = absoluteIdx === selectedIdx;
        const labelNodes = renderLabelSegments(
          entry.item.label,
          entry.matches,
          undefined,
          accentColor,
          isSelected,
        );
        return (
          <Box key={entry.item.id} flexDirection="row" width="100%">
            <Text inverse={isSelected}>{isSelected ? "› " : "  "}</Text>
            <Box flexDirection="row" flexGrow={1}>
              {labelNodes}
              {entry.item.description !== undefined &&
              entry.item.description.length > 0 ? (
                <Text
                  wrap="truncate-end"
                  color={dimColor}
                  inverse={isSelected}
                >
                  {"  "}
                  {entry.item.description}
                </Text>
              ) : null}
            </Box>
          </Box>
        );
      })}
      {overflowBelow > 0 ? (
        <Text color={dimColor}>… {overflowBelow} below</Text>
      ) : null}
    </Box>
  );
};

export default Palette;
