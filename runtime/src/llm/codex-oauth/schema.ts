/**
 * Codex Responses API schema compatibility helpers.
 *
 * @module
 */

export function sanitizeCodexJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCodexJsonSchema(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = sanitizeCodexJsonSchema(entry);
  }

  const type = result.type;
  const declaresArray =
    type === "array" ||
    (Array.isArray(type) && type.some((entry) => entry === "array"));
  if (declaresArray && result.items === undefined) {
    result.items = {};
  }
  return result;
}
