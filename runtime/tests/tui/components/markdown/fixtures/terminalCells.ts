/**
 * How many cells a terminal uses for a text. This is the reference the width
 * tests compare against. It is written from the Unicode properties of the
 * JavaScript engine, on purpose not from the tables that the product's own
 * width function uses.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Scripts and blocks whose characters are two cells wide.
const WIDE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u
// Halfwidth forms of those scripts are one cell wide.
const HALFWIDTH = /^[｡-ￜ]/u
// A cluster drawn as an emoji: emoji by default, or made one by U+FE0F, a
// keycap, a skin tone, or a pair of regional indicators (a flag).
const EMOJI_FORM =
  /\p{Emoji_Presentation}|️|⃣|\p{Emoji_Modifier}|\p{Regional_Indicator}{2}/u
// Marks and format characters take no cell of their own.
const NO_CELL = /^[\p{Mn}\p{Me}\p{Cf}]$/u

export function terminalCells(text: string): number {
  let cells = 0
  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI_FORM.test(segment)) {
      cells += 2
    } else if (WIDE.test(segment) && !HALFWIDTH.test(segment)) {
      cells += 2
    } else {
      for (const char of segment) {
        if (!NO_CELL.test(char)) cells += 1
      }
    }
  }
  return cells
}

/** The cell at which each occurrence of one of `glyphs` starts. */
export function cellColumnsOf(line: string, glyphs: string): number[] {
  const columns: number[] = []
  let cells = 0
  for (const { segment } of segmenter.segment(line)) {
    if (glyphs.includes(segment)) columns.push(cells)
    cells += terminalCells(segment)
  }
  return columns
}
