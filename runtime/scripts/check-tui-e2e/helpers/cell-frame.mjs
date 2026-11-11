/**
 * A frame of the PTY output in terminal cells.
 *
 * `renderPtyRows` gives every UTF-16 code unit one cell. That is right for
 * plain text but not for wide characters and emoji: a terminal draws U+2705
 * or a CJK character in two cells, and a whole emoji cluster (joiners,
 * U+FE0F, skin tones) in two cells as well. A check that borders line up
 * needs the real columns, so this helper lays the same output out per
 * cluster: one cell for a narrow cluster, two for a wide one. It can also
 * lay it out the way terminals with other width rules do (WIDTH_PROFILES).
 *
 * The cell rules are written from Unicode properties of the JavaScript
 * engine, on purpose not from the width tables the product uses.
 */
import { renderPtyRows } from "../harness.mjs";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const WIDE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u;
const HALFWIDTH = /^[｡-ￜ]/u;
const EMOJI_FORM =
  /\p{Emoji_Presentation}|️|⃣|\p{Emoji_Modifier}|\p{Regional_Indicator}{2}/u;
const NO_CELL = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** How many cells a terminal uses for one grapheme cluster, by the Unicode data. */
export function clusterCells(cluster) {
  if (EMOJI_FORM.test(cluster)) return 2;
  if (WIDE.test(cluster) && !HALFWIDTH.test(cluster)) return 2;
  let cells = 0;
  for (const char of cluster) {
    if (!NO_CELL.test(char)) cells += 1;
  }
  return Math.min(cells, 2);
}

const SELECTORS = /[\ufe0e\ufe0f]/gu;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

/**
 * Terminals do not agree on every cluster. Each profile is one way real
 * terminals differ from the Unicode data. A frame must come out the same
 * under each of them whether it was drawn in steps or at once.
 */
export const WIDTH_PROFILES = Object.freeze({
  /** The Unicode data: wide and emoji clusters two cells, the rest one. */
  unicode: clusterCells,
  /** U+FE0F does not widen: a text symbol with a selector stays one cell. */
  "selector-ignored": (cluster) => clusterCells(cluster.replace(SELECTORS, "")),
  /** Every symbol that can be an emoji takes two cells, selector or not. */
  "every-emoji-wide": (cluster) =>
    PICTOGRAPH.test(cluster) ? 2 : clusterCells(cluster),
  /**
   * No cluster support: every code point is sized on its own. A joiner, a
   * selector and a keycap mark take no cell, a skin tone takes two, and a
   * regional indicator one. Terminal.app and xterm work this way.
   */
  "no-clusters": (cluster) => {
    let cells = 0;
    for (const char of cluster) {
      if (/[\ufe0e\ufe0f\u200d\u20e3]/u.test(char)) continue;
      cells += /\p{Regional_Indicator}/u.test(char) ? 1 : clusterCells(char);
    }
    return cells;
  },
});

// Escape sequences pass through untouched: CSI, OSC, DCS, charset, keypad.
const ESCAPE =
  /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\|\x1b[()][\s\S]|\x1b[=>])/u;

// Stand-ins from the private use area: one code unit per cell.
const FIRST_STAND_IN = 0xe000;
const LAST_STAND_IN = 0xf8fe;
const LATER_CELL = "\uf8ff";

// One stand-in per cluster for the whole process, so the `cells` strings of
// two frames can be compared with each other.
const standIns = new Map();
const clusters = [];
function standInFor(cluster) {
  let standIn = standIns.get(cluster);
  if (standIn === undefined) {
    const code = FIRST_STAND_IN + clusters.length;
    if (code > LAST_STAND_IN) throw new Error("too many distinct clusters in one run");
    standIn = String.fromCharCode(code);
    standIns.set(cluster, standIn);
    clusters.push(cluster);
  }
  return standIn;
}

/**
 * Rows of the frame. `cells` has exactly one character per terminal cell, so
 * string indexes are terminal columns; `text` is the same row as readable
 * text, with every cluster restored.
 */
export function renderCellFrame(raw, { cols, rows, cellsOf = clusterCells }) {
  let prepared = "";
  for (const [index, part] of raw.split(ESCAPE).entries()) {
    if (index % 2 === 1) {
      prepared += part;
      continue;
    }
    for (const { segment } of segmenter.segment(part)) {
      if (segment < " " || segment === "\r\n") {
        prepared += segment;
        continue;
      }
      const cells = cellsOf(segment);
      if (cells === 0) continue;
      if (cells === 1 && segment.length === 1) {
        prepared += segment;
      } else {
        prepared += standInFor(segment) + LATER_CELL.repeat(cells - 1);
      }
    }
  }

  const restore = (row) =>
    Array.from(row, (char) => {
      if (char === LATER_CELL) return "";
      const code = char.charCodeAt(0);
      return code >= FIRST_STAND_IN && code <= LAST_STAND_IN
        ? clusters[code - FIRST_STAND_IN]
        : char;
    }).join("");

  return renderPtyRows(prepared, { cols, rows }).map((row) => ({
    cells: row,
    text: restore(row),
  }));
}

/** Columns (cell indexes) of every character of `glyphs` in a cell row. */
export function columnsOf(cells, glyphs) {
  const columns = [];
  for (let index = 0; index < cells.length; index += 1) {
    if (glyphs.includes(cells[index])) columns.push(index);
  }
  return columns;
}
