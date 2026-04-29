/**
 * Palette item suppliers.
 *
 * Two factories that produce `PaletteItem[]` for the palette popover:
 *
 *   - `getSlashCommandItems(registry)` — wraps the T11 `CommandRegistry`
 *     output. Filters internal-only entries (`userInvocable: false`) and
 *     prefixes each name with `/`.
 *   - `getMentionItems(cwd, query)` — walks `cwd` breadth-first via
 *     `fs/promises.readdir` and produces file entries for `@-mention`
 *     autocomplete. Bounded to 200 results and 4 directory levels; sorts
 *     by modification time descending so recently-touched files float to
 *     the top.
 *
 * No external globbing library is pulled in; the walk is a plain BFS over
 * `readdir({ withFileTypes: true })` with a fixed skip-list for common
 * vendor and build directories.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildProviderModelCatalog,
  type AgenCConfig,
} from "../../config/index.js";
import { listProfiles } from "../../config/profiles.js";
import { USER_ADDRESSABLE_PERMISSION_MODES } from "../../permissions/types.js";
import type { PaletteItem } from "./Palette.js";

/** Minimal shape of a registry entry the palette consumes. */
export interface SlashCommandLike {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly immediate?: boolean;
  readonly userInvocable?: boolean;
}

/** Minimal shape of the registry object the palette consumes. */
export interface SlashCommandRegistryLike {
  list(): ReadonlyArray<SlashCommandLike>;
}

export interface SkillMentionServiceLike {
  skillsForConfig(
    input: unknown,
    fs?: unknown,
  ): Promise<{
    readonly availableSkills?: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
      readonly path?: string;
      readonly scope?: string;
    }>;
  }>;
}

/**
 * Minimal shape of an app/connector registry for the `$`-mention palette.
 *
 * Apps and skills share the `$<token>` trigger because both surface as
 * runtime-side mentions but resolve through different managers. The two
 * namespaces are expected to be disjoint at the manager layer; if a
 * collision is ever observed, the manager owns disambiguation.
 *
 * Optional in `ComposerSession` — when no `appsManager` is plumbed in,
 * `getAppMentionItems` returns `[]` and the existing skill-only behavior
 * is preserved.
 */
export interface AppMentionServiceLike {
  listApps(): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly description?: string;
      readonly category?: string;
    }>
  >;
}

/**
 * Produce palette items from a slash-command registry.
 *
 * Entries with `userInvocable: false` are filtered out — they're
 * internal-only commands that should never surface in the UI (this
 * matches the dispatcher's routing rule).
 */
export function getSlashCommandItems(
  registry: SlashCommandRegistryLike,
): PaletteItem[] {
  const out: PaletteItem[] = [];
  const visible = registry
    .list()
    .filter((cmd) => cmd.userInvocable !== false);

  for (const cmd of visible) {
    const aliases = (cmd.aliases ?? []).filter(
      (alias) => typeof alias === "string" && alias.length > 0,
    );
    const descriptionParts: string[] = [];
    if (typeof cmd.description === "string" && cmd.description.length > 0) {
      descriptionParts.push(cmd.description);
    }
    if (cmd.immediate) {
      descriptionParts.push("local");
    }
    if (aliases.length > 0) {
      descriptionParts.push(aliases.map((alias) => `/${alias}`).join(" "));
    }
    out.push({
      id: cmd.name,
      label: `/${cmd.name}`,
      description: descriptionParts.join(" • "),
      keywords: [cmd.name, ...aliases],
      value: `/${cmd.name}`,
    });
  }
  return out;
}

export async function getSkillMentionItems(
  skillsManager: SkillMentionServiceLike | undefined,
): Promise<PaletteItem[]> {
  if (skillsManager === undefined) return [];
  let outcome;
  try {
    outcome = await skillsManager.skillsForConfig({}, null);
  } catch {
    return [];
  }
  const skills = outcome.availableSkills ?? [];
  return skills
    .filter((skill) => skill.name.trim().length > 0)
    .map((skill) => ({
      id: `skill:${skill.name}:${skill.path ?? ""}`,
      label: `$${skill.name}`,
      description:
        skill.description ??
        (skill.scope ? `${skill.scope} skill` : "AgenC skill"),
      keywords: [
        skill.name,
        skill.scope ?? "",
        skill.path ?? "",
      ].filter((value) => value.length > 0),
      value: `$${skill.name}`,
      kind: "skill" as const,
    }));
}

export async function getAppMentionItems(
  appsManager: AppMentionServiceLike | undefined,
): Promise<PaletteItem[]> {
  if (appsManager === undefined) return [];
  let apps;
  try {
    apps = await appsManager.listApps();
  } catch {
    return [];
  }
  return apps
    .filter((app) => app.id.trim().length > 0)
    .map((app) => ({
      id: `app:${app.id}`,
      label: `$${app.id}`,
      description:
        app.description ??
        (app.category ? `${app.category} app` : "AgenC app"),
      keywords: [app.id, app.category ?? ""].filter(
        (value) => value.length > 0,
      ),
      value: `$${app.id}`,
      kind: "app" as const,
    }));
}

