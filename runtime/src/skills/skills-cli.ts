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
import { normalizeSkillDisplayName } from "../plugins/skill-display-metadata.js";
import {
  loadLocalSkillsSnapshot,
  type LocalSkillMetadata,
} from "./local-loader.js";
import {
  acceptSkillCandidate,
  listSkillCandidates,
  readSkillCandidateFile,
  rejectSkillCandidate,
  resolveSkillCandidatesRoot,
  SkillCandidateError,
} from "./skill-candidates.js";

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
  readonly displayName?: string;
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

import { SKILL_CANDIDATES_LISTING_KIND, type AgenCSkillsCliCommand } from "./skills-cli-args.js";
export {
  SKILL_CANDIDATES_LISTING_KIND,
  parseAgenCSkillsCliArgs,
  formatAgenCSkillsCliHelpText,
  type AgenCSkillsCliCommand,
} from "./skills-cli-args.js";

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
  const displayName = normalizeSkillDisplayName(skill.displayName);
  return {
    name: skill.name,
    ...(displayName !== undefined ? { displayName } : {}),
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
  for (const truncated of snapshot.truncatedRoots) {
    errors.push(
      `${truncated.droppedCount} SKILL.md files under ${truncated.root} were not loaded: the per-root cap was reached after ${truncated.loadedCount}`,
    );
  }
  for (const warning of snapshot.warnings) {
    errors.push(`${warning.path}: ${warning.reason}`);
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
  switch (command.kind) {
    case "error":
      process.stderr.write(`agenc: ${command.message}\n`);
      return 1;
    case "list":
      return runList(command.json, options);
    case "candidates-list":
      return runCandidatesList(command.json, options);
    case "candidates-show":
      return runCandidatesShow(command.slug, options);
    case "candidates-accept":
      return runCandidatesAccept(command.slug, options);
    case "candidates-reject":
      return runCandidatesReject(command.slug, options);
  }
}

async function runList(json: boolean, options: SkillsCliOptions): Promise<number> {
  const inventory = await buildSkillsInventory(options);
  if (json) {
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

async function runCandidatesList(
  json: boolean,
  options: SkillsCliOptions,
): Promise<number> {
  const listing = await listSkillCandidates(options.agencHome);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: SKILLS_INVENTORY_SCHEMA_VERSION,
          kind: SKILL_CANDIDATES_LISTING_KIND,
          root: resolveSkillCandidatesRoot(options.agencHome),
          candidates: listing.candidates,
          errors: listing.errors,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (listing.candidates.length === 0) {
    process.stdout.write(
      `no skill candidates in ${resolveSkillCandidatesRoot(options.agencHome)}\n`,
    );
  }
  for (const candidate of listing.candidates) {
    const evidence = `${candidate.evidenceCount} evidence`;
    process.stdout.write(
      `${candidate.slug}  ${candidate.createdAt ?? "created: unknown"}  ${candidate.description}  (${evidence})\n`,
    );
  }
  for (const error of listing.errors) {
    process.stderr.write(`agenc: ${error}\n`);
  }
  return 0;
}

function reportCandidateFailure(error: unknown): number {
  const message =
    error instanceof SkillCandidateError || error instanceof Error
      ? error.message
      : String(error);
  process.stderr.write(`agenc: ${message}\n`);
  return 1;
}

async function runCandidatesShow(
  slug: string,
  options: SkillsCliOptions,
): Promise<number> {
  try {
    const content = await readSkillCandidateFile(options.agencHome, slug);
    process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    return 0;
  } catch (error) {
    return reportCandidateFailure(error);
  }
}

/**
 * Accept checks the name against the same inventory `agenc skills list`
 * prints (every origin, bundled included), not only the destination
 * directory, so a draft cannot shadow a project, plugin, or built-in skill.
 */
async function runCandidatesAccept(
  slug: string,
  options: SkillsCliOptions,
): Promise<number> {
  try {
    const inventory = await buildSkillsInventory(options);
    const accepted = await acceptSkillCandidate({
      agencHome: options.agencHome,
      slug,
      installedSkillNames: inventory.skills.map((skill) => skill.name),
    });
    process.stdout.write(`accepted ${slug}: ${accepted.path}\n`);
    return 0;
  } catch (error) {
    return reportCandidateFailure(error);
  }
}

async function runCandidatesReject(
  slug: string,
  options: SkillsCliOptions,
): Promise<number> {
  try {
    await rejectSkillCandidate(options.agencHome, slug);
    process.stdout.write(`rejected ${slug}\n`);
    return 0;
  } catch (error) {
    return reportCandidateFailure(error);
  }
}
