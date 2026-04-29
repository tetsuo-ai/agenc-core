/**
 * `/config` — show / manage runtime configuration.
 *
 * Reads from `ctx.configStore` (preferred) or `session.services.configStore`
 * and returns plain-text output. Profile switching respects I-30
 * (per-turn config-snapshot immutability): `/config profile
 * <name>` stages a pending switch on `session.pendingProviderSwitch`
 * which the turn loop applies at the top of the next turn.
 *
 * Subcommands:
 *   /config                 — show effective config snapshot (read-only)
 *   /config show            — alias of the above
 *   /config get <key>       — dot-path lookup (`tools_config.web_search`)
 *   /config reload          — re-read TOML + env via ConfigStore.reload()
 *   /config profile         — show active profile (pending or default)
 *   /config profile <name>  — stage profile switch for next turn
 *   /config edit            — open config.toml in $EDITOR
 *   /config path            — print config file path
 *
 * @module
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import type { AgenCConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import { listProfiles } from "../config/profiles.js";
import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Service lookup
// ---------------------------------------------------------------------------

/**
 * Prefer the top-level `ctx.configStore` and fall back to
 * `session.services.configStore`; both entry paths wire the same store.
 */
function findConfigStore(ctx: SlashCommandContext): ConfigStore | null {
  if (ctx.configStore) return ctx.configStore;
  const services = ctx.session.services as unknown as {
    configStore?: ConfigStore | null;
  };
  return services?.configStore ?? null;
}

// ---------------------------------------------------------------------------
// Config path helpers
// ---------------------------------------------------------------------------

/**
 * Compute the path to the active `config.toml`. The input must already
 * be the resolved AgenC home (`AGENC_HOME` or `$HOME/.agenc`), matching
 * `ConfigStore`.
 */
export function getConfigFilePath(agencHome: string): string {
  return join(agencHome, "config.toml");
}

function agencHomeFromCtx(ctx: SlashCommandContext): string {
  return ctx.agencHome ?? join(ctx.home, ".agenc");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Snapshot formatting
// ---------------------------------------------------------------------------

/** Render a frozen snapshot for `/config show`. */
export function formatConfigSnapshot(cfg: AgenCConfig): string {
  // JSON is the safest readable dump — TOML re-encoding risks lossy
  // roundtrips with AgenC's inline TOML parser. Operators can paste the
  // output into a JSON-aware viewer; the same text is stable across
  // reload cycles for diffing.
  return JSON.stringify(cfg, null, 2);
}

/**
 * Dot-path lookup over a plain-object graph. Returns the string form
 * "not set" when any intermediate segment is missing. Supports readonly
 * objects, arrays (index), and primitive leaf values.
 */
export function getConfigPath(cfg: AgenCConfig, key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") return "Usage: /config get <dot.path>";
  const segments = trimmed.split(".");
  let cur: unknown = cfg;
  for (const seg of segments) {
    if (cur === undefined || cur === null) return `not set: ${trimmed}`;
    if (typeof cur !== "object") return `not set: ${trimmed}`;
    // Arrays: allow integer indexing.
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(seg, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= cur.length) {
        return `not set: ${trimmed}`;
      }
      cur = cur[idx];
      continue;
    }
    const record = cur as Record<string, unknown>;
    if (!(seg in record)) return `not set: ${trimmed}`;
    cur = record[seg];
  }
  if (cur === undefined || cur === null) return `not set: ${trimmed}`;
  if (typeof cur === "object") return JSON.stringify(cur, null, 2);
  return String(cur);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Active profile name: prefer `session.pendingProviderSwitch.profile`
 * (staged swap), else null — the snapshot itself does not carry a profile
 * name today.
 */
function currentProfileName(session: Session): string | null {
  const pending = session.pendingProviderSwitch;
  return pending?.profile ?? null;
}

function handleProfileSubcommand(
  restArg: string,
  configStore: ConfigStore,
  ctx: SlashCommandContext,
): SlashCommandResult {
  const name = restArg.trim();
  const snapshot = configStore.current();
  if (name === "") {
    const active = currentProfileName(ctx.session) ?? "(default)";
    const available = listProfiles(snapshot);
    const availableLine =
      available.length > 0
        ? `Available: ${available.join(", ")}`
        : "Available: (no profiles declared)";
    return {
      kind: "text",
      text: `Active profile: ${active}\n${availableLine}`,
    };
  }
  const available = listProfiles(snapshot);
  if (!available.includes(name)) {
    return {
      kind: "error",
      message: `Unknown profile: "${name}". Available: ${
        available.length > 0 ? available.join(", ") : "(none)"
      }`,
    };
  }
  // Stage the switch. Preserve any existing provider/model if already
  // set by recovery/fallback — the turn loop applies provider+profile
  // together at top-of-loop (I-13 + I-30). Route through the typed
  // mutator so the staging site stays consistent across commands.
  const prior = ctx.session.pendingProviderSwitch;
  const profile = snapshot.profiles?.[name];
  const nextProvider = profile?.model_provider ?? prior?.provider ?? "";
  const nextModel = profile?.model ?? prior?.model ?? "";
  ctx.session.setPendingProviderSwitch({
    provider: nextProvider,
    model: nextModel,
    profile: name,
  });
  return {
    kind: "text",
    text: `Profile switch to "${name}" staged — takes effect on next turn.`,
  };
}

async function refreshMcpAfterConfigReload(
  session: Session,
  next: AgenCConfig,
): Promise<string> {
  const services = session.services as {
    mcpManager?: Session["services"]["mcpManager"];
  };
  const refresh = services.mcpManager?.refreshFromConfig;
  if (typeof refresh !== "function") {
    return "";
  }
  const result = await refresh(next);
  return `; MCP refreshed (${result.configuredServers.length} configured, ${result.requiredServers.length} required)`;
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditorSpawner {
  (command: string, args: readonly string[]): Promise<number>;
}

const defaultSpawnEditor: EditorSpawner = (command, args) =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "inherit" });
      child.on("exit", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(127));
    } catch {
      resolve(127);
    }
  });

