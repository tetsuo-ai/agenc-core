/**
 * `/skills` — report skills and plugin roots visible to the session.
 *
 * Reads the AgenC-shaped `skillsManager` / `pluginsManager` services
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
  type SlashCommandAppStateBridge,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface SkillsSnapshot {
  readonly invokedSkills: ReadonlyArray<string>;
  readonly availableSkills: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly scope?: string;
    readonly loadedFrom?: string;
    readonly userInvocable?: boolean;
    readonly disableModelInvocation?: boolean;
  }>;
  readonly effectiveSkillRoots: ReadonlyArray<string>;
}

type AvailableSkillSnapshot = SkillsSnapshot["availableSkills"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function mcpSkillsFromAppState(
  appStateBridge?: SlashCommandAppStateBridge,
): AvailableSkillSnapshot[] {
  const appState = appStateBridge?.getAppState?.();
  if (!isRecord(appState)) return [];
  const mcp = appState.mcp;
  if (!isRecord(mcp) || !Array.isArray(mcp.commands)) return [];

  return mcp.commands.flatMap((command): AvailableSkillSnapshot[] => {
    if (
      !isRecord(command) ||
      command.loadedFrom !== "mcp" ||
      typeof command.name !== "string" ||
      command.name.length === 0
    ) {
      return [];
    }
    return [
      {
        name: command.name,
        description: optionalString(command.description),
        scope: optionalString(command.scope),
        loadedFrom: "mcp",
        userInvocable: optionalBoolean(command.userInvocable),
        disableModelInvocation: optionalBoolean(command.disableModelInvocation),
      },
    ];
  });
}

function mergeAvailableSkills(
  skills: readonly AvailableSkillSnapshot[],
  mcpSkills: readonly AvailableSkillSnapshot[],
): AvailableSkillSnapshot[] {
  const byName = new Map<string, AvailableSkillSnapshot>();
  for (const skill of [...skills, ...mcpSkills]) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function formatSourceTag(skill: AvailableSkillSnapshot): string {
  const source = skill.loadedFrom ?? skill.scope;
  return source ? ` [${source}]` : "";
}

function formatSkillReference(name: string): string {
  return `$${name}`;
}

function formatAvailableSkill(skill: AvailableSkillSnapshot): string {
  const description = skill.description?.trim();
  const sourceTag = formatSourceTag(skill);
  if (description) {
    return `    ${formatSkillReference(skill.name)} - ${description}${sourceTag}`;
  }
  return `    ${formatSkillReference(skill.name)}${sourceTag}`;
}

export async function collectSkillsSnapshot(
  session: Session,
  appStateBridge?: SlashCommandAppStateBridge,
): Promise<SkillsSnapshot> {
  const services = session.services;
  services.skillsManager.clearSkillCaches?.();
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
    availableSkills: mergeAvailableSkills(
      [...(outcome.availableSkills ?? [])].map((skill) => ({
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        loadedFrom: skill.loadedFrom,
        userInvocable: skill.userInvocable,
        disableModelInvocation: skill.disableModelInvocation,
      })),
      mcpSkillsFromAppState(appStateBridge),
    ),
    effectiveSkillRoots: normalizeRoots(pluginView.effectiveSkillRoots()).sort(
      (a, b) => a.localeCompare(b),
    ),
  };
}

export function formatSkillsSnapshot(snapshot: SkillsSnapshot): string {
  const lines: string[] = ["Skills:"];
  lines.push(
    "  use: $skill-name [args] (slash commands use /, file mentions use @)",
  );
  if (snapshot.availableSkills.length === 0) {
    lines.push("  available: none");
  } else {
    lines.push("  available:");
    lines.push(...snapshot.availableSkills.map(formatAvailableSkill));
  }

  if (snapshot.invokedSkills.length === 0) {
    lines.push("  invoked: none");
  } else {
    lines.push(
      `  invoked: ${snapshot.invokedSkills.map(formatSkillReference).join(", ")}`,
    );
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
      const snapshot = await collectSkillsSnapshot(ctx.session, ctx.appState);
      return { kind: "text", text: formatSkillsSnapshot(snapshot) };
    }),
};

export default skillsCommand;
