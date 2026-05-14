import figures from "figures";

export type AgenCTuiGlyphMode = "unicode" | "ascii";

export interface AgenCTuiGlyphs {
  readonly arrowUp: string;
  readonly arrowDown: string;
  readonly enter: string;
  readonly horizontal: string;
  readonly modalDivider: string;
  readonly mcpResource: string;
  readonly pointer: string;
  readonly promptBypass: string;
  readonly separator: string;
  readonly statusDot: string;
  readonly titleAnimationFrames: readonly string[];
  readonly titleStaticPrefix: string;
}

const ASCII_GLYPHS: AgenCTuiGlyphs = {
  arrowUp: "^",
  arrowDown: "v",
  enter: "Enter",
  horizontal: "-",
  modalDivider: "-",
  mcpResource: "*",
  pointer: ">",
  promptBypass: ">",
  separator: "-",
  statusDot: "*",
  titleAnimationFrames: ["*", "+"],
  titleStaticPrefix: "*",
};

const UNICODE_GLYPHS: AgenCTuiGlyphs = {
  arrowUp: figures.arrowUp,
  arrowDown: figures.arrowDown,
  enter: "↵",
  horizontal: "─",
  modalDivider: "▔",
  mcpResource: "◇",
  pointer: figures.pointer,
  promptBypass: "▶",
  separator: "·",
  statusDot: "●",
  titleAnimationFrames: ["⠂", "⠐"],
  titleStaticPrefix: "✳",
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
