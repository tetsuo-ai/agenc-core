import { createHash } from "node:crypto";

/** Maximum length shared by runtime server identifiers and public status DTOs. */
export const MAX_SERVER_IDENTIFIER_LENGTH = 256;

/**
 * Preserve short scoped identifiers verbatim and deterministically compact
 * long ones without losing collision resistance.
 */
export function boundScopedServerIdentifier(value: string): string {
  if (value.length <= MAX_SERVER_IDENTIFIER_LENGTH) return value;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const suffix = `:${digest}`;
  return `${value.slice(0, MAX_SERVER_IDENTIFIER_LENGTH - suffix.length)}${suffix}`;
}
