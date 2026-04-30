// Cherry-picked theme boundary for the wholesale-ported markdown
// pipeline.
//
// openclaude's markdown utility takes `theme: ThemeName` parameters
// where ThemeName is a string union ('light' | 'dark' | …) and resolves
// the actual theme via openclaude's color() signature
// `color(name, themeName)`. AgenC's color() signature takes the
// resolved Theme object instead: `color(name, theme: Theme)`. To keep
// the wholesale-ported markdown source byte-equivalent, alias ThemeName
// to AgenC's Theme object type — the parameter slot stays named
// `ThemeName` (matching openclaude verbatim) but is the AgenC Theme
// at runtime, which is what the ported markdown.ts actually feeds into
// AgenC's color().

export type { Theme as ThemeName } from "../theme.js";
