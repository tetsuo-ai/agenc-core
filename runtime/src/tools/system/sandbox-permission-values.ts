/**
 * The values `sandbox_permissions` accepts on exec_command and write_stdin,
 * and the model-input fold that reads a value which can only mean the default
 * sandbox as "default". Used by both tools and by the schema-error override,
 * so it imports nothing.
 *
 * @module
 */

/** The three modes, in the order the schema and the error messages list them. */
export const SANDBOX_PERMISSION_VALUES: readonly string[] = [
  "default",
  "require_escalated",
  "with_additional_permissions",
];

/**
 * Spellings that can only mean "no escalation", compared after trimming,
 * lower-casing and reading "-" or a space as "_". DeepSeek Light sent
 * `"use_default"`, a value no AgenC text names, on every exec_command call of
 * a long task (2026-11-06); each call was refused until the repeat guard and
 * the no-progress backstop ended the turn. "default" is the least privilege,
 * so reading these as "default" grants nothing the model could not get by
 * leaving the field out. No spelling is ever read as "require_escalated" or
 * "with_additional_permissions".
 */
const DEFAULT_MEANING_SPELLINGS: ReadonlySet<string> = new Set([
  "default",
  "use_default",
  "none",
  "",
]);

/**
 * True for a value outside the three modes that can only mean the default
 * sandbox: `null`, or a default-meaning spelling other than "default" itself.
 */
export function isDefaultSandboxPermissionAlias(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value === "default") return false;
  return DEFAULT_MEANING_SPELLINGS.has(value.trim().toLowerCase().replace(/[\s-]+/gu, "_"));
}

/**
 * `reshapeModelArgs` of exec_command and write_stdin: a call whose only
 * problem is a default-meaning sandbox_permissions value runs with "default".
 * Declines (returns undefined) for everything else, so any other value still
 * fails validation and gets the message that names the accepted values.
 */
export function foldDefaultSandboxPermission(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(args, "sandbox_permissions")) return undefined;
  if (!isDefaultSandboxPermissionAlias(args.sandbox_permissions)) return undefined;
  return { ...args, sandbox_permissions: "default" };
}