const PROVIDER_DISPLAY_ORDER = [
  "xai",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "groq",
  "deepseek",
  "ollama",
  "lmstudio",
] as const;

const PROVIDER_RUNTIME_SLUGS = Object.freeze({
  xai: "grok",
  openai: "openai",
  anthropic: "anthropic",
  gemini: "gemini",
  openrouter: "openrouter",
  groq: "groq",
  deepseek: "deepseek",
  ollama: "ollama",
  lmstudio: "lmstudio",
} as const);

const PROVIDER_DISPLAY_LABELS = Object.freeze({
  xai: "xAI",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  deepseek: "DeepSeek",
  ollama: "Ollama",
  lmstudio: "LM Studio",
} as const);

const PROVIDER_KEYWORDS = Object.freeze({
  xai: ["grok"],
  openai: ["gpt"],
  anthropic: ["claude"],
  gemini: ["google"],
  openrouter: ["router"],
  groq: ["llama"],
  deepseek: ["reasoner"],
  ollama: ["local"],
  lmstudio: ["local", "studio"],
} as const);

// Sourced from the official xAI docs MCP page `developers/models` on
// April 22, 2026. We keep this list local to slash-palette discovery so
// the UI can offer current Grok models without perturbing broader config
// defaults or transport behavior.
export const XAI_CURRENT_TEXT_MODELS = Object.freeze([
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4.20-multi-agent-0309",
] as const);

function normalizeProviderChoice(
  provider: string | undefined,
): keyof typeof PROVIDER_RUNTIME_SLUGS | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "grok" || normalized === "xai") return "xai";
  if (normalized in PROVIDER_RUNTIME_SLUGS) {
    return normalized as keyof typeof PROVIDER_RUNTIME_SLUGS;
  }
  return undefined;
}

function decorateCatalogWithCurrentXaiModels(
  config?: AgenCConfig,
): Readonly<Record<string, readonly string[]>> {
  const base = buildProviderModelCatalog(config);
  const grokCatalog = base.grok ?? [];
  const currentXaiModels = new Set<string>(XAI_CURRENT_TEXT_MODELS);
  const grokModels = [
    ...XAI_CURRENT_TEXT_MODELS,
    ...grokCatalog.filter((model) => !currentXaiModels.has(model)),
  ];
  return Object.freeze({
    ...base,
    grok: Object.freeze(grokModels),
  });
}

export function getProviderPaletteItems(): PaletteItem[] {
  return PROVIDER_DISPLAY_ORDER.map((provider) => ({
    id: provider,
    label: PROVIDER_DISPLAY_LABELS[provider],
    description: `Use ${PROVIDER_DISPLAY_LABELS[provider]} as the active model provider`,
    keywords: [provider, ...PROVIDER_KEYWORDS[provider]],
    value: provider,
  }));
}

export function getModelPaletteItems(options: {
  readonly provider?: string;
  readonly config?: AgenCConfig;
}): PaletteItem[] {
  const provider = normalizeProviderChoice(options.provider);
  if (!provider) return [];
  const runtimeProvider = PROVIDER_RUNTIME_SLUGS[provider];
  const catalog = decorateCatalogWithCurrentXaiModels(options.config);
  const models = catalog[runtimeProvider] ?? [];
  return models.map((model) => ({
    id: `${provider}:${model}`,
    label: model,
    keywords: [model, PROVIDER_DISPLAY_LABELS[provider]],
    value: model,
  }));
}

const PERMISSION_MODE_DESCRIPTIONS = Object.freeze({
  default: "Ask before running non-allowlisted tools",
  acceptEdits: "Auto-approve edit/write operations, ask for other tools",
  plan: "Read-only planning mode with write actions blocked",
  auto: "Use the runtime classifier to decide when to ask",
  bypassPermissions: "Run without approval prompts for this workspace",
  dontAsk: "Never prompt; deny tools unless already pre-approved",
} as const);

export function getPermissionsActionPaletteItems(): PaletteItem[] {
  return [
    {
      id: "permissions:list",
      label: "Show current permissions",
      description: "Display the current rules and active permission mode",
      value: "list",
    },
    {
      id: "permissions:mode",
      label: "Change permission mode",
      description: "Pick a new approval mode for this session",
      value: "mode",
    },
    {
      id: "permissions:export",
      label: "Export permission rules",
      description: "Render the current permissions block as JSON",
      value: "export",
    },
    {
      id: "permissions:accept-bypass",
      label: "Accept bypassPermissions for this workspace",
      description: "Record explicit bypass consent for the current workspace",
      value: "accept-bypass",
    },
  ];
}

export function getPermissionModePaletteItems(): PaletteItem[] {
  return USER_ADDRESSABLE_PERMISSION_MODES.map((mode) => ({
    id: `permissions:mode:${mode}`,
    label: mode,
    description: PERMISSION_MODE_DESCRIPTIONS[mode],
    value: mode,
  }));
}

