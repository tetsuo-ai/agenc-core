/** The last four characters of a key, for showing which key is being saved. */
export function maskedApiKeyTail(apiKey: string): string {
  const trimmed = apiKey.trim();
  const tail = trimmed.slice(-4);
  return tail.length > 0 ? `...${tail}` : "...";
}
