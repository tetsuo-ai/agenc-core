import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { resolveRuntimePackageRootFromUrl } from "../../app-server/daemon-runtime-info.js";
import type { BundledSkillDefinition } from "../../skills/bundledSkills.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";

const MAX_REFERENCE_BYTES = 512 * 1024;

/**
 * Resolve a plugin that ships INSIDE the runtime package.
 *
 * The directory is resolved from the runtime package root, never from the
 * workspace. That distinction is the whole security argument for enabling
 * these by default while `plugins.enabled` stays false: workspace discovery
 * loads whatever `plugins/` the repository you happen to open contains, and a
 * third party can forge that. The runtime package is what we shipped.
 */
export function resolveShippedPluginDir(
  pluginName: string,
  moduleUrl = import.meta.url,
): string | null {
  const runtimeRoot = resolveRuntimePackageRootFromUrl(moduleUrl);
  const candidates = [
    ...(runtimeRoot === null ? [] : [join(runtimeRoot, "plugins", pluginName)]),
    // Dev checkout: plugins/ lives at the repo root, one level above runtime/.
    ...(runtimeRoot === null
      ? []
      : [join(runtimeRoot, "..", "plugins", pluginName)]),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "skills", pluginName, "SKILL.md"))) {
      return candidate;
    }
  }
  return null;
}

/** Read `references/**` next to a SKILL.md into the bundled-skill file map. */
export function readSkillReferenceFiles(
  skillDir: string,
): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      // A reference is documentation the model may Read on demand. Anything
      // oversized is skipped rather than silently truncated, so a half file
      // can never be mistaken for the whole one.
      if (!info.isFile() || info.size > MAX_REFERENCE_BYTES) continue;
      const key = relative(skillDir, full).split(sep).join("/");
      files[key] = readFileSync(full, "utf8");
    }
  };
  walk(join(skillDir, "references"));
  return files;
}

/**
 * Build a bundled-skill definition from a plugin shipped in the runtime
 * package. Returns null when the plugin is absent, so a trimmed install
 * degrades to "the skill is not offered" instead of failing startup.
 */
export function shippedPluginSkill(input: {
  readonly pluginName: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly argumentHint?: string;
  readonly moduleUrl?: string;
}): BundledSkillDefinition | null {
  const pluginDir = resolveShippedPluginDir(
    input.pluginName,
    input.moduleUrl ?? import.meta.url,
  );
  if (pluginDir === null) return null;
  const skillDir = join(pluginDir, "skills", input.pluginName);
  const prompt = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const files = readSkillReferenceFiles(skillDir);
  return {
    name: input.pluginName,
    description: input.description,
    ...(input.whenToUse !== undefined ? { whenToUse: input.whenToUse } : {}),
    ...(input.argumentHint !== undefined
      ? { argumentHint: input.argumentHint }
      : {}),
    ...(Object.keys(files).length > 0 ? { files } : {}),
    getPromptForCommand: async (): Promise<ContentBlockParam[]> => [
      { type: "text", text: prompt },
    ],
  };
}
