// @ts-nocheck
// Stub for openclaude's `src/services/sessionTranscript/sessionTranscript.ts`,
// which is conditionally loaded via `feature('KAIROS')` in the compact module
// but never ships in upstream source. The feature flag resolves to `false` in
// AgenC via the `bun:bundle` shim, so this module is dead code at runtime. The
// stub exists only to keep `require('../sessionTranscript/sessionTranscript.js')`
// type-resolvable.
export function writeSessionTranscriptSegment(..._args: any[]): void {}
