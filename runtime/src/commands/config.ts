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
 *   /config get <key>       — dot-path lookup (`tools_config.disabled_tools`)
 *   /config reload          — re-read TOML + env via ConfigStore.reload()
 *   /config profile         — show active profile (pending or default)
 *   /config profile <name>  — stage profile switch for next turn
 *   /config edit            — open config.toml in $EDITOR
 *   /config path            — print config file path
 *
 * @module
 */

import type { AgenCConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import { listProfiles, resolveProfile } from "../config/profiles.js";
import {
  editCanonicalUserConfig,
  parseConfigEditorCommand,
  spawnConfigEditor,
  splitConfigEditorCommandLine,
  type ConfigEditorSpawner,
} from "../config/editor.js";
import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import { openConfigMenu } from "./config-menu.js";
import {
  agencHomeFromCommandContext,
  configStoreFromCommandContext,
  getConfigFilePath,
} from "./config-context.js";
import { asRecord } from "../utils/record.js";
import { resolveSessionProviderModelSelection } from "../session/provider-model-selection.js";

export { getConfigFilePath } from "./config-context.js";

/**
 * Daemon-path detection (mirrors `daemonPermissionModeFn` in permissions.ts).
 *
 * Only the bridge/deferred TUI session exposes `applyDaemonConfig`
 * (tui/daemon-session.ts + bin/agenc.ts forwarders); the in-process Session
 * does not. Presence of the forwarder means a `/config profile` or
 * `/config reload` must be re-applied to the live daemon session, not just the
 * client-side ConfigStore.
 */
interface DaemonApplyConfigResult {
  readonly applied: boolean;
  readonly summary: string;
}

function daemonApplyConfigFn(
  ctx: SlashCommandContext,
):
  | ((params: {
      profile?: string;
      reload?: boolean;
    }) => Promise<DaemonApplyConfigResult>)
  | null {
  const sessionRecord = asRecord(ctx.session);
  const fn = sessionRecord?.applyDaemonConfig;
  return typeof fn === "function"
    ? (params) =>
        fn.call(ctx.session, params) as Promise<DaemonApplyConfigResult>
    : null;
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
    if (!Object.prototype.hasOwnProperty.call(record, seg)) {
      return `not set: ${trimmed}`;
    }
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

async function handleProfileSubcommand(
  restArg: string,
  configStore: ConfigStore,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
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
  const resolvedProfile = resolveProfile(snapshot, name);
  const applyDaemonConfig = daemonApplyConfigFn(ctx);
  if (applyDaemonConfig !== null) {
    try {
      const result = await applyDaemonConfig({ profile: name });
      return { kind: "text", text: result.summary };
    } catch (error) {
      return {
        kind: "error",
        message: `Profile apply failed: ${errorMessage(error)}`,
      };
    }
  }
  const selection = resolveSessionProviderModelSelection(
    ctx.session,
    {
      model_provider: resolvedProfile.model_provider,
      model: resolvedProfile.model,
    },
    {
      includePending: true,
      fallbackConfig: snapshot,
    },
  );
  ctx.session.setPendingProviderSwitch({
    provider: selection.provider,
    model: selection.model,
    profile: name,
  });
  return {
    kind: "text",
    text: `Profile switch to "${name}" staged — takes effect on next turn.`,
  };
}

async function refreshMcpAfterConfigReload(
  session: Session,
): Promise<string> {
  const services = asRecord(session.services);
  const mcpManager = services?.mcpManager;
  const mcpManagerRecord = asRecord(mcpManager);
  const refresh = mcpManagerRecord?.refreshFromAuthority;
  if (typeof refresh !== "function") {
    return "";
  }
  const result = (await refresh.call(mcpManager)) as {
    readonly configuredServers: readonly unknown[];
    readonly requiredServers: readonly unknown[];
  };
  return `; MCP refreshed (${result.configuredServers.length} configured, ${result.requiredServers.length} required)`;
}

function formatConfigReloadWarnings(configStore: ConfigStore): string {
  const warnings = configStore.warnings();
  if (warnings.length === 0) return "";
  return `; warnings (${warnings.length}): ${warnings.join(" | ")}`;
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export type EditorSpawner = ConfigEditorSpawner;

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

/** Shared editor tokenization, re-exported for the command contract. */
export const splitCommandLine = splitConfigEditorCommandLine;

/** Shared editor command parser, re-exported for the command contract. */
export const parseEditorCommand = parseConfigEditorCommand;

async function openConfigInEditor(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  spawner: EditorSpawner = spawnConfigEditor,
): Promise<SlashCommandResult> {
  const path = getConfigFilePath(home);
  const result = await editCanonicalUserConfig({
    path,
    editor: editorForEnv(env),
    spawner,
  });
  if (result.exitCode !== 0) {
    return {
      kind: "error",
      message: `Editor "${result.editorCommand}" exited with code ${result.exitCode}. File path: ${path}`,
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
  const spawner = deps.spawner ?? spawnConfigEditor;
  return {
    name: "config",
    description: "Manage configuration — opens a picker",
    immediate: true,
    userInvocable: true,
    execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
      safeExecute(async () => {
        const configStore = configStoreFromCommandContext(ctx);
        if (!configStore) {
          return {
            kind: "error",
            message:
              "ConfigStore not initialised (ctx.configStore / session.services.configStore missing)",
          };
        }
        const raw = ctx.argsRaw.trim();
        if (raw === "") {
          if (openConfigMenu(ctx)) return { kind: "skip" };
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
            // Re-apply the reloaded config to the live daemon session (the
            // client-side reload above only updates `/config show` chrome).
            const applyDaemonConfig = daemonApplyConfigFn(ctx);
            let daemonSuffix = "";
            if (applyDaemonConfig !== null) {
              try {
                const result = await applyDaemonConfig({ reload: true });
                daemonSuffix = `\nDaemon: ${result.summary}`;
              } catch (error) {
                return {
                  kind: "error",
                  message: `Config reloaded client-side, but daemon apply failed: ${errorMessage(error)}`,
                };
              }
            }
            try {
              const mcpSuffix = await refreshMcpAfterConfigReload(ctx.session);
              const warningSuffix = formatConfigReloadWarnings(configStore);
              return {
                kind: "text",
                text: `Config reloaded (model ${changed}: ${before.model ?? "<unset>"} → ${next.model ?? "<unset>"})${mcpSuffix}${warningSuffix}${daemonSuffix}`,
              };
            } catch (error) {
              return {
                kind: "error",
                message: `Config reloaded, but MCP refresh failed: ${errorMessage(error)}`,
              };
            }
          }
          case "profile":
            return await handleProfileSubcommand(rest, configStore, ctx);
          case "edit":
            return openConfigInEditor(
              agencHomeFromCommandContext(ctx),
              env,
              spawner,
            );
          case "path":
            return {
              kind: "text",
              text: getConfigFilePath(agencHomeFromCommandContext(ctx)),
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