export function getConfigActionPaletteItems(): PaletteItem[] {
  return [
    {
      id: "config:show",
      label: "Show config snapshot",
      description: "Print the effective runtime configuration",
      value: "show",
    },
    {
      id: "config:reload",
      label: "Reload config",
      description: "Re-read config.toml and environment overrides",
      value: "reload",
    },
    {
      id: "config:profile",
      label: "Switch config profile",
      description: "Pick a declared profile for the next turn",
      value: "profile",
    },
    {
      id: "config:edit",
      label: "Edit config.toml",
      description: "Open the config file in $EDITOR",
      value: "edit",
    },
    {
      id: "config:path",
      label: "Show config path",
      description: "Print the resolved config.toml path",
      value: "path",
    },
  ];
}

export function getConfigProfilePaletteItems(
  config?: AgenCConfig,
): PaletteItem[] {
  return listProfiles(config ?? {}).map((profileName) => ({
    id: `config:profile:${profileName}`,
    label: profileName,
    description: "Stage this profile for the next turn",
    value: profileName,
  }));
}

export function getExitWorktreePaletteItems(): PaletteItem[] {
  return [
    {
      id: "exit-worktree:keep",
      label: "Keep worktree and return",
      description: "Leave the worktree on disk and restore the original cwd",
      value: "keep",
    },
    {
      id: "exit-worktree:remove",
      label: "Remove worktree",
      description: "Delete the worktree after leaving it",
      value: "remove",
    },
    {
      id: "exit-worktree:discard",
      label: "Remove worktree and discard changes",
      description: "Force-remove the worktree and drop uncommitted changes",
      value: "remove --discard-changes",
    },
  ];
}

/** Directories we never descend into during a mention walk. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".agenc",
  ".next",
  "coverage",
]);

/** Hard cap on returned entries so a large repo can't freeze the TUI. */
export const MENTION_RESULT_CAP = 200;

/** Max directory depth to descend (root == depth 0). */
export const MENTION_DEPTH_CAP = 4;

interface WalkedFile {
  readonly relativePath: string;
  readonly mtimeMs: number;
}

interface Frontier {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly depth: number;
}

/**
 * BFS the directory tree under `cwd` and collect up to `MENTION_RESULT_CAP`
 * files whose base name contains `query` (case-insensitive). Returns the
 * entries sorted by mtime descending.
 *
 * The walk stops as soon as the result cap is reached; it does not
 * pre-collect everything and then trim. That keeps the cost roughly
 * proportional to the number of matches in shallow directories.
 */
export async function getMentionItems(
  cwd: string,
  query: string,
): Promise<PaletteItem[]> {
  // Guard: non-existent or non-directory `cwd` yields an empty list. This
  // avoids an unhandled exception propagating into the React render path.
  let rootStat;
  try {
    rootStat = await fs.stat(cwd);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const qLower = query.toLowerCase();
  const results: WalkedFile[] = [];
  const queue: Frontier[] = [
    { absolutePath: cwd, relativePath: "", depth: 0 },
  ];

  while (queue.length > 0 && results.length < MENTION_RESULT_CAP) {
    const frame = queue.shift();
    if (frame === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(frame.absolutePath, {
        withFileTypes: true,
      });
    } catch {
      // Permission denied / transient error — skip this directory rather
      // than fail the whole walk.
      continue;
    }
    for (const dirent of entries) {
      if (results.length >= MENTION_RESULT_CAP) break;
      const name = dirent.name;
      const nextAbs = path.join(frame.absolutePath, name);
      const nextRel = frame.relativePath
        ? `${frame.relativePath}/${name}`
        : name;

      if (dirent.isDirectory()) {
        // Skip vendor/build directories and anything starting with a `.`
        // beyond the project root itself.
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith(".") && name !== "." && name !== "..") {
          continue;
        }
        if (frame.depth + 1 > MENTION_DEPTH_CAP) continue;
        queue.push({
          absolutePath: nextAbs,
          relativePath: nextRel,
          depth: frame.depth + 1,
        });
        continue;
      }

      if (!dirent.isFile()) continue;

      // Query filter against the base name only — paths stay hidden from
      // the filter so deeply nested files don't accidentally match via
      // their parent directory name.
      if (qLower.length > 0 && !name.toLowerCase().includes(qLower)) {
        continue;
      }

      let mtimeMs = 0;
      try {
        const st = await fs.stat(nextAbs);
        mtimeMs = st.mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      results.push({ relativePath: nextRel, mtimeMs });
    }
  }

  results.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    if (a.relativePath < b.relativePath) return -1;
    if (a.relativePath > b.relativePath) return 1;
    return 0;
  });

  return results.map((entry) => ({
    id: entry.relativePath,
    label: entry.relativePath,
    value: `@${entry.relativePath}`,
  }));
}