/**
 * Resolve the editor binary using $EDITOR → $VISUAL → `code`/`vim`/`nano`
 * fallback. Exposed for tests to override via `editorForEnv`.
 */
export function editorForEnv(env: NodeJS.ProcessEnv): string {
  const preferred = env.EDITOR?.trim() || env.VISUAL?.trim();
  if (preferred && preferred.length > 0) return preferred;
  // Fallbacks mirror AgenC's Settings/edit flow.
  return "vim";
}

async function openConfigInEditor(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  spawner: EditorSpawner = defaultSpawnEditor,
): Promise<SlashCommandResult> {
  const path = getConfigFilePath(home);
  if (!existsSync(path)) {
    return {
      kind: "text",
      text: `Config file does not exist yet: ${path}\nCreate it with: ${editorForEnv(env)} ${path}`,
    };
  }
  const editor = editorForEnv(env);
  const code = await spawner(editor, [path]);
  if (code !== 0) {
    return {
      kind: "error",
      message: `Editor "${editor}" exited with code ${code}. File path: ${path}`,
    };
  }
  return { kind: "text", text: `Edited ${path} (run /config reload to apply)` };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

interface ConfigCommandDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawner?: EditorSpawner;
}

/**
 * Factory: constructs the command with optional injected deps. Tests use
 * this to stub the editor spawner; runtime wiring calls `configCommand`
 * (the default export) which uses the real deps.
 */
export function createConfigCommand(deps: ConfigCommandDeps = {}): SlashCommand {
  const env = deps.env ?? process.env;
  const spawner = deps.spawner ?? defaultSpawnEditor;
  return {
    name: "config",
    aliases: ["settings"],
    description: "Show or manage configuration",
    immediate: true,
    userInvocable: true,
    execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
      safeExecute(async () => {
        const configStore = findConfigStore(ctx);
        if (!configStore) {
          return {
            kind: "error",
            message:
              "ConfigStore not initialised (ctx.configStore / session.services.configStore missing)",
          };
        }
        const raw = ctx.argsRaw.trim();
        if (raw === "") {
          return {
            kind: "text",
            text: formatConfigSnapshot(configStore.current()),
          };
        }
        const firstSpace = raw.search(/\s/);
        const sub = (firstSpace === -1 ? raw : raw.slice(0, firstSpace))
          .toLowerCase();
        const rest = firstSpace === -1 ? "" : raw.slice(firstSpace).trim();

        switch (sub) {
          case "show":
            return {
              kind: "text",
              text: formatConfigSnapshot(configStore.current()),
            };
          case "get":
            return {
              kind: "text",
              text: getConfigPath(configStore.current(), rest),
            };
          case "reload": {
            const before = configStore.current();
            const next = await configStore.reload();
            const changed = before.model !== next.model ? "changed" : "unchanged";
            try {
              const mcpSuffix = await refreshMcpAfterConfigReload(
                ctx.session,
                next,
              );
              return {
                kind: "text",
                text: `Config reloaded (model ${changed}: ${before.model ?? "<unset>"} → ${next.model ?? "<unset>"})${mcpSuffix}`,
              };
            } catch (error) {
              return {
                kind: "error",
                message: `Config reloaded, but MCP refresh failed: ${errorMessage(error)}`,
              };
            }
          }
          case "profile":
            return handleProfileSubcommand(rest, configStore, ctx);
          case "edit":
            return openConfigInEditor(agencHomeFromCtx(ctx), env, spawner);
          case "path":
            return {
              kind: "text",
              text: getConfigFilePath(agencHomeFromCtx(ctx)),
            };
          default:
            return {
              kind: "error",
              message: `Unknown subcommand: "${sub}". Try: show, get, reload, profile, edit, path`,
            };
        }
      }),
  };
}

/** Default command instance wired with real editor spawner. */
export const configCommand: SlashCommand = createConfigCommand();

export default configCommand;
