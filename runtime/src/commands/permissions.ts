/**
 * `/permissions` — list / manage permission rules + mode.
 *
 * Pure text output. No TUI (T12 ships the interactive variant). Shares
 * the rule-string grammar + registry primitives used by the evaluator:
 *
 *   - `rules.ts`        — parseRuleString, serializeRuleValue,
 *                         applyPermissionUpdate
 *   - `settings.ts`     — addPermissionRulesToSettings, deletePermissionRule,
 *                         recordBypassPermissionsAcceptance
 *   - `mode.ts`         — transitionPermissionMode, PermissionModeRegistry
 *
 * Subcommands:
 *   /permissions                    — list rules grouped by behavior + source
 *   /permissions list               — alias of the above
 *   /permissions add <rule>         — add to session source (default)
 *     • optional: "--persist user" persists allow rules globally.
 *       Project/local files may persist deny/ask restrictions, not approvals.
 *     • rule syntax: "<behavior> <rule-string>"   (behavior: allow|deny|ask)
 *   /permissions remove <rule>      — remove matching rule from session
 *     • optional: "--persist user|project|local" deletes from disk too.
 *   /permissions export             — dump rules as JSON
 *   /permissions mode               — print current permission mode
 *   /permissions mode <mode>        — transition to <mode> (emits warning).
 *     • Switching to `bypassPermissions` for the first time in a given
 *       workspace is refused until the user confirms via
 *       `/permissions accept-bypass`.
 *   /permissions accept-bypass      — record explicit consent for the
 *     current workspace to use `bypassPermissions` mode. Updates the
 *     session-level allowlist and persists to the user settings file so
 *     subsequent sessions in the same workspace do not re-prompt.
 *
 * Integration notes:
 *   - `session.services.permissionModeRegistry` is the source of truth.
 *   - `applyPermissionUpdate` on the session source is transient; the
 *     `--persist` flag (user/project/local) additionally routes to
 *     `addPermissionRulesToSettings` / `deletePermissionRule`.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import {
  PERMISSION_BEHAVIORS,
  PERMISSION_RULE_SOURCES,
  USER_ADDRESSABLE_PERMISSION_MODES,
  isPermissionMode,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleSource,
  type PermissionRuleValue,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { parseRuleString, serializeRuleValue } from "../permissions/rules.js";
import { applyPermissionUpdate } from "../permissions/rules.js";
import { transitionPermissionMode } from "../permissions/permission-mode.js";
import type { PermissionModeRegistry } from "../permissions/permission-mode.js";
import {
  addPermissionRulesToSettings,
  deletePermissionRule,
  recordBypassPermissionsAcceptance,
  type DiskEnv,
} from "../permissions/settings.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import {
  openPermissionsMenu,
  type PermissionsMenuController,
} from "./permissions-menu.js";

// ---------------------------------------------------------------------------
// Helpers: locate the permission registry on session.services.
// ---------------------------------------------------------------------------

/**
 * Look up `permissionModeRegistry` on `SessionServices`. Tests inject a
 * registry via this same slot.
 */
function findPermissionRegistry(
  session: Session,
): PermissionModeRegistry | null {
  const services = session.services as unknown as {
    permissionModeRegistry?: PermissionModeRegistry | null;
  };
  return services?.permissionModeRegistry ?? null;
}

/**
 * Result of the daemon-backed `session.setPermissionMode` RPC, narrowed
 * to the fields the command surfaces. The bridge session declares
 * `setDaemonPermissionMode` (tui/daemon-session.ts); the in-process
 * Session does not, so its absence means we mutate the local registry.
 */
interface DaemonSetPermissionModeResult {
  readonly applied: boolean;
  readonly previousMode: string;
  readonly mode: string;
}

