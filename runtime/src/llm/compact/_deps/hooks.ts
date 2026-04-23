/**
 * Compact hook entry points. The openclaude runtime fires PreCompact /
 * PostCompact / SessionStart hooks via its hook system; the gut runtime
 * does not implement compact-stage hooks today, so these are no-ops.
 *
 * If/when the gut runtime grows compact hooks, route them through
 * `runtime/src/llm/hooks/` rather than restoring the openclaude path.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executePreCompactHooks(..._args: any[]): Promise<any> {
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executePostCompactHooks(..._args: any[]): Promise<any> {
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function processSessionStartHooks(..._args: any[]): Promise<any> {
  return [];
}
