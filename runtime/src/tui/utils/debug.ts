// Re-export the wholesale-ported ink-side debug helpers at the AgenC
// utils-level path so wholesale-copied openclaude code that imports
// `'./debug.js'` (sibling of utils/markdown.ts) resolves to the same
// vendored implementation the ink/ port already ships.

export { logForDebugging, type DebugLogLevel } from "../ink/vendored/debug.js";