function daemonPermissionModeFn(
  ctx: SlashCommandContext,
): ((mode: string) => Promise<DaemonSetPermissionModeResult>) | null {
  const fn = (ctx.session as unknown as {
    setDaemonPermissionMode?: (
      mode: string,
    ) => Promise<DaemonSetPermissionModeResult>;
  }).setDaemonPermissionMode;
  return typeof fn === "function" ? fn.bind(ctx.session) : null;
}

function diskEnvForCtx(ctx: SlashCommandContext): DiskEnv {
  return {
    home: ctx.home,
    cwd: ctx.cwd,
    configStore: ctx.configStore,
  };
}

// ---------------------------------------------------------------------------
// Rule listing + export
// ---------------------------------------------------------------------------

interface GroupedRule {
  readonly source: PermissionRuleSource;
  readonly value: string;
}

function collectRulesForBehavior(
  ctx: ToolPermissionContext,
  behavior: PermissionBehavior,
): GroupedRule[] {
  const bucket =
    behavior === "allow"
      ? ctx.alwaysAllowRules
      : behavior === "deny"
        ? ctx.alwaysDenyRules
        : ctx.alwaysAskRules;
  const out: GroupedRule[] = [];
  for (const source of PERMISSION_RULE_SOURCES) {
    const list = bucket[source];
    if (!list || list.length === 0) continue;
    for (const raw of list) {
      out.push({ source, value: raw });
    }
  }
  return out;
}

/**
 * Render the current permission context as a plain-text list grouped by
 * behavior × source. Exposed for tests.
 */
export function formatRuleList(ctx: ToolPermissionContext): string {
  const chunks: string[] = [];
  chunks.push(`Mode: ${ctx.mode}`);

  for (const behavior of PERMISSION_BEHAVIORS) {
    const rules = collectRulesForBehavior(ctx, behavior);
    if (rules.length === 0) continue;
    // Group by source within this behavior.
    const bySource = new Map<PermissionRuleSource, string[]>();
    for (const r of rules) {
      const bucket = bySource.get(r.source) ?? [];
      bucket.push(r.value);
      bySource.set(r.source, bucket);
    }
    for (const source of PERMISSION_RULE_SOURCES) {
      const strings = bySource.get(source);
      if (!strings || strings.length === 0) continue;
      chunks.push(`${behavior.toUpperCase()} (${source}):`);
      for (const s of strings) chunks.push(`  ${s}`);
    }
  }

  if (ctx.additionalWorkingDirectories.size > 0) {
    chunks.push("ADDITIONAL DIRECTORIES:");
    for (const entry of ctx.additionalWorkingDirectories.values()) {
      chunks.push(`  ${entry.path} (${entry.source})`);
    }
  }

  if (chunks.length === 1) {
    // Only mode emitted — no rules configured.
    chunks.push("(no permission rules configured)");
  }
  return chunks.join("\n");
}

/**
 * Serialize the current context as a JSON object shaped like the
 * `permissions` block in `settings.json`. Every source is flattened into
 * one union; operators can split as needed before pasting into a file.
 */
