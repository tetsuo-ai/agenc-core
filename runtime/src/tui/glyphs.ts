import figures from "figures";

export type AgenCTuiGlyphMode = "unicode" | "ascii";

export interface AgenCTuiGlyphs {
  readonly arrowDown: string;
  readonly pointer: string;
}

const ASCII_GLYPHS: AgenCTuiGlyphs = {
  arrowDown: "v",
  pointer: ">",
};

const UNICODE_GLYPHS: AgenCTuiGlyphs = {
  arrowDown: figures.arrowDown,
  pointer: figures.pointer,
};

export function resolveAgenCTuiGlyphMode(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): AgenCTuiGlyphMode {
  return env.AGENC_TUI_GLYPHS === "ascii" ? "ascii" : "unicode";
}

export function selectAgenCTuiGlyphs(
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): AgenCTuiGlyphs {
  return resolveAgenCTuiGlyphMode(env) === "ascii"
    ? ASCII_GLYPHS
    : UNICODE_GLYPHS;
}
