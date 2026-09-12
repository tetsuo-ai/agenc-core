import { parseSlashCommand, type ParsedSlashCommand } from "./dispatcher.js";

/** Local inspection and owned-task controls that need no model or Editor lease. */
export function parseLocalControlCommand(input: string): ParsedSlashCommand | null {
  const parsed = parseSlashCommand(input);
  if (parsed === null || parsed.isMcp) return null;
  if (parsed.name === "swarm") {
    return parsed.argsRaw === "" || parsed.argsRaw.toLowerCase() === "status" ? parsed : null;
  }
  return parsed.argsRaw === "" && ["tasks", "jobs", "bashes", "status"].includes(parsed.name)
    ? parsed
    : null;
}