export function exportRules(ctx: ToolPermissionContext): string {
  const payload: {
    permissions: {
      allow: string[];
      deny: string[];
      ask: string[];
      additionalDirectories: string[];
      defaultMode: PermissionMode;
    };
  } = {
    permissions: {
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: ctx.mode,
    },
  };
  for (const behavior of PERMISSION_BEHAVIORS) {
    const flat = new Set<string>();
    for (const r of collectRulesForBehavior(ctx, behavior)) {
      flat.add(r.value);
    }
    payload.permissions[behavior] = Array.from(flat).sort();
  }
  for (const entry of ctx.additionalWorkingDirectories.values()) {
    payload.permissions.additionalDirectories.push(entry.path);
  }
  payload.permissions.additionalDirectories.sort();
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Argument parsing: "<behavior> <rule-string> [--persist <dest>]"
// ---------------------------------------------------------------------------

export type EditableDestination = "userSettings" | "projectSettings" | "localSettings";

export interface ParsedRuleArgs {
  readonly behavior: PermissionBehavior;
  readonly ruleValue: PermissionRuleValue;
  readonly persistTo?: EditableDestination;
}

const BEHAVIOR_TOKENS: Readonly<Record<string, PermissionBehavior>> =
  Object.freeze({
    allow: "allow",
    deny: "deny",
    ask: "ask",
  });

const PERSIST_TARGETS: Readonly<Record<string, EditableDestination>> =
  Object.freeze({
    user: "userSettings",
    project: "projectSettings",
    local: "localSettings",
  });

function splitArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the argument tail of `/permissions add` / `/permissions remove`.
 * Returns an error string or a structured ParsedRuleArgs.
 */
export function parseRuleArgs(
  argsRaw: string,
): { ok: true; value: ParsedRuleArgs } | { ok: false; error: string } {
  const tokens = splitArgs(argsRaw);
  if (tokens.length < 2) {
    return {
      ok: false,
      error: "Usage: <allow|deny|ask> <rule> [--persist <user|project|local>]",
    };
  }
  const behaviorTok = tokens[0]!.toLowerCase();
  const behavior = BEHAVIOR_TOKENS[behaviorTok];
  if (!behavior) {
    return {
      ok: false,
      error: `Unknown behavior: "${behaviorTok}". Expected allow|deny|ask.`,
    };
  }

  // Extract --persist if present. Accept both "--persist user" and
  // "--persist=user".
  let persistTo: EditableDestination | undefined;
  const ruleTokens: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--persist") {
      const nxt = tokens[i + 1];
      if (!nxt) {
        return {
          ok: false,
          error: "--persist requires a value (user|project|local)",
        };
      }
      const target = PERSIST_TARGETS[nxt.toLowerCase()];
      if (!target) {
        return {
          ok: false,
          error: `Unknown --persist target "${nxt}". Expected user|project|local.`,
        };
      }
      persistTo = target;
      i++;
      continue;
    }
    if (t.startsWith("--persist=")) {
      const value = t.slice("--persist=".length).toLowerCase();
      const target = PERSIST_TARGETS[value];
      if (!target) {
        return {
          ok: false,
          error: `Unknown --persist target "${value}". Expected user|project|local.`,
        };
      }
      persistTo = target;
      continue;
    }
    ruleTokens.push(t);
  }

  if (ruleTokens.length === 0) {
    return { ok: false, error: "Missing rule string after behavior" };
  }
  const ruleString = ruleTokens.join(" ");
  const parsed = parseRuleString(ruleString);
  if (!parsed) {
    return { ok: false, error: `Invalid rule string: "${ruleString}"` };
  }
  // Reject obvious unbalanced-paren inputs — parseRuleString is
  // lenient and treats "Bash(" as a tool-level rule named "Bash(",
  // which is almost never what the user wants. Catch that shape
  // explicitly so the command reports a parse error.
  if (
    (ruleString.includes("(") || ruleString.includes("[")) &&
    parsed.ruleContent === undefined &&
    parsed.toolName === ruleString
  ) {
    return { ok: false, error: `Invalid rule string: "${ruleString}"` };
  }

  return {
    ok: true,
    value: { behavior, ruleValue: parsed, persistTo },
  };
}

// ---------------------------------------------------------------------------
// add / remove
// ---------------------------------------------------------------------------

