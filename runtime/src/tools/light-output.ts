import { randomUUID } from "node:crypto";

/** Store a captured command chunk using the session's durable artifact path. */
export async function storeLightOutput(content: string): Promise<string | undefined> {
  const { persistToolResult, isPersistError } = await import("../utils/toolResultStorage.js");
  const result = await persistToolResult(content, `command-${randomUUID()}`);
  return isPersistError(result) ? undefined : result.filepath;
}
