import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

const MAX_BYTES = 8_000;

function candidateChangelogs(cwd: string): string[] {
  const paths: string[] = [];
  let current = cwd;
  for (let i = 0; i < 4; i += 1) {
    paths.push(join(current, "CHANGELOG.md"));
    paths.push(join(current, "runtime", "CHANGELOG.md"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

export async function loadReleaseNotes(cwd: string): Promise<string> {
  for (const candidate of candidateChangelogs(cwd)) {
    if (!existsSync(candidate)) continue;
    const text = await readFile(candidate, "utf8");
    return text.length > MAX_BYTES
      ? `${text.slice(0, MAX_BYTES).trimEnd()}\n\n(truncated)`
      : text.trimEnd();
  }
  return "No local release notes were found for this checkout.";
}

export const releaseNotesCommand: SlashCommand = {
  name: "release-notes",
  description: "View local AgenC release notes",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({ kind: "text", text: await loadReleaseNotes(ctx.cwd) })),
};

export default releaseNotesCommand;