async function addRuleFromCommand(
  currentCtx: ToolPermissionContext,
  argsRaw: string,
  registry: PermissionModeRegistry,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const parsed = parseRuleArgs(argsRaw);
  if (!parsed.ok) return { kind: "error", message: parsed.error };
  const { behavior, ruleValue, persistTo } = parsed.value;

  // 1) Session (always, so the rule is visible immediately).
  const nextCtx = applyPermissionUpdate(currentCtx, {
    type: "addRules",
    destination: "session",
    rules: [ruleValue],
    behavior,
  });
  await registry.update(nextCtx);

  // 2) Optional persist to disk.
  let persistNote = "";
  if (persistTo) {
    if (behavior === "allow" && persistTo !== "userSettings") {
      persistNote =
        " (session only — repository files cannot store permission approvals)";
    } else {
      const wrote = await addPermissionRulesToSettings({
        destination: persistTo,
        behavior,
        rules: [ruleValue],
        env: diskEnvForCtx(ctx),
      });
      persistNote = wrote
        ? ` (persisted to ${persistTo})`
        : ` (persist skipped — managed settings or no writable target)`;
    }
  }

  const display = serializeRuleValue(ruleValue);
  return {
    kind: "text",
    text: `Added ${behavior.toUpperCase()} ${display}${persistNote}`,
  };
}

async function removeRuleFromCommand(
  currentCtx: ToolPermissionContext,
  argsRaw: string,
  registry: PermissionModeRegistry,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const parsed = parseRuleArgs(argsRaw);
  if (!parsed.ok) return { kind: "error", message: parsed.error };
  const { behavior, ruleValue, persistTo } = parsed.value;

  // Session remove.
  const nextCtx = applyPermissionUpdate(currentCtx, {
    type: "removeRules",
    destination: "session",
    rules: [ruleValue],
    behavior,
  });
  await registry.update(nextCtx);

  let persistNote = "";
  if (persistTo) {
    const rule: PermissionRule = {
      source: persistTo as PermissionRuleSource,
      ruleBehavior: behavior,
      ruleValue,
    };
    const removed = await deletePermissionRule({
      destination: persistTo,
      rule,
      env: diskEnvForCtx(ctx),
    });
    persistNote = removed
      ? ` (deleted from ${persistTo})`
      : ` (not found in ${persistTo})`;
  }

  const display = serializeRuleValue(ruleValue);
  return {
    kind: "text",
    text: `Removed ${behavior.toUpperCase()} ${display}${persistNote}`,
  };
}

// ---------------------------------------------------------------------------
// mode subcommand
// ---------------------------------------------------------------------------

