/**
 * Humanized tool schema-validation errors (port of AgenC
 * `utils/toolErrors.ts` + `services/tools/toolExecution.ts`
 * `buildSchemaNotSentHint` / `getSchemaValidationErrorOverride`).
 *
 * AgenC's Tool shape carries a raw JSON Schema (`Tool.inputSchema:
 * JSONSchema`) rather than a Zod schema. We match AgenC's
 * observable prose by consuming the structured errors produced by
 * `validateToolArgs` (`execution.ts`) — the categories (missing
 * required, unexpected key, type mismatch) come out identical to
 * `formatZodValidationError`'s output.
 *
 * @module
 */
import type { Tool } from "./types.js";
import type { SchemaValidationError } from "./execution.js";

// ─────────────────────────────────────────────────────────────────────
// AgenC behavior: `formatZodValidationError`
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert structured schema-validation errors into the same humanized
 * prose AgenC emits from `formatZodValidationError`. Paths are
 * rendered as JS-style accessors (`todos[0].activeForm`). Missing
 * required fields, unexpected keys, and type mismatches are grouped
 * into labeled lines.
 */
export function formatSchemaValidationError(
  toolName: string,
  errors: ReadonlyArray<SchemaValidationError>,
): string {
  const missing: string[] = [];
  const unexpected: string[] = [];
  const typeMismatch: Array<{
    path: string;
    expected: string;
    received: string;
  }> = [];

  for (const err of errors) {
    if (err.category === "missing") {
      missing.push(formatValidationPath(err.path));
    } else if (err.category === "unexpected_key") {
      unexpected.push(formatValidationPath(err.path));
    } else if (err.category === "type" && err.expected && err.received) {
      typeMismatch.push({
        path: formatValidationPath(err.path),
        expected: err.expected,
        received: err.received,
      });
    }
  }

  const parts: string[] = [];
  for (const p of missing) {
    parts.push(`The required parameter \`${p}\` is missing`);
  }
  for (const p of unexpected) {
    parts.push(`An unexpected parameter \`${p}\` was provided`);
  }
  for (const { path, expected, received } of typeMismatch) {
    parts.push(
      `The parameter \`${path}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    );
  }

  if (parts.length === 0) {
    // Fallback path — surface every error with path + message so the
    // model sees the exact validator output. Matches Zod's default
    // `error.message` format when no typed categories apply.
    const fallback = errors
      .map((e) => `${formatValidationPath(e.path)}: ${e.message}`)
      .join("; ");
    return fallback || "input did not match schema";
  }

  const header = `${toolName} failed due to the following ${
    parts.length > 1 ? "issues" : "issue"
  }:`;
  return `${header}\n${parts.join("\n")}`;
}

function formatValidationPath(path: string): string {
  if (!path) return "";
  // `path` here is the dotted form used by `validateToolArgs`
  // (`todos.0.activeForm`). Convert numeric segments into `[n]`
  // bracket form so the output matches AgenC's JS-style accessor.
  const segments = path.split(".");
  let result = "";
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const numeric = /^\d+$/.test(seg);
    if (numeric) {
      result += `[${seg}]`;
    } else if (i === 0) {
      result += seg;
    } else {
      result += `.${seg}`;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// AgenC behavior: `getSchemaValidationErrorOverride`
// ─────────────────────────────────────────────────────────────────────

/**
 * Tool names recognized as the skill-dispatch family. Matches
 * AgenC's `SKILL_TOOL_NAME` lookup behavior — a missing `skill`
 * parameter is a common LLM error when the model sees the tool
 * description without the full parameter schema.
 */
const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "SkillTool",
  "skill",
  "Skill",
]);

/**
 * Per-tool override for a schema-validation error message. Returns
 * `null` when the default `formatSchemaValidationError` prose is fine.
 *
 * Mirrors openclaude `getSchemaValidationErrorOverride` scope (today,
 * only SkillTool's missing-`skill` case). Additional overrides can be
 * added here as new tools gain specific bad-input guidance.
 */
export function getSchemaValidationErrorOverride(
  tool: Tool,
  input: unknown,
): string | null {
  if (!SKILL_TOOL_NAMES.has(tool.name)) return null;
  if (!input || typeof input !== "object") return null;
  const skill = (input as { skill?: unknown }).skill;
  if (skill === undefined || skill === null) {
    return (
      "Missing skill name. Pass the slash command name as the skill " +
      'parameter (e.g., skill: "commit" for /commit, skill: "review-pr" ' +
      "for /review-pr)."
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// AgenC behavior: `buildSchemaNotSentHint`
// ─────────────────────────────────────────────────────────────────────

/**
 * When a deferred tool's schema was never materialized for the model
 * (its definition is withheld until `system.searchTools` / ToolSearch
 * discovers it), the model can still produce a call with the wrong
 * parameter shape. The validator's "expected array, got string" prose
 * doesn't tell it to re-fetch the schema; this hint does.
 *
 * Returns `null` when the tool is not deferred or its schema was
 * already in the catalog sent to the model.
 */
export function buildSchemaNotSentHint(
  tool: Tool,
  discoveredToolNames: ReadonlySet<string> | undefined,
): string | null {
  if (!isDeferredTool(tool)) return null;
  if (discoveredToolNames && discoveredToolNames.has(tool.name)) return null;
  return (
    `\n\nThis tool's schema was not sent to the provider — it was not in ` +
    `the discovered-tool set derived from message history. Without the ` +
    `schema in your prompt, typed parameters (arrays, numbers, booleans) ` +
    `get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call system.searchTools with query ` +
    `"select:${tool.name}", then retry this call.`
  );
}

function isDeferredTool(tool: Tool): boolean {
  return tool.metadata?.deferred === true;
}
