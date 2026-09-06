import type { ToolResult } from "./types.js";

export interface StrictArgsOptions {
  readonly allowed: ReadonlySet<string>;
  readonly required?: ReadonlyArray<string>;
  /** Runtime-injected keys tolerated beside the schema's own. */
  readonly injected: ReadonlyArray<string>;
  /** Whether a required string may be blank; the Task tools say no. */
  readonly allowBlank?: boolean;
}

/**
 * The shared body of the strict argument checks the Task and multi-agent
 * tools run before touching anything. Each caller supplies its own refusal
 * shape; the refusal must carry a no-effect disposition (#2190).
 */
/**
 * Every key the runtime injects beside the model's arguments carries the
 * `__agenc` prefix (`__agencSessionId`, `__agencSessionAllowedRoots`, the
 * signature, the home), plus `__callId`. The executor strips them before
 * schema validation; a tool's own strict check must tolerate them too, or a
 * nested `spawn_agent` from a workflow child is refused for a key the model
 * never wrote (soak F64).
 */
export function isRuntimeInjectedArgKey(key: string): boolean {
  return key === "__callId" || key.startsWith("__agenc");
}

export function strictArgsRefusal(
  args: Record<string, unknown>,
  opts: StrictArgsOptions,
  refuse: (message: string) => ToolResult,
): ToolResult | null {
  const allowed = new Set<string>([...opts.allowed, ...opts.injected]);
  for (const key of Object.keys(args)) {
    if (allowed.has(key) || isRuntimeInjectedArgKey(key)) continue;
    return refuse(`unknown field \`${key}\``);
  }
  for (const key of opts.required ?? []) {
    const value = args[key];
    const blank = typeof value === "string" && value.trim().length === 0;
    if (typeof value !== "string" || (blank && opts.allowBlank !== true)) {
      return refuse(`${key} is required`);
    }
  }
  return null;
}
