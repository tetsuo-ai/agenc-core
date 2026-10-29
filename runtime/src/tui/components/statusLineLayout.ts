/**
 * Fits the status line's facts to the terminal width without dropping any.
 *
 * Every fact stays visible. When one row is too narrow, the facts take their
 * short forms one step at a time, most readable change first ("high effort"
 * becomes "high", "asks first" becomes "asks", "cache 82%" becomes "c 82%",
 * "$0.041 off-peak" becomes "$0.041 op", the folder path becomes its last
 * name), then the folder and the model are shortened in the middle down to a
 * readable floor. When one row still cannot hold everything, the usage block
 * moves to a second row, where both rows start again from the full forms and
 * compact only as far as each needs, down to a lower floor if they must.
 *
 * @module
 */

import { stringWidth } from '../ink/stringWidth.js';
import { truncateMiddleToWidth } from '../../utils/truncate.js';

export type StatusLineColor =
  | 'text'
  | 'text2'
  | 'error'
  | 'accentSoft'
  | 'accent'
  | 'success'
  | 'inactive'
  | 'subtle';

export type StatusLineSpan = {
  readonly text: string;
  readonly color: StatusLineColor;
  readonly bold?: boolean;
};

/** One fact on the status line, in its full form and its shorter forms. */
export type StatusLineFact = {
  readonly key: string;
  /** Display forms, full first; each later one is a shorter word for the same fact. */
  readonly forms: readonly (readonly StatusLineSpan[])[];
  /**
   * A one-span fact that may be shortened in the middle as a last step, never
   * below this many columns (or its own width when that is smaller).
   */
  readonly minWidth?: number;
  /**
   * The floor for that shortening once the line has already wrapped to two
   * rows and still does not fit: the last step before the terminal cuts text.
   */
  readonly lastResortMinWidth?: number;
};

export type PlacedStatusLineFact = {
  readonly key: string;
  readonly spans: readonly StatusLineSpan[];
};

export type StatusLineLayout = {
  /** One row holds both blocks; two rows put the usage block on the second. */
  readonly rows: 1 | 2;
  readonly left: readonly PlacedStatusLineFact[];
  readonly right: readonly PlacedStatusLineFact[];
  /** False only when even the shortest forms are wider than the terminal. */
  readonly fits: boolean;
};

export const STATUS_LINE_SEPARATOR = ' · ';
/** Columns of padding on each side of the status line. */
export const STATUS_LINE_PADDING = 2;
/**
 * The least space between the facts on the left and the usage block on one
 * row: wider than a single space, so "asks  ctx 4%" does not read as one fact.
 */
export const STATUS_LINE_BLOCK_GAP = 2;

/** Facts that have a short form, in the order they take it. */
const STATUS_LINE_COMPACTION_ORDER: readonly string[] = Object.freeze([
  'effort',
  'mode',
  'cache',
  'spend',
  'harness',
  'folder',
]);

/** Facts shortened in the middle as the last step, in this order. */
const STATUS_LINE_TRUNCATION_ORDER: readonly string[] = Object.freeze(['folder', 'model']);

type FactState = { readonly form: number; readonly width?: number };

function spansWidth(spans: readonly StatusLineSpan[]): number {
  return spans.reduce((sum, span) => sum + stringWidth(span.text), 0);
}

/** Visible width of facts joined by the separator. */
export function statusLineGroupWidth(facts: readonly PlacedStatusLineFact[]): number {
  if (facts.length === 0) return 0;
  return facts.reduce((sum, fact) => sum + spansWidth(fact.spans), 0) +
    (facts.length - 1) * stringWidth(STATUS_LINE_SEPARATOR);
}

function formOf(fact: StatusLineFact, state: FactState | undefined): readonly StatusLineSpan[] {
  const forms = fact.forms;
  return forms[Math.min(state?.form ?? 0, forms.length - 1)] ?? [];
}