async function handleModeSubcommand(
  modeArg: string,
  registry: PermissionModeRegistry,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const current = registry.current();
  const trimmed = modeArg.trim();
  if (trimmed === "") {
    const addressable = USER_ADDRESSABLE_PERMISSION_MODES.join(", ");
    return {
      kind: "text",
      text: `Current mode: ${current.mode}\nAvailable: ${addressable}`,
    };
  }
  if (!isPermissionMode(trimmed)) {
    return {
      kind: "error",
      message: `Unknown permission mode: "${trimmed}". Expected one of: ${USER_ADDRESSABLE_PERMISSION_MODES.join(", ")}`,
    };
  }
  const target = trimmed as PermissionMode;
  if (!(USER_ADDRESSABLE_PERMISSION_MODES as readonly PermissionMode[]).includes(target)) {
    return {
      kind: "error",
      message: `Permission mode "${trimmed}" is internal-only and cannot be set by /permissions mode.`,
    };
  }
  if (target === current.mode) {
    return { kind: "text", text: `Mode already: ${current.mode}` };
  }

  // Daemon-backed TUI: the local `registry` is a client-side shim the
  // daemon never reads. Route the mode change to the daemon's REAL
  // registry (the one the tool evaluator enforces) via the
  // session.setPermissionMode RPC. Bypass-consent gating is handled
  // here; the daemon does an unconditional transition.
  const daemonSetMode = daemonPermissionModeFn(ctx);
  if (daemonSetMode !== null && target !== "bypassPermissions") {
    try {
      const result = await daemonSetMode(target);
      // Keep the client-local registry in sync so subsequent /permissions
      // reads (which still read the local registry) reflect the change.
      await registry.update({ ...current, mode: target });
      return {
        kind: "text",
        text: result.applied
          ? `Mode: ${result.previousMode} → ${result.mode}`
          : `Mode already: ${result.mode}`,
      };
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // bypassPermissions on a daemon-backed TUI: the consent gate is the
  // client's responsibility, but daemon enforcement must actually switch.
  // Run the consent gate locally FIRST (preserving BypassConsentRequiredError);
  // ONLY after it passes, forward to the daemon's real registry via
  // session.setPermissionMode so daemon-side enforcement flips to bypass.
  if (daemonSetMode !== null && target === "bypassPermissions") {
    const gated = transitionPermissionMode(current.mode, target, current, {
      requireBypassConsent: true,
      workspacePath: ctx.cwd,
    });
    if ("error" in gated) {
      if (gated.error === "bypass_consent_required") {
        return {
          kind: "error",
          message:
            "Switching to bypassPermissions requires explicit consent. " +
            "Run /permissions accept-bypass to confirm this workspace will use bypassPermissions mode.",
        };
      }
      return {
        kind: "error",
        message: `Transition refused: ${(gated as { error: string }).error}`,
      };
    }
    // Consent passed — switch the daemon's real registry.
    try {
      const result = await daemonSetMode(target);
      // Keep the local shim in sync (carry consent + any context changes
      // from the gated transition), so subsequent /permissions reads match.
      await registry.update({ ...gated, mode: target });
      return {
        kind: "text",
        text: result.applied
          ? `Mode: ${result.previousMode} → ${result.mode}`
          : `Mode already: ${result.mode}`,
      };
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let transitioned: ReturnType<typeof transitionPermissionMode>;
  try {
    transitioned = transitionPermissionMode(current.mode, target, current, {
      requireBypassConsent: target === "bypassPermissions",
      workspacePath: ctx.cwd,
    });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if ("error" in transitioned) {
    if (transitioned.error === "bypass_consent_required") {
      return {
        kind: "error",
        message:
          "Switching to bypassPermissions requires explicit consent. " +
          "Run /permissions accept-bypass to confirm this workspace will use bypassPermissions mode.",
      };
    }
    // Forward-compat: future error variants surface as a plain error.
    return {
      kind: "error",
      message: `Transition refused: ${(transitioned as { error: string }).error}`,
    };
  }
  let nextCtx: ToolPermissionContext = { ...transitioned, mode: target };
  await registry.update(nextCtx);

  // I-8: surface mode change through the event bus so sidecars see it.
  try {
    ctx.session.emit({
      id: ctx.session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "mode_changed",
          message: `permission mode ${current.mode} → ${target}`,
        },
      },
    } as unknown as Parameters<Session["emit"]>[0]);
  } catch {
    // Do not fail the command if emit throws — the mode swap already
    // landed on the registry.
  }

  return {
    kind: "text",
    text: `Mode: ${current.mode} → ${target}`,
  };
}

// ---------------------------------------------------------------------------
// accept-bypass subcommand
// ---------------------------------------------------------------------------

/**
 * Record explicit operator consent for the current workspace to use
 * `bypassPermissions` mode. Updates:
 *   - The session-scoped `ctx.bypassPermissionsAcceptedIn` list (so the
 *     subsequent `/permissions mode bypassPermissions` invocation in this
 *     session passes the consent gate).
 *   - The persisted user settings file, so future sessions opened against
 *     the same workspace directory also skip the consent prompt.
 *
 * Persistence is best-effort: if the settings file cannot be written
 * (e.g. managed-permissions-only policy), the session-level list is still
 * updated and the command reports the partial outcome.
 */
async function handleAcceptBypassSubcommand(
  registry: PermissionModeRegistry,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const workspacePath = ctx.cwd;
  const current = registry.current();
  const existing = current.bypassPermissionsAcceptedIn ?? [];
  const alreadyInSession = existing.includes(workspacePath);

  // Session-level update (always — the command is idempotent).
  if (!alreadyInSession) {
    const nextCtx: ToolPermissionContext = {
      ...current,
      bypassPermissionsAcceptedIn: [...existing, workspacePath],
    };
    await registry.update(nextCtx);
  }

  // Persisted-config update. Best-effort: if persistence fails, we still
  // report success for the session-level update so the operator can
  // proceed with the bypass activation in this session.
  let persistNote = "";
  try {
    const wrote = await recordBypassPermissionsAcceptance({
      workspacePath,
      env: diskEnvForCtx(ctx),
    });
    persistNote = wrote
      ? " (persisted to user settings)"
      : " (persist skipped — settings file not writable)";
  } catch (err) {
    persistNote = ` (persist failed: ${err instanceof Error ? err.message : String(err)})`;
  }

  const sessionNote = alreadyInSession
    ? "already accepted in this session"
    : "accepted for this session";
  return {
    kind: "text",
    text: `bypassPermissions ${sessionNote} for ${workspacePath}${persistNote}`,
  };
}

function menuActionResult(
  result: SlashCommandResult,
  nextMode?: PermissionMode,
): { readonly ok: boolean; readonly message: string; readonly nextMode?: PermissionMode } {
  switch (result.kind) {
    case "text":
      return {
        ok: true,
        message: result.text,
        ...(nextMode !== undefined ? { nextMode } : {}),
      };
    case "error":
      return { ok: false, message: result.message };
    case "skip":
      return { ok: true, message: "Action applied." };
    case "compact":
      return { ok: true, message: result.text };
    case "exit":
      return { ok: true, message: `Exit requested with code ${result.code}.` };
    case "prompt":
      return { ok: false, message: result.content };
  }
}

function permissionsMenuController(
  registry: PermissionModeRegistry,
  ctx: SlashCommandContext,
): PermissionsMenuController {
  return {
    setMode: async (mode: PermissionMode) =>
      menuActionResult(
        await handleModeSubcommand(mode, registry, ctx),
        registry.current().mode,
      ),
    acceptBypass: async () =>
      menuActionResult(await handleAcceptBypassSubcommand(registry, ctx)),
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const permissionsCommand: SlashCommand = {
  name: "permissions",
  aliases: ["approvals", "allowed-tools"],
  description: "Manage permission mode and rules",
  immediate: true,
  userInvocable: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const registry = findPermissionRegistry(ctx.session);
      if (!registry) {
        return {
          kind: "error",
          message:
            "Permission registry not initialised (session.services.permissionModeRegistry missing)",
        };
      }
      const raw = ctx.argsRaw.trim();
      if (raw === "") {
        if (openPermissionsMenu(ctx, registry.current(), permissionsMenuController(registry, ctx))) {
          return { kind: "skip" };
        }
        return { kind: "text", text: formatRuleList(registry.current()) };
      }
      const tokens = splitArgs(raw);
      const sub = tokens[0]!.toLowerCase();
      const rest = raw.slice(tokens[0]!.length).trim();

      switch (sub) {
        case "list":
          if (openPermissionsMenu(ctx, registry.current(), permissionsMenuController(registry, ctx))) {
            return { kind: "skip" };
          }
          return { kind: "text", text: formatRuleList(registry.current()) };
        case "add":
          return addRuleFromCommand(registry.current(), rest, registry, ctx);
        case "remove":
        case "rm":
          return removeRuleFromCommand(
            registry.current(),
            rest,
            registry,
            ctx,
          );
        case "export":
          return { kind: "text", text: exportRules(registry.current()) };
        case "mode":
          return handleModeSubcommand(rest, registry, ctx);
        case "accept-bypass":
          return handleAcceptBypassSubcommand(registry, ctx);
        default:
          return {
            kind: "error",
            message: `Unknown subcommand: "${sub}". Try: list, add, remove, export, mode, accept-bypass`,
          };
      }
    }),
};
