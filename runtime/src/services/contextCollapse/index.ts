// @ts-nocheck
// Stub — contextCollapse not included in source snapshot (feature-gated).
// Extra no-op exports exist so `typeof import('...')` references in the
// compact tree type-resolve when the `feature('CONTEXT_COLLAPSE')` branch is
// `false` at runtime.
export function isContextCollapseEnabled(): boolean {
  return false
}
export function getContextCollapseState() {
  return null
}
export function resetContextCollapse(): void {}
export function maybeCollapseContext(..._args: any[]): any {
  return null
}
