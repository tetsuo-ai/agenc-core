import figures from "figures";

export type AgenCTuiGlyphMode = "unicode" | "ascii";

export interface AgenCTuiGlyphs {
  readonly arrowUp: string;
  readonly arrowDown: string;
  readonly arrowLeft: string;
  readonly arrowRight: string;
  readonly enter: string;
  readonly ellipsis: string;
  readonly horizontal: string;
  readonly ideSelection: string;
  readonly modalDivider: string;
  readonly mcpResource: string;
  readonly pointer: string;
  readonly promptBypass: string;
  readonly responseGutter: string;
  readonly redactedThinkingPrefix: string;
  readonly separator: string;
  readonly statusError: string;
  readonly statusSuccess: string;
  readonly spinnerFrames: readonly string[];
  readonly spinnerReducedMotionDot: string;
  readonly statusDot: string;
  readonly thinkingEllipsis: string;
  readonly thinkingPrefix: string;
  readonly titleAnimationFrames: readonly string[];
  readonly titleStaticPrefix: string;
  readonly treeBranch: string;
  readonly treeContinuation: string;
  readonly treeLast: string;
  readonly treeRoot: string;
  readonly treeSelectedBranch: string;
  readonly treeSelectedLast: string;
  readonly treeSelectedRoot: string;
  readonly folderClosed: string;
  readonly folderOpen: string;
  readonly voiceCursorBars: string;
}

const ASCII_GLYPHS: AgenCTuiGlyphs = {
  arrowUp: "^",
  arrowDown: "v",
  arrowLeft: "<",
  arrowRight: ">",
  enter: "Enter",
  ellipsis: "...",
  horizontal: "-",
  ideSelection: "[]",
  modalDivider: "-",
  mcpResource: "*",
  pointer: ">",
  promptBypass: ">",
  responseGutter: "|_",
  redactedThinkingPrefix: "*",
  separator: "-",
  statusError: "ERR",
  statusSuccess: "OK",
  spinnerFrames: ["-", "\\", "|", "/"],
  spinnerReducedMotionDot: "*",
  statusDot: "*",
  thinkingEllipsis: "...",
  thinkingPrefix: "",
  titleAnimationFrames: ["*", "+"],
  titleStaticPrefix: "*",
  treeBranch: "|-",
  treeContinuation: "|",
  treeLast: "`-",
  treeRoot: ".-",
  treeSelectedBranch: "|>",
  treeSelectedLast: "`>",
  treeSelectedRoot: ".>",
  folderClosed: "[+]",
  folderOpen: "[-]",
  voiceCursorBars: " .:-=+*#@",
};

const UNICODE_GLYPHS: AgenCTuiGlyphs = {
  arrowUp: figures.arrowUp,
  arrowDown: figures.arrowDown,
  arrowLeft: figures.arrowLeft,
  arrowRight: figures.arrowRight,
  enter: "↵",
  ellipsis: "…",
  horizontal: "─",
  ideSelection: "⧉",
  modalDivider: "▔",
  mcpResource: "◇",
  pointer: figures.pointer,
  promptBypass: "▶",
  responseGutter: "⎿",
  redactedThinkingPrefix: "✻",
  separator: "·",
  statusError: "✗",
  statusSuccess: "✓",
  spinnerFrames: ["·", "✢", "✳", "✶", "✻", "✽"],
  spinnerReducedMotionDot: "●",
  statusDot: "●",
  thinkingEllipsis: "…",
  thinkingPrefix: "∴",
  titleAnimationFrames: ["⠂", "⠐"],
  titleStaticPrefix: "✳",
  treeBranch: "├─",
  treeContinuation: "│",
  treeLast: "└─",
  treeRoot: "┌─",
  treeSelectedBranch: "╞═",
  treeSelectedLast: "╘═",
  treeSelectedRoot: "╒═",
  folderClosed: "📁",
  folderOpen: "📂",
  voiceCursorBars: " ▁▂▃▄▅▆▇█",
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
