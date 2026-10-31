/**
 * The settings a skill brings to the turn a user starts with it.
 *
 * One definition for both sides: the TUI computes them from its command when
 * the user invokes the skill, and the daemon computes them again from its own
 * skill registry when it resumes that turn after a restart, to tell whether
 * the skill changed in between. Repository-controlled skills bring none;
 * built-in skills bring only allowlisted grants.
 *
 * @module
 */

import { parseToolRuleStringsFromCLI } from "../permissions/settings.js";
import {
  SKILL_INVOCATION_SOURCES,
  type SkillInvocationSettings,
  type SkillInvocationSource,
} from "../session/skill-invocation.js";
import { bundledSkillAllowedTools } from "./bundled-skill-grants.js";
import { isRepositoryControlledSkillSource } from "./repository-skill-boundary.js";

/** The fields of a skill, from either registry, its settings come from. */
export interface SkillSettingsSource {
  readonly name: string;
  readonly source?: string;
  readonly loadedFrom?: string;
  readonly model?: string;
  readonly effort?: string | number;
  readonly allowedTools?: readonly string[];
}

function invocationSource(source: string | undefined): SkillInvocationSource | undefined {
  return (SKILL_INVOCATION_SOURCES as readonly (string | undefined)[]).includes(source)
    ? (source as SkillInvocationSource)
    : undefined;
}

/**
 * The permission rules a skill's `allowed-tools` grants its turn, one rule
 * per entry: none for a repository-controlled skill, only allowlisted ones
 * for a built-in skill.
 */
export function skillAllowedToolRules(skill: SkillSettingsSource): string[] {
  if (isRepositoryControlledSkillSource(skill.source)) return [];
  return skill.source === "bundled" || skill.loadedFrom === "bundled"
    ? bundledSkillAllowedTools(skill.name, skill.allowedTools)
    : parseToolRuleStringsFromCLI([...(skill.allowedTools ?? [])]);
}

/**
 * A skill's model, effort and grants for the turn it starts, or undefined
 * when it sets none (always for a repository-controlled skill).
 */
export function skillInvocationSettingsFor(
  skill: SkillSettingsSource,
): SkillInvocationSettings | undefined {
  if (isRepositoryControlledSkillSource(skill.source)) return undefined;
  const allowedTools = skillAllowedToolRules(skill);
  const model = skill.model?.trim();
  const effort =
    skill.effort === undefined ? undefined : String(skill.effort).trim().toLowerCase();
  if (!model && !effort && allowedTools.length === 0) return undefined;
  const source = invocationSource(skill.source);
  return Object.freeze({
    name: skill.name,
    ...(source !== undefined ? { source } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(allowedTools.length > 0
      ? { allowedTools: Object.freeze([...allowedTools]) }
      : {}),
  });
}

/** Whether two skills declare the same settings for their turns. */
export function sameSkillInvocationSettings(
  left: Omit<SkillInvocationSettings, "name"> | undefined,
  right: Omit<SkillInvocationSettings, "name"> | undefined,
): boolean {
  const tools = (settings: typeof left) => settings?.allowedTools ?? [];
  return (
    left?.model === right?.model &&
    left?.effort === right?.effort &&
    tools(left).length === tools(right).length &&
    tools(left).every((rule, index) => rule === tools(right)[index])
  );
}