function place(fact: StatusLineFact, state: FactState | undefined): PlacedStatusLineFact {
  const spans = formOf(fact, state);
  if (state?.width === undefined || spans.length !== 1) return { key: fact.key, spans };
  const span = spans[0]!;
  return { key: fact.key, spans: [{ ...span, text: truncateMiddleToWidth(span.text, state.width) }] };
}

/**
 * Compact one or more groups that share a width budget until `overflow`
 * reports nothing left over. Returns the placed groups and whether they fit.
 */
function compactGroups(
  groups: readonly (readonly StatusLineFact[])[],
  overflow: (placed: readonly (readonly PlacedStatusLineFact[])[]) => number,
  lastResort = false,
): { readonly placed: readonly (readonly PlacedStatusLineFact[])[]; readonly fits: boolean } {
  const states = new Map<string, FactState>();
  const placeAll = () => groups.map(group => group.map(fact => place(fact, states.get(fact.key))));
  let placed = placeAll();
  if (overflow(placed) <= 0) return { placed, fits: true };
  const facts = groups.flat();
  for (const key of STATUS_LINE_COMPACTION_ORDER) {
    const fact = facts.find(candidate => candidate.key === key);
    if (fact === undefined || fact.forms.length < 2) continue;
    states.set(key, { form: fact.forms.length - 1 });
    placed = placeAll();
    if (overflow(placed) <= 0) return { placed, fits: true };
  }
  const floors: readonly ((fact: StatusLineFact) => number | undefined)[] = lastResort
    ? [fact => fact.minWidth, fact => fact.lastResortMinWidth]
    : [fact => fact.minWidth];
  const truncatable = STATUS_LINE_TRUNCATION_ORDER.flatMap(key => {
    const fact = facts.find(candidate => candidate.key === key);
    return fact === undefined ? [] : [fact];
  });
  for (const floorOf of floors) {
    // Take one column at a time from the widest name above its floor, so a
    // long model name gives up columns before a short folder name is cut.
    for (;;) {
      const excess = overflow(placed);
      if (excess <= 0) return { placed, fits: true };
      let widest: { readonly fact: StatusLineFact; readonly width: number } | undefined;
      for (const fact of truncatable) {
        const state = states.get(fact.key) ?? { form: 0 };
        const spans = formOf(fact, state);
        const minWidth = floorOf(fact);
        if (spans.length !== 1 || minWidth === undefined) continue;
        const width = state.width ?? spansWidth(spans);
        if (width <= minWidth) continue;
        if (widest === undefined || width > widest.width) widest = { fact, width };
      }
      if (widest === undefined) break;
      const state = states.get(widest.fact.key) ?? { form: 0 };
      states.set(widest.fact.key, { ...state, width: widest.width - 1 });
      placed = placeAll();
    }
  }
  return { placed, fits: overflow(placed) <= 0 };
}

/**
 * Lay the facts out for a terminal `columns` wide: one row when it can hold
 * every fact (after compaction), otherwise the left block on the first row and
 * the usage block on the second.
 */
export function layoutStatusLine(
  columns: number,
  left: readonly StatusLineFact[],
  right: readonly StatusLineFact[],
): StatusLineLayout {
  const width = Number.isFinite(columns) ? Math.trunc(columns) : 0;
  const available = Math.max(1, width - 2 * STATUS_LINE_PADDING);
  const oneRow = compactGroups([left, right], ([placedLeft = [], placedRight = []]) =>
    statusLineGroupWidth(placedLeft) +
    (placedRight.length > 0 ? STATUS_LINE_BLOCK_GAP + statusLineGroupWidth(placedRight) : 0) -
    available);
  if (oneRow.fits || right.length === 0 || left.length === 0) {
    return { rows: 1, left: oneRow.placed[0] ?? [], right: oneRow.placed[1] ?? [], fits: oneRow.fits };
  }
  const top = compactGroups([left], ([placed = []]) => statusLineGroupWidth(placed) - available, true);
  const bottom = compactGroups([right], ([placed = []]) => statusLineGroupWidth(placed) - available, true);
  return {
    rows: 2,
    left: top.placed[0] ?? [],
    right: bottom.placed[0] ?? [],
    fits: top.fits && bottom.fits,
  };
}
