/**
 * `agenc skills` — the runtime's own skill inventory as a CLI surface.
 *
 * Skills and plugins are different concepts: a skill is an authored
 * capability the agent loads (built-in, personal, project, or shipped by
 * a plugin); a plugin is the installable distribution unit. GUI clients
 * need the real inventory — the same one `/skills` shows inside a
 * session — without opening a session, so this command serializes the
 * local skills snapshot plus the registered bundled skills.
 *
 * Readonly by design: it never mutates config, never installs anything,
 * and never renders skill content.
 */

import { loadCanonicalConfig } from "../config/repository.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  loadLocalSkillsSnapshot,
  type LocalSkillMetadata,
} from "./local-loader.js";

export const SKILLS_INVENTORY_SCHEMA_VERSION = 1;
export const SKILLS_INVENTORY_KIND = "agenc.skills.inventory";

export type SkillInventoryOrigin =
  | "built-in"
  | "personal"
  | "project"
  | "plugin"
  | "managed";

export interface SkillInventoryRow {
  readonly name: string;
  readonly description?: string;
  /** When the model should reach for this skill, straight from the source. */
  readonly whenToUse?: string;
  readonly argumentHint?: string;
  readonly origin: SkillInventoryOrigin;
  /** Directory of the owning plugin, only for plugin-shipped skills. */
  readonly pluginRoot?: string;
  readonly root: string;
  readonly userInvocable: boolean;
  /** Present when the skill only activates for configured paths. */
  readonly conditional?: boolean;
}

export interface SkillsInventoryDocument {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly skills: readonly SkillInventoryRow[];
  readonly errors: readonly string[];
}

export interface SkillsCliOptions {
  readonly agencHome: string;
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type AgenCSkillsCliCommand = {
  readonly kind: "list";
  readonly json: boolean;
};

export function parseAgenCSkillsCliArgs(
  argv: readonly string[],
): AgenCSkillsCliCommand | null {
  const [command, subcommand, ...rest] = argv;
  if (command !== "skills") return null;
  if (subcommand !== "list") return null;
  let json = false;
  for (const argument of rest) {
    if (argument === "--json") json = true;
    else return null;
  }
  return { kind: "list", json };
}

export function formatAgenCSkillsCliHelpText(): string {
  return [
    "Usage: agenc skills <command>",
    "",
    "Commands:",
    "  list [--json]   List every skill this runtime serves (built-in,",
    "                  personal, project, and plugin-shipped), readonly.",
  ].join("\n");
}

function originOf(skill: LocalSkillMetadata): SkillInventoryOrigin {
  if (skill.loadedFrom === "bundled") return "built-in";
  if (skill.loadedFrom === "plugin") return "plugin";
  if (skill.loadedFrom === "managed") return "managed";
  return skill.scope === "project" ? "project" : "personal";
}

function rowOf(
  skill: LocalSkillMetadata,
  conditional: boolean,
): SkillInventoryRow {
  return {
    name: skill.name,
    ...(skill.description.length > 0
      ? { description: skill.description }
      : {}),
    ...(skill.whenToUse !== undefined && skill.whenToUse.length > 0
      ? { whenToUse: skill.whenToUse }
      : {}),
    ...(skill.argumentHint !== undefined && skill.argumentHint.length > 0
      ? { argumentHint: skill.argumentHint }
      : {}),
    origin: originOf(skill),
    ...(skill.pluginRoot !== undefined ? { pluginRoot: skill.pluginRoot } : {}),
    root: skill.root,
    userInvocable: skill.userInvocable,
    ...(conditional ? { conditional: true } : {}),
  };
}

/**
 * The full readonly skill inventory: the local snapshot (inline built-in
 * skills, personal and project SKILL.md folders, installed-plugin skills)
 * plus the runtime-registered bundled skills that live outside the local
 * loader (browser-automation, the kit installer).
 */
export async function buildSkillsInventory(
  options: SkillsCliOptions,
): Promise<SkillsInventoryDocument> {
  const errors: string[] = [];
  let config: Pick<AgenCConfig, "plugins"> | undefined;
  try {
    const loaded = await loadCanonicalConfig({
      home: options.agencHome,
      cwd: options.workspaceRoot,
      env: options.env,
    });
    config = loaded.config;
  } catch (error) {
    errors.push(
      `config unavailable, listing without plugin skills: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const snapshot = await loadLocalSkillsSnapshot({
    agencHome: options.agencHome,
    pluginStorageRoot: options.pluginStorageRoot,
    workspaceRoot: options.workspaceRoot,
    ...(config !== undefined ? { config } : {}),
    env: options.env,
  });
  const rows = new Map<string, SkillInventoryRow>();
  for (const skill of snapshot.skills) {
    const row = rowOf(skill, false);
    const key = `${row.origin}:${row.name}`;
    if (!rows.has(key)) rows.set(key, row);
  }
  for (const skill of snapshot.conditionalSkills) {
    const row = rowOf(skill, true);
    const key = `${row.origin}:${row.name}`;
    if (!rows.has(key)) rows.set(key, row);
  }
  try {
    const { getBundledSkills } = await import("./bundledSkills.js");
    for (const command of getBundledSkills()) {
      const key = `built-in:${command.name}`;
      if (rows.has(key)) continue;
      rows.set(key, {
        name: command.name,
        ...(typeof command.description === "string" &&
        command.description.length > 0
          ? { description: command.description }
          : {}),
        origin: "built-in",
        root: "",
        userInvocable: command.userInvocable !== false,
      });
    }
  } catch (error) {
    errors.push(
      `bundled skill registry unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    schemaVersion: SKILLS_INVENTORY_SCHEMA_VERSION,
    kind: SKILLS_INVENTORY_KIND,
    skills: [...rows.values()].sort(
      (a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name),
    ),
    errors,
  };
}

export async function runAgenCSkillsCli(
  command: AgenCSkillsCliCommand,
  options: SkillsCliOptions,
): Promise<number> {
  const inventory = await buildSkillsInventory(options);
  if (command.json) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return 0;
  }
  for (const skill of inventory.skills) {
    const suffix = skill.description !== undefined ? ` — ${skill.description}` : "";
    process.stdout.write(`[${skill.origin}] ${skill.name}${suffix}\n`);
  }
  for (const error of inventory.errors) {
    process.stderr.write(`agenc: ${error}\n`);
  }
  return 0;
}
