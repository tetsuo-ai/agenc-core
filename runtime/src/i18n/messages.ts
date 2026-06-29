type MessageValues = Readonly<Record<string, string | number | boolean>>;

const ENGLISH_MESSAGES = {
  "cli.outputFormat.requiresValue":
    "agenc --output-format requires a value (usage: agenc -p --output-format <text|json|stream-json>)",
  "cli.inputFormat.requiresValue":
    "agenc --input-format requires a value (usage: agenc -p --input-format <stream-json>)",
} as const;

export type MessageId = keyof typeof ENGLISH_MESSAGES;

export function formatMessage(
  id: MessageId,
  values: MessageValues = {},
): string {
  return ENGLISH_MESSAGES[id].replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

