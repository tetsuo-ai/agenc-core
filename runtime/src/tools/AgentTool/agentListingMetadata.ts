const AGENT_LISTING_UNTRUSTED_MARKER = "[untrusted agent metadata]";

const AGENT_LISTING_NEUTRALIZED_MARKER =
  "[neutralized untrusted agent metadata marker]";
const AGENT_LISTING_SYSTEM_REMINDER_TAG_RE =
  /<\s*\/?\s*system-reminder\b[^>]*>/giu;
const AGENT_LISTING_HIDDEN_TEXT_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;

function isUntrustedAgentListingSource(source: unknown): boolean {
  return typeof source === "string" && source !== "built-in";
}

function sanitizeAgentListingMetadata(
  value: string,
  options: { readonly allowUntrustedMarker?: boolean } = {},
): string {
  const sanitized = value
    .replace(
      AGENT_LISTING_SYSTEM_REMINDER_TAG_RE,
      "<neutralized-system-reminder-tag>",
    )
    .replace(AGENT_LISTING_HIDDEN_TEXT_RE, " ")
    .replace(/\s+/gu, " ")
    .trim();

  if (options.allowUntrustedMarker === true) return sanitized;
  return sanitized
    .split(AGENT_LISTING_UNTRUSTED_MARKER)
    .join(AGENT_LISTING_NEUTRALIZED_MARKER);
}

export function formatAgentListingType(agentType: string): string {
  return sanitizeAgentListingMetadata(agentType) || "(unnamed agent type)";
}

export function formatAgentListingDetails(options: {
  readonly description: string;
  readonly source?: unknown;
  readonly toolsDescription?: string;
}): string {
  const parts: string[] = [];
  if (isUntrustedAgentListingSource(options.source)) {
    parts.push(AGENT_LISTING_UNTRUSTED_MARKER);
  }

  const description = sanitizeAgentListingMetadata(options.description);
  if (description.length > 0) parts.push(description);

  const details = parts.join(" ");
  const toolsDescription =
    options.toolsDescription !== undefined
      ? sanitizeAgentListingMetadata(options.toolsDescription)
      : "";
  if (toolsDescription.length === 0) return details;
  return details.length > 0
    ? `${details} (Tools: ${toolsDescription})`
    : `(Tools: ${toolsDescription})`;
}

export function sanitizeAgentListingLine(line: string): string {
  return sanitizeAgentListingMetadata(line, { allowUntrustedMarker: true });
}
