/**
 * `/skills` — report skills and plugin roots visible to the session.
 *
 * Reads the codex-shaped `skillsManager` / `pluginsManager` services
 * from `SessionServices`. The current manager may be a no-op, but the
 * command surface is runtime-owned and will automatically reflect the
 * real loader once that service is bound.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface SkillsSnapshot {
  readonly invokedSkills: ReadonlyArray<string>;
  readonly effectiveSkillRoots: ReadonlyArray<string>;
}

function parseArgs(argsRaw: string): "list" | null {
  const first = argsRaw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "" || first === "list" || first === "status") return "list";
  return null;
}

function normalizeRoots(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  if (value instanceof Set) return [...value].map(String);
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  return [String(value)];
}

export async function collectSkillsSnapshot(
  session: Session,
): Promise<SkillsSnapshot> {
  const services = session.services;
  const outcome = await services.skillsManager.skillsForConfig(
    session.config,
    null,
  );
  const pluginView = await services.pluginsManager.pluginsForConfig(
    session.config,
  );
  return {
    invokedSkills: [...outcome.invokedSkills].sort((a, b) =>
      a.localeCompare(b),
    ),
    effectiveSkillRoots: normalizeRoots(pluginView.effectiveSkillRoots()).sort(
      (a, b) => a.localeCompare(b),
    ),
  };
}

export function formatSkillsSnapshot(snapshot: SkillsSnapshot): string {
  const lines: string[] = ["Skills:"];
  if (snapshot.invokedSkills.length === 0) {
    lines.push("  loaded: none");
  } else {
    lines.push(`  loaded: ${snapshot.invokedSkills.join(", ")}`);
  }

  if (snapshot.effectiveSkillRoots.length === 0) {
    lines.push("  plugin roots: none");
  } else {
    lines.push(`  plugin roots: ${snapshot.effectiveSkillRoots.join(", ")}`);
  }
  return lines.join("\n");
}

export const skillsCommand: SlashCommand = {
  name: "skills",
  description: "Show loaded skills and effective plugin skill roots",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      if (parseArgs(ctx.argsRaw) === null) {
        return { kind: "error", message: "Usage: /skills [list|status]" };
      }
      const snapshot = await collectSkillsSnapshot(ctx.session);
      return { kind: "text", text: formatSkillsSnapshot(snapshot) };
    }),
};

export default skillsCommand;
