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
    readonly aliases?: readonly string[];
  }>;
  readonly effectiveSkillRoots: ReadonlyArray<string>;
}

type AvailableSkillSnapshot = SkillsSnapshot["availableSkills"][number];
interface ParsedSkillsArgs {
  readonly query?: string;
  readonly showAll: boolean;
}

interface SkillsFormatOptions {
  readonly query?: string;
  readonly showAll?: boolean;
  readonly limit?: number;
}

const DEFAULT_SKILLS_LIMIT = 8;
const MAX_SKILL_ROW_WIDTH = 76;
const DOLLAR_SKILL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseArgs(argsRaw: string): ParsedSkillsArgs {
  const trimmed = argsRaw.trim();
  if (trimmed.length === 0) return { showAll: false };
  const [firstRaw = "", ...rest] = trimmed.split(/\s+/);
  const first = firstRaw.toLowerCase();
  if (first === "all") return { showAll: true };
  if (first === "list" || first === "status") {
    return rest.length > 0
      ? { showAll: false, query: rest.join(" ") }
      : { showAll: false };
  }
  if (first === "find" || first === "search") {
    return { showAll: false, query: rest.join(" ") };
  }
  return { showAll: false, query: trimmed };
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
  if (skill.name.startsWith(".")) return " [system]";
  const source = skill.loadedFrom ?? skill.scope;
  return source ? ` [${source}]` : "";
}

function getInvocableSkillName(skill: AvailableSkillSnapshot): string {
  if (DOLLAR_SKILL_NAME_PATTERN.test(skill.name)) return skill.name;
  return skill.aliases?.find((alias) => DOLLAR_SKILL_NAME_PATTERN.test(alias)) ??
    skill.name;
}

function formatSkillReference(skill: AvailableSkillSnapshot | string): string {
  return typeof skill === "string" ? `$${skill}` : `$${getInvocableSkillName(skill)}`;
}

function compactText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function formatAvailableSkill(skill: AvailableSkillSnapshot): string {
  const sourceTag = formatSourceTag(skill);
  const prefix = `    ${formatSkillReference(skill)}`;
  const description = skill.description?.trim();
  if (description) {
    const available = Math.max(
      0,
      MAX_SKILL_ROW_WIDTH - prefix.length - sourceTag.length - " - ".length,
    );
    if (available >= 16) {
      return `${prefix} - ${compactText(description, available)}${sourceTag}`;
    }
  }
  return `${prefix}${sourceTag}`;
}

function skillMatchesQuery(
  skill: AvailableSkillSnapshot,
  query: string | undefined,
): boolean {
  if (query === undefined || query.trim().length === 0) return true;
  const needle = query.trim().toLowerCase();
  const haystack = [
    skill.name,
    skill.description,
    skill.loadedFrom,
    skill.scope,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
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
        aliases: skill.aliases,
      })),
      mcpSkillsFromAppState(appStateBridge),
    ),
    effectiveSkillRoots: normalizeRoots(pluginView.effectiveSkillRoots()).sort(
      (a, b) => a.localeCompare(b),
    ),
  };
}

export function formatSkillsSnapshot(
  snapshot: SkillsSnapshot,
  options: SkillsFormatOptions = {},
): string {
  const limit = options.limit ?? DEFAULT_SKILLS_LIMIT;
  const matchedSkills = snapshot.availableSkills.filter((skill) =>
    skillMatchesQuery(skill, options.query),
  );
  const shownSkills = options.showAll
    ? matchedSkills
    : matchedSkills.slice(0, limit);
  const hiddenCount = Math.max(0, matchedSkills.length - shownSkills.length);
  const lines: string[] = ["Skills:"];
  lines.push(
    "  use: $skill-name [args] (slash commands use /, file mentions use @)",
  );
  if (options.query !== undefined && options.query.trim().length > 0) {
    lines.push(`  filter: ${options.query.trim()}`);
  }
  if (snapshot.availableSkills.length === 0) {
    lines.push("  available: none");
  } else if (matchedSkills.length === 0) {
    lines.push("  available: no matches");
  } else {
    const count =
      hiddenCount > 0
        ? `showing ${shownSkills.length} of ${matchedSkills.length}`
        : `${matchedSkills.length}`;
    lines.push(`  available: ${count}`);
    lines.push(...shownSkills.map(formatAvailableSkill));
    if (hiddenCount > 0) {
      lines.push(
        `  more: ${hiddenCount} hidden; use /skills all or /skills <search>`,
      );
    }
  }

  if (snapshot.invokedSkills.length === 0) {
    lines.push("  invoked: none");
  } else {
    const skillsByName = new Map(
      snapshot.availableSkills.map((skill) => [skill.name, skill]),
    );
    lines.push(
      `  invoked: ${snapshot.invokedSkills.map((name) => {
        return formatSkillReference(skillsByName.get(name) ?? name);
      }).join(", ")}`,
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
      const parsed = parseArgs(ctx.argsRaw);
      const snapshot = await collectSkillsSnapshot(ctx.session, ctx.appState);
      return {
        kind: "text",
        text: formatSkillsSnapshot(snapshot, parsed),
      };
    }),
};

export default skillsCommand;
