// @ts-nocheck
// NOTE: Forced to `false` in AgenC. The upstream buddy command set is a
// feature-gated openclaude path that is not shipped here; returning true would
// trigger a module-eval `require('./commands/buddy/index.js')` via
// src/commands.ts and crash under the NodeNext ESM resolver.
export function isBuddyEnabled(): boolean {
  return false
}
