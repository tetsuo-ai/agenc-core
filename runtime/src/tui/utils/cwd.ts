// Cherry-picked from openclaude src/utils/cwd.ts.
// Only the synchronous getCwd() is needed by the wholesale-ported
// diagnostics surface; openclaude also has runWithCwdOverride +
// AsyncLocalStorage scope-management that AgenC doesn't need today.
// If AgenC introduces concurrent agents that need per-context cwd
// scoping later, port runWithCwdOverride from openclaude.

export function getCwd(): string {
  return process.cwd();
}
