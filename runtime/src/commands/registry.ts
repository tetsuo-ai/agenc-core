/**
 * Command registry.
 *
 * Holds the set of `SlashCommand` entries the dispatcher can route to.
 * Ports the minimum agenc `hasCommand` / `getCommand` / `findCommand`
 * lookup behavior (`src/commands.js`) without pulling in plugin marketplace,
 * skill loading, MCP wiring, or hook registration.
 *
 * Collision policy (documented in JSDoc on each method):
 *
 *   - register() throws if the incoming `cmd.name` collides with any
 *     already-registered command name.
 *   - register() throws if any of `cmd.aliases` collide with an existing
 *     command NAME (aliases must not shadow a real command).
 *   - register() warns (console.warn) and drops the alias if it collides
 *     with another registered command's ALIAS — first-registered wins.
 *
 * Lookup is case-insensitive (defensive — the parser already lowercases
 * names, but the registry must behave correctly if a caller hands it an
 * upper-case string by accident).
 *
 * @module
 */

import { feature } from "bun:bundle";
import type {
  CommandRegistry as CommandRegistryInterface,
  SlashCommand,
} from "./types.js";
import type { Command, LocalCommandResult } from "../commands.js";
import { buildLegacyOnDone } from "./legacy-on-done.js";
import helpCommand from "./help.js";
import statusCommand from "./status.js";
import initCommand from "./init.js";
import diffCommand from "./diff.js";
import exitCommand from "./exit.js";
import clearCommand from "./clear.js";
import keybindingsCommand from "./keybindings.js";
import resumeCommand from "./resume.js";
import forkCommand from "./fork.js";
import planCommand from "./plan.js";
import permissionsCommand from "./permissions.js";
import configCommand from "./config.js";
import hooksCommand from "./hooks.js";
import modelCommand from "./model.js";
import providerCommand from "./provider.js";
import copyCommand from "./copy.js";
import mcpCommand from "./mcp.js";
import skillsCommand from "./skills.js";
import memoryCommand from "./memory/slash.js";
import cacheStatsCommand from "./cache-stats.js";
import costCommand from "./cost.js";
import doctorCommand from "./doctor/doctor.js";
import effortCommand from "./effort.js";
import filesCommand from "./files.js";
import releaseNotesCommand from "./release-notes.js";
import reloadPluginsCommand from "./reload-plugins.js";
import statsCommand from "./stats.js";
import usageCommand from "./usage.js";
import wikiCommand from "./wiki.js";
import { enterWorktree } from "./enter-worktree.js";
import { exitWorktree } from "./exit-worktree.js";
import {
  compactCommand,
  contextCommand,
} from "./session-compact.js";

/**
 * Concrete in-memory implementation of `CommandRegistry`. The registry
 * is immutable after construction from the dispatcher's point of view;
 * callers can still `register` new commands in setup code, but the
 * dispatcher treats the registry as read-only during a turn.
 */
export class CommandRegistry implements CommandRegistryInterface {
  private byName = new Map<string, SlashCommand>();
  private byAlias = new Map<string, SlashCommand>();
  private readonly dynamicRegistrations = new Map<
    string,
    readonly DynamicRegistration[]
  >();

  /**
   * Add a command to the registry.
   *
   * @throws Error — if `cmd.name` collides with an existing name or with
   *   an existing alias, or if any alias collides with an existing name.
   *   Alias-to-alias collisions do NOT throw; they emit a warning and
   *   the first registration wins.
   */
  register(cmd: SlashCommand): void {
    CommandRegistry.registerInto(this.byName, this.byAlias, cmd);
  }

  /**
   * Replace a named dynamic command surface in place.
   *
   * `/reload-plugins` uses this to make freshly loaded plugin commands
   * executable through the same registry object the dispatcher has already
   * cached. Replacement is atomic: if any new command collides, the previous
   * dynamic surface stays intact.
   */
  replaceDynamicCommands(
    source: string,
    commands: readonly SlashCommand[],
  ): void {
    const nextByName = new Map(this.byName);
    const nextByAlias = new Map(this.byAlias);
    for (const registration of this.dynamicRegistrations.get(source) ?? []) {
      nextByName.delete(registration.nameKey);
      for (const aliasKey of registration.aliasKeys) {
        nextByAlias.delete(aliasKey);
      }
    }

    const nextRegistrations = commands.map(command =>
      CommandRegistry.registerInto(nextByName, nextByAlias, command),
    );
    this.byName = nextByName;
    this.byAlias = nextByAlias;
    if (nextRegistrations.length === 0) {
      this.dynamicRegistrations.delete(source);
    } else {
      this.dynamicRegistrations.set(source, nextRegistrations);
    }
  }

  /**
   * Find a command by its canonical name or any registered alias.
   * Lookup is case-insensitive.
   */
  find(nameOrAlias: string): SlashCommand | undefined {
    const key = nameOrAlias.toLowerCase();
    return this.byName.get(key) ?? this.byAlias.get(key);
  }

  /** True iff a command with this name/alias is registered. */
  has(nameOrAlias: string): boolean {
    const key = nameOrAlias.toLowerCase();
    return this.byName.has(key) || this.byAlias.has(key);
  }

  /**
   * Return every registered command in registration order.
   *
   * This is presentation order for `/help` and the slash palette, so it
   * must stay aligned with the curated command order in
   * `buildDefaultRegistry()` rather than being alpha-sorted.
   */
  list(): readonly SlashCommand[] {
    return [...this.byName.values()];
  }

  /** Convenience constructor — register every command in order. */
  static fromCommands(cmds: readonly SlashCommand[]): CommandRegistry {
    const reg = new CommandRegistry();
    for (const c of cmds) {
      reg.register(c);
    }
    return reg;
  }

  private static registerInto(
    byName: Map<string, SlashCommand>,
    byAlias: Map<string, SlashCommand>,
    cmd: SlashCommand,
  ): DynamicRegistration {
    const nameKey = cmd.name.toLowerCase();
    if (byName.has(nameKey)) {
      throw new Error(
        `CommandRegistry: duplicate command name "${cmd.name}"`,
      );
    }
    if (byAlias.has(nameKey)) {
      throw new Error(
        `CommandRegistry: command name "${cmd.name}" collides with existing alias`,
      );
    }
    const aliasKeys: string[] = [];
    for (const alias of cmd.aliases ?? []) {
      const aKey = alias.toLowerCase();
      if (byName.has(aKey)) {
        throw new Error(
          `CommandRegistry: alias "${alias}" (of /${cmd.name}) collides with existing command name`,
        );
      }
      if (byAlias.has(aKey)) {
        // First-registered wins — document and skip.
        console.warn(
          `CommandRegistry: alias "${alias}" (of /${cmd.name}) already registered by another command; dropping`,
        );
        continue;
      }
      aliasKeys.push(aKey);
    }
    byName.set(nameKey, cmd);
    for (const aKey of aliasKeys) {
      byAlias.set(aKey, cmd);
    }
    return { nameKey, aliasKeys };
  }
}

interface DynamicRegistration {
  readonly nameKey: string;
  readonly aliasKeys: readonly string[];
}

/**
 * Adapter for `/enter-worktree <slug>`.
 *
 * Calls `enterWorktree({ session, slug })`, binds the resulting handle
 * into `session.pendingWorktreeState`, and updates the session cwd to
 * the worktree path via `setPendingWorktreeState`.
 */
const enterWorktreeCommand: SlashCommand = {
  name: "enter-worktree",
  description: "Enter (or resume) an isolated git worktree for agent work",
  execute: async (ctx) => {
    const slug = ctx.argsRaw.split(/\s+/)[0] ?? "";
    if (!slug) {
      return {
        kind: "error",
        message: "Usage: /enter-worktree <slug>",
      };
    }
    try {
      const outcome = await enterWorktree({
        session: ctx.session,
        slug,
      });
      if (outcome.kind === "rejected") {
        return { kind: "error", message: outcome.reason };
      }
      // outcome.kind === "entered"
      ctx.session.setPendingWorktreeState({
        handle: outcome.handle,
        baseCommit: outcome.baseCommit,
        originalCwd: ctx.cwd,
      });
      return {
        kind: "text",
        text: `Entered worktree '${slug}' at ${outcome.handle.path}${outcome.handle.created ? " (new)" : " (resumed)"}.`,
      };
    } catch (err) {
      return { kind: "error", message: String(err) };
    }
  },
};

/**
 * Adapter for `/exit-worktree [remove [--discard]]`.
 *
 * Reads the active worktree handle from `session.pendingWorktreeState`,
 * calls `exitWorktree`, and clears the pending state on success.
 *
 * Argument parsing:
 *   (no args)            → action="keep"
 *   "remove"             → action="remove", discardChanges=false
 *   "remove --discard"   → action="remove", discardChanges=true
 */
const exitWorktreeCommand: SlashCommand = {
  name: "exit-worktree",
  description: "Exit (keep or remove) the active agent worktree",
  execute: async (ctx) => {
    const state = ctx.session.pendingWorktreeState;
    if (!state) {
      return {
        kind: "error",
        message: "No active worktree. Use /enter-worktree <slug> first.",
      };
    }
    const args = ctx.argsRaw
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    let action: "keep" | "remove";
    let discardChanges: boolean;
    if (args.length === 0 || (args.length === 1 && args[0] === "keep")) {
      action = "keep";
      discardChanges = false;
    } else if (
      args[0] === "remove" &&
      (args.length === 1 || (args.length === 2 && args[1] === "--discard"))
    ) {
      action = "remove";
      discardChanges = args[1] === "--discard";
    } else {
      return {
        kind: "error",
        message: "Usage: /exit-worktree [keep|remove [--discard]]",
      };
    }
    try {
      const outcome = await exitWorktree({
        session: ctx.session,
        handle: state.handle,
        baseCommit: state.baseCommit,
        action,
        discardChanges,
      });
      if (outcome.kind === "refused") {
        return { kind: "error", message: outcome.reason };
      }
      // outcome.kind === "kept" | "removed"
      ctx.session.setPendingWorktreeState(null);
      return { kind: "text", text: outcome.message };
    } catch (err) {
      return { kind: "error", message: String(err) };
    }
  },
};

type DynamicValue<T> = T | (() => T);

export type LegacyCommandSurfaceSpec = {
  readonly name: string;
  readonly description: DynamicValue<string>;
  readonly type: "local" | "local-jsx" | "prompt";
  readonly modulePath: string;
  readonly tuiModulePath: string;
  readonly exportName?: string;
  readonly nonInteractiveExportName?: string;
  readonly factory?: boolean;
  readonly aliases?: readonly string[];
  readonly immediate?: DynamicValue<boolean>;
  readonly supportsNonInteractive?: boolean;
  readonly isHidden?: DynamicValue<boolean>;
  readonly isEnabled?: () => boolean;
  readonly userInvocable?: boolean;
  readonly argumentHint?: string;
  readonly availability?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly contentLength?: number;
  readonly progressMessage?: string;
  readonly source?: string;
  readonly dispatchPrompt?: boolean;
  readonly register?: boolean;
};

function readDynamic<T>(value: DynamicValue<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function defineDynamicProperty<T extends object, K extends PropertyKey, V>(
  target: T,
  key: K,
  value: DynamicValue<V> | undefined,
): void {
  if (value === undefined) return;
  if (typeof value === "function") {
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: value as () => V,
    });
  } else {
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      value,
    });
  }
}

function memoizedModule<T>(load: () => T): () => T {
  let loaded: T | undefined;
  return () => {
    loaded ??= load();
    return loaded;
  };
}

function isModuleNotFound(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    (
      (error as { readonly code?: unknown }).code === "MODULE_NOT_FOUND" ||
      (error as { readonly code?: unknown }).code === "ERR_MODULE_NOT_FOUND" ||
      (error as { readonly code?: unknown }).code === "ERR_UNSUPPORTED_ESM_URL_SCHEME"
    );
}

function canUsePredicateFallback(error: unknown): boolean {
  return isModuleNotFound(error) &&
    (process.env.NODE_ENV === "test" || process.env.VITEST === "true");
}

function readOptional<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    if (!canUsePredicateFallback(error)) throw error;
    return fallback;
  }
}

const loadBootstrapState = memoizedModule(
  () => require("../bootstrap/state.js") as typeof import("../bootstrap/state.js"),
);
const loadBridgeEnabled = memoizedModule(
  () => require("../bridge/bridgeEnabled.js") as typeof import("../bridge/bridgeEnabled.js"),
);
const loadMemoryPaths = memoizedModule(
  () => require("../memory/paths.js") as typeof import("../memory/paths.js"),
);
const loadGrowthbook = memoizedModule(
  () => require("../services/analytics/growthbook.js") as typeof import("../services/analytics/growthbook.js"),
);
const loadPolicyLimits = memoizedModule(
  () => require("../services/policyLimits/index.js") as typeof import("../services/policyLimits/index.js"),
);
const loadAuth = memoizedModule(
  () => require("../utils/auth.js") as typeof import("../utils/auth.js"),
);
const loadEnv = memoizedModule(
  () => require("../utils/env.js") as typeof import("../utils/env.js"),
);
const loadFastMode = memoizedModule(
  () => require("../utils/fastMode.js") as typeof import("../utils/fastMode.js"),
);
const loadImmediateCommand = memoizedModule(
  () => require("../utils/immediateCommand.js") as typeof import("../utils/immediateCommand.js"),
);
const loadPrivacyLevel = memoizedModule(
  () => require("../utils/privacyLevel.js") as typeof import("../utils/privacyLevel.js"),
);
const loadVoiceModeEnabled = memoizedModule(
  () => require("../tui/voice/voiceModeEnabled.js") as typeof import("../tui/voice/voiceModeEnabled.js"),
);
const loadUltrareviewEnabled = memoizedModule(
  () => require("./review/ultrareviewEnabled.js") as typeof import("./review/ultrareviewEnabled.js"),
);

function getIsNonInteractiveSession(): boolean {
  return readOptional(() => loadBootstrapState().getIsNonInteractiveSession(), false);
}

function getIsRemoteMode(): boolean {
  return readOptional(() => loadBootstrapState().getIsRemoteMode(), false);
}

function isBridgeEnabled(): boolean {
  return readOptional(() => loadBridgeEnabled().isBridgeEnabled(), false);
}

function isAutoMemoryEnabled(): boolean {
  return readOptional(() => loadMemoryPaths().isAutoMemoryEnabled(), false);
}

function getFeatureValue_CACHED_MAY_BE_STALE<T>(name: string, fallback: T): T {
  return readOptional(
    () => loadGrowthbook().getFeatureValue_CACHED_MAY_BE_STALE(name, fallback),
    fallback,
  );
}

function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(name: string): boolean {
  return readOptional(
    () => loadGrowthbook().checkStatsigFeatureGate_CACHED_MAY_BE_STALE(name),
    false,
  );
}

function isPolicyAllowed(policy: Parameters<
  typeof import("../services/policyLimits/index.js").isPolicyAllowed
>[0]): boolean {
  return readOptional(() => loadPolicyLimits().isPolicyAllowed(policy), false);
}

function getSubscriptionType(): ReturnType<
  typeof import("../utils/auth.js").getSubscriptionType
> {
  return readOptional(() => loadAuth().getSubscriptionType(), null);
}

function hasProviderApiKeyAuth(): boolean {
  return readOptional(() => loadAuth().hasAnthropicApiKeyAuth(), false);
}

function isAgenCAISubscriber(): boolean {
  return readOptional(() => loadAuth().isAgenCAISubscriber(), false);
}

function isConsumerSubscriber(): boolean {
  return readOptional(() => loadAuth().isConsumerSubscriber(), false);
}

function isOverageProvisioningAllowed(): boolean {
  return readOptional(() => loadAuth().isOverageProvisioningAllowed(), false);
}

function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false;
  if (typeof envVar === "boolean") return envVar;
  return ["1", "true", "yes", "on"].includes(envVar.toLowerCase().trim());
}

function fastModeModelDisplay(): string {
  return readOptional(() => loadFastMode().FAST_MODE_MODEL_DISPLAY, "Opus 4.6");
}

function isFastModeEnabled(): boolean {
  return readOptional(() => loadFastMode().isFastModeEnabled(), false);
}

function shouldInferenceConfigCommandBeImmediate(): boolean {
  return readOptional(
    () => loadImmediateCommand().shouldInferenceConfigCommandBeImmediate(),
    process.env.USER_TYPE === "ant",
  );
}

function isEssentialTrafficOnly(): boolean {
  return readOptional(() => loadPrivacyLevel().isEssentialTrafficOnly(), false);
}

function isVoiceGrowthBookEnabled(): boolean {
  return readOptional(() => loadVoiceModeEnabled().isVoiceGrowthBookEnabled(), false);
}

function isVoiceModeEnabled(): boolean {
  return readOptional(() => loadVoiceModeEnabled().isVoiceModeEnabled(), false);
}

function isUltrareviewEnabled(): boolean {
  return readOptional(() => loadUltrareviewEnabled().isUltrareviewEnabled(), false);
}

function isDesktopSupportedPlatform(): boolean {
  return process.platform === "darwin" ||
    (process.platform === "win32" && process.arch === "x64");
}

function isBridgeCommandEnabled(): boolean {
  if (feature("BRIDGE_MODE")) {
    return isBridgeEnabled();
  }
  return false;
}

function isExtraUsageAllowed(): boolean {
  if (isEnvTruthy(process.env.DISABLE_EXTRA_USAGE_COMMAND)) {
    return false;
  }
  return isOverageProvisioningAllowed();
}

function sandboxDescription(): string {
  return "Configure sandbox settings";
}

const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: "Ghostty",
  kitty: "Kitty",
  "iTerm.app": "iTerm2",
  WezTerm: "WezTerm",
};

const BUILD_USER_TYPE = "external" as string;

function terminalSetupDescription(): string {
  return readOptional(() => loadEnv().env.terminal, null) === "Apple_Terminal"
    ? "Enable Option+Enter key binding for newlines and visual bell"
    : "Install Shift+Enter key binding for newlines";
}

function terminalSetupHidden(): boolean {
  const terminal = readOptional(() => loadEnv().env.terminal, null);
  return terminal !== null && terminal in NATIVE_CSIU_TERMINALS;
}

function legacyCommandSurface(params: LegacyCommandSurfaceSpec): SlashCommand {
  const command: SlashCommand & { readonly isHidden?: boolean } = {
    name: params.name,
    get description() {
      return readDynamic(params.description);
    },
    ...(params.aliases !== undefined ? { aliases: params.aliases } : {}),
    ...(params.supportsNonInteractive !== undefined
      ? { supportsNonInteractive: params.supportsNonInteractive }
      : {}),
    ...(params.isEnabled !== undefined ? { isEnabled: params.isEnabled } : {}),
    ...(params.userInvocable === false ? { userInvocable: false } : {}),
    execute: async (ctx) => executeLegacyCommandSurface(params, ctx.argsRaw, ctx as never),
  };
  defineDynamicProperty(command, "immediate", params.immediate);
  defineDynamicProperty(command, "isHidden", params.isHidden);
  return command;
}

type LegacyCommandModule = {
  readonly default?: unknown;
  readonly [key: string]: unknown;
};

/**
 * Literal-specifier import map for legacy command surfaces. tsup's static
 * analyzer can ONLY discover `import("./literal/path.js")` calls — a
 * dynamic `import(params.modulePath)` (which is what this code USED to
 * do) silently drops every dependent module from the bundle, leading to
 * runtime "Cannot find module" failures the moment the user dispatches
 * any of these legacy slash commands.
 *
 * Adding a new legacy command requires adding it to BOTH:
 *   1. registeredLegacyCommandSurfaceSpecs (presentation metadata)
 *   2. this map (the actual import that the bundler discovers)
 *
 * Removing a command requires removing both halves; gate 3.6
 * (scanner-evasion + dynamic-upstream-import guard) catches any
 * regression that re-introduces `import(<variable>)` here.
 */
const LEGACY_COMMAND_LOADERS: Record<string, () => Promise<LegacyCommandModule>> = {
  "./agents/index.js": () => import("./agents/index.js"),
  "./branch/index.js": () => import("./branch/index.js"),
  "./bridge/index.js": () => import("./bridge/index.js"),
  "./btw/index.js": () => import("./btw/index.js"),
  "./buddy/index.js": () => import("./buddy/index.js"),
  "./color/index.js": () => import("./color/index.js"),
  "./export/index.js": () => import("./export/index.js"),
  "./heapdump/index.js": () => import("./heapdump/index.js"),
  "./ide/index.js": () => import("./ide/index.js"),
  "./knowledge/index.js": () => import("./knowledge/index.js"),
  "./login/index.js": () => import("./login/index.js"),
  "./logout/index.js": () => import("./logout/index.js"),
  "./memory/index.js": () => import("./memory/index.js"),
  "./pr_comments/index.js": () => import("./pr_comments/index.js"),
  "./rename/index.js": () => import("./rename/index.js"),
  "./rewind/index.js": () => import("./rewind/index.js"),
  "./sandbox-toggle/index.js": () => import("./sandbox-toggle/index.js"),
  "./tasks/index.js": () => import("./tasks/index.js"),
  "./terminalSetup/index.js": () => import("./terminalSetup/index.js"),
  "./theme/index.js": () => import("./theme/index.js"),
  "./vim/index.js": () => import("./vim/index.js"),
  "./install.js": () => import("./install.js"),
  "./commit.js": () => import("./commit.js"),
  "./review.js": () => import("./review.js"),
  "./cache-probe/index.js": () => import("./cache-probe/index.js"),
  "./install-slack-app/index.js": () => import("./install-slack-app/index.js"),
  "./onboard-github/index.js": () => import("./onboard-github/index.js"),
  "./plugin/index.js": () => import("./plugin/index.js"),
  "./init-verifiers.js": () => import("./init-verifiers.js"),
  "./commit-push-pr.js": () => import("./commit-push-pr.js"),
  "./install-github-app/index.js": () => import("./install-github-app/index.js"),
  "./brief.js": () => import("./brief.js"),
  "./bridge-kick.js": () => import("./bridge-kick.js"),
};

async function loadLegacyCommandSurface(
  params: LegacyCommandSurfaceSpec,
  exportName: string | undefined = params.exportName,
): Promise<Command> {
  const loader = LEGACY_COMMAND_LOADERS[params.modulePath];
  if (loader === undefined) {
    throw new Error(
      `/${params.name} modulePath ${params.modulePath} is not registered in LEGACY_COMMAND_LOADERS — add it to the literal-import map in registry.ts`,
    );
  }
  const loaded = await loader();
  const exported = exportName === undefined
    ? loaded.default
    : loaded[exportName];
  const descriptor = params.factory && typeof exported === "function"
    ? exported()
    : exported;
  if (descriptor === undefined || descriptor === null) {
    throw new Error(`/${params.name} did not export a command descriptor`);
  }
  return descriptor as Command;
}

function localResultToSlashResult(result: LocalCommandResult) {
  switch (result.type) {
    case "text":
      return { kind: "text" as const, text: result.value };
    case "compact":
      return {
        kind: "compact" as const,
        text: result.displayText ?? "Conversation compacted",
      };
    case "skip":
      return { kind: "skip" as const };
  }
}

function promptBlocksToText(blocks: readonly unknown[]): string {
  return blocks
    .map(block => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block) {
        const text = (block as { readonly text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return JSON.stringify(block);
    })
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n\n");
}

/**
 * Optional TUI-bound side-effect handlers that the dispatcher uses to
 * route command results to the interactive surface. When present:
 *   - local-jsx commands mount their returned JSX via mountJsx() and the
 *     dispatcher returns a synthetic { kind: "skip" } so the caller doesn't
 *     try to render an empty result.
 *   - prompt commands resolve their getPromptForCommand template and
 *     resubmit the rendered text to the model via submitPromptToModel(),
 *     also returning { kind: "skip" }.
 * When omitted (headless callers, tests, scripts), the dispatcher
 * preserves its previous behavior — local-jsx returns a clean error
 * because there's nowhere to mount the dialog, and prompt returns the
 * rendered text in a { kind: "prompt" } payload for the caller to
 * handle.
 */
export interface LegacyCommandTuiHandlers {
  mountJsx(jsx: unknown, opts?: { shouldHidePromptInput?: boolean }): void;
  unmountJsx(): void;
  submitPromptToModel(content: string): Promise<void>;
  /**
   * Surfaces the optional result string a local-jsx command passes to its
   * onDone callback (e.g. /color's "Session color set to: blue", /rename's
   * "Cannot rename: ..."). The TUI binds this to a transient message
   * append so success/error confirmations don't get silently swallowed.
   */
  notifyResult?(text: string, opts?: { display?: string }): void;
  /**
   * Per-invocation LocalJSXCommandContext / ToolUseContext composite the
   * TUI builds for the current session. Passed verbatim to the command's
   * call() function alongside the onDone callback.
   */
  toolUseContext: unknown;
}

async function executeLegacyCommandSurface(
  params: LegacyCommandSurfaceSpec,
  argsRaw: string,
  context: unknown,
  tuiHandlers?: LegacyCommandTuiHandlers,
) {
  if (params.type === "prompt" && params.dispatchPrompt !== true && tuiHandlers === undefined) {
    return {
      kind: "error" as const,
      message: `/${params.name} requires the interactive prompt command surface.`,
    };
  }
  const descriptor = await loadLegacyCommandSurface(params);
  // Only fall back to the alternate `local` export when no interactive
  // TUI handlers are available. When the TUI is driving the dispatch we
  // always want the live JSX dialog (e.g. /export's interactive picker)
  // rather than the headless plain-text alternate.
  if (
    tuiHandlers === undefined &&
    descriptor.type === "local-jsx" &&
    params.nonInteractiveExportName
  ) {
    const alternate = await loadLegacyCommandSurface(
      params,
      params.nonInteractiveExportName,
    );
    if (alternate.type === "local" && alternate.isEnabled?.() !== false) {
      const loaded = await alternate.load();
      const result = await loaded.call(argsRaw, context as never);
      return localResultToSlashResult(result);
    }
  }
  if (descriptor.isEnabled?.() === false) {
    return {
      kind: "error" as const,
      message: `/${params.name} is not available in this session.`,
    };
  }
  if (descriptor.type === "local-jsx") {
    if (tuiHandlers === undefined) {
      return {
        kind: "error" as const,
        message: `/${params.name} requires the interactive TUI command surface.`,
      };
    }
    const loaded = (await descriptor.load()) as {
      call: (
        onDone: (result?: string, opts?: unknown) => void,
        ctx: unknown,
        args: string,
      ) => Promise<unknown>;
    };
    // The onDone callback dismisses the JSX overlay. Some commands fire
    // it eagerly with a status string (e.g. "Cannot rename: ..."); others
    // hand off to a long-lived dialog and never call onDone.
    // buildLegacyOnDone encapsulates the notifyResult-vs-unmount routing —
    // see its docstring for the React-batching reasoning.
    const onDone = buildLegacyOnDone(tuiHandlers);
    const jsx = await loaded.call(onDone, tuiHandlers.toolUseContext, argsRaw);
    if (jsx !== null && jsx !== undefined) {
      tuiHandlers.mountJsx(jsx, { shouldHidePromptInput: true });
    }
    return { kind: "skip" as const };
  }
  if (descriptor.type === "local") {
    const loaded = await descriptor.load();
    const result = await loaded.call(argsRaw, context as never);
    return localResultToSlashResult(result);
  }
  if (descriptor.getPromptForCommand === undefined) {
    return {
      kind: "error" as const,
      message: `/${params.name} did not provide prompt content.`,
    };
  }
  const blocks = await descriptor.getPromptForCommand(argsRaw, context as never);
  const content = promptBlocksToText(blocks);
  if (tuiHandlers !== undefined) {
    // Submit the rendered prompt as a fresh user turn so the model
    // actually executes the command (instead of seeing the prompt
    // template displayed as inert text).
    await tuiHandlers.submitPromptToModel(content);
    return { kind: "skip" as const };
  }
  return { kind: "prompt" as const, content };
}

/**
 * TUI-aware dispatcher: runs a slash command with an interactive
 * surface so local-jsx dialogs mount and prompt templates are
 * resubmitted to the model. Falls back to the headless dispatch path
 * for any command not in the legacy-surface specs (built-in
 * SlashCommand-shape commands like /skills, /usage, /cost, /help).
 *
 * Returns the dispatch outcome so the caller can render a text/error
 * fallback for anything that didn't take effect via tuiHandlers.
 */
export async function executeLegacyCommandSurfaceForTui(
  params: LegacyCommandSurfaceSpec,
  argsRaw: string,
  context: unknown,
  tuiHandlers: LegacyCommandTuiHandlers,
) {
  return executeLegacyCommandSurface(params, argsRaw, context, tuiHandlers);
}

export const registeredLegacyCommandSurfaceSpecs = [
  { name: "agents", type: "local-jsx", modulePath: "./agents/index.js", tuiModulePath: "./commands/agents/index.js", description: "Manage agent configurations" },
  {
    name: "branch",
    type: "local-jsx",
    modulePath: "./branch/index.js",
    tuiModulePath: "./commands/branch/index.js",
    description: "Create a branch of the current conversation at this point",
    argumentHint: "[name]",
  },
  {
    name: "remote-control",
    type: "local-jsx",
    modulePath: "./bridge/index.js",
    tuiModulePath: "./commands/bridge/index.js",
    aliases: ["rc"],
    description: "Connect this terminal for remote-control sessions",
    argumentHint: "[name]",
    isEnabled: isBridgeCommandEnabled,
    isHidden: () => !isBridgeCommandEnabled(),
    immediate: true,
  },
  { name: "btw", type: "local-jsx", modulePath: "./btw/index.js", tuiModulePath: "./commands/btw/index.js", description: "Ask a quick side question without interrupting the main conversation", immediate: true, argumentHint: "<question>" },
  { name: "buddy", type: "local-jsx", modulePath: "./buddy/index.js", tuiModulePath: "./commands/buddy/index.js", description: "Hatch, pet, and manage your AgenC companion", immediate: true, argumentHint: "[status|mute|unmute|help]" },
  { name: "color", type: "local-jsx", modulePath: "./color/index.js", tuiModulePath: "./commands/color/index.js", description: "Set the prompt bar color for this session", immediate: true, argumentHint: "<color|default>" },
  { name: "export", type: "local-jsx", modulePath: "./export/index.js", tuiModulePath: "./commands/export/index.js", description: "Export the current conversation to a file or clipboard", argumentHint: "[filename]" },
  { name: "heapdump", type: "local", modulePath: "./heapdump/index.js", tuiModulePath: "./commands/heapdump/index.js", description: "Dump the JS heap to ~/Desktop", isHidden: true, supportsNonInteractive: true },
  { name: "ide", type: "local-jsx", modulePath: "./ide/index.js", tuiModulePath: "./commands/ide/index.js", description: "Manage IDE integrations and show status", argumentHint: "[open]" },
  { name: "knowledge", type: "local", modulePath: "./knowledge/index.js", tuiModulePath: "./commands/knowledge/index.js", description: "Manage native Knowledge Graph", supportsNonInteractive: true, argumentHint: "enable <yes|no> | clear | status | list" },
  { name: "login", type: "local-jsx", modulePath: "./login/index.js", tuiModulePath: "./commands/login/index.js", factory: true, description: () => hasProviderApiKeyAuth() ? "Switch provider accounts" : "Sign in with your provider account", isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND) },
  { name: "logout", type: "local-jsx", modulePath: "./logout/index.js", tuiModulePath: "./commands/logout/index.js", description: "Sign out from your provider account", isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND) },
  { name: "memory", type: "local-jsx", modulePath: "./memory/index.js", tuiModulePath: "./commands/memory/index.js", description: "Edit AgenC memory files", register: false },
  { name: "pr-comments", type: "prompt", modulePath: "./pr_comments/index.js", tuiModulePath: "./commands/pr_comments/index.js", description: "Get comments from a GitHub pull request", progressMessage: "fetching PR comments", contentLength: 0, source: "builtin", dispatchPrompt: true },
  { name: "rename", type: "local-jsx", modulePath: "./rename/index.js", tuiModulePath: "./commands/rename/index.js", description: "Rename the current conversation", immediate: true, argumentHint: "[name]" },
  { name: "rewind", type: "local", modulePath: "./rewind/index.js", tuiModulePath: "./commands/rewind/index.js", aliases: ["checkpoint"], description: "Restore the code and/or conversation to a previous point", argumentHint: "", supportsNonInteractive: false },
  { name: "sandbox", type: "local-jsx", modulePath: "./sandbox-toggle/index.js", tuiModulePath: "./commands/sandbox-toggle/index.js", description: sandboxDescription, isHidden: false, immediate: true, argumentHint: "exclude \"command pattern\"" },
  { name: "tasks", type: "local-jsx", modulePath: "./tasks/index.js", tuiModulePath: "./commands/tasks/index.js", aliases: ["bashes"], description: "List and manage background tasks" },
  { name: "terminal-setup", type: "local-jsx", modulePath: "./terminalSetup/index.js", tuiModulePath: "./commands/terminalSetup/index.js", description: terminalSetupDescription, isHidden: terminalSetupHidden },
  { name: "theme", type: "local-jsx", modulePath: "./theme/index.js", tuiModulePath: "./commands/theme/index.js", description: "Change the theme" },
  { name: "vim", type: "local", modulePath: "./vim/index.js", tuiModulePath: "./commands/vim/index.js", description: "Toggle between Vim and Normal editing modes", supportsNonInteractive: false },
  { name: "install", type: "local-jsx", modulePath: "./install.js", tuiModulePath: "./commands/install.js", exportName: "install", description: "Install AgenC native build", argumentHint: "[options]" },
  { name: "commit", type: "prompt", modulePath: "./commit.js", tuiModulePath: "./commands/commit.js", description: "Create a git commit", progressMessage: "creating commit", allowedTools: ["Bash(git add:*)", "Bash(git status:*)", "Bash(git commit:*)"], contentLength: 0, source: "builtin" },
  { name: "review", type: "prompt", modulePath: "./review.js", tuiModulePath: "./commands/review.js", description: "Review a pull request", progressMessage: "reviewing pull request", contentLength: 0, source: "builtin" },
  {
    name: "cache-probe",
    type: "local",
    modulePath: "./cache-probe/index.js",
    tuiModulePath: "./commands/cache-probe/index.js",
    description: "Send identical requests to test prompt caching (results in debug log)",
    argumentHint: "[model] [--no-key]",
    isEnabled: () =>
      isEnvTruthy(process.env.AGENC_USE_OPENAI) ||
      isEnvTruthy(process.env.AGENC_USE_GITHUB),
    supportsNonInteractive: false,
  },
  {
    name: "install-slack-app",
    type: "local",
    modulePath: "./install-slack-app/index.js",
    tuiModulePath: "./commands/install-slack-app/index.js",
    description: "Install the AgenC Slack app",
    availability: ["agenc-ai"],
    supportsNonInteractive: false,
  },
  {
    name: "onboard-github",
    type: "local-jsx",
    modulePath: "./onboard-github/index.js",
    tuiModulePath: "./commands/onboard-github/index.js",
    description: "Interactive setup for GitHub Copilot: OAuth device login stored in secure storage",
    aliases: ["onboarding-github", "onboardgithub", "onboardinggithub"],
  },
  {
    name: "plugin",
    type: "local-jsx",
    modulePath: "./plugin/index.js",
    tuiModulePath: "./commands/plugin/index.js",
    description: "Manage AgenC plugins",
    aliases: ["plugins", "marketplace"],
    immediate: true,
  },
  {
    name: "init-verifiers",
    type: "prompt",
    modulePath: "./init-verifiers.js",
    tuiModulePath: "./commands/init-verifiers.js",
    description: "Create verifier skill(s) for automated verification of code changes",
    progressMessage: "analyzing your project and creating verifier skills",
    contentLength: 0,
    source: "builtin",
  },
  {
    name: "commit-push-pr",
    type: "prompt",
    modulePath: "./commit-push-pr.js",
    tuiModulePath: "./commands/commit-push-pr.js",
    description: "Create a git commit, push to remote, and open a pull request",
    progressMessage: "creating commit, pushing, and opening pull request",
    contentLength: 0,
    source: "builtin",
  },
  {
    name: "install-github-app",
    type: "local-jsx",
    modulePath: "./install-github-app/index.js",
    tuiModulePath: "./commands/install-github-app/index.js",
    description: "Set up AgenC GitHub Actions for a repository",
    availability: ["agenc-ai", "console"],
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND),
  },
  {
    name: "brief",
    type: "local-jsx",
    modulePath: "./brief.js",
    tuiModulePath: "./commands/brief.js",
    description: "Toggle brief-only mode",
    immediate: true,
  },
  {
    name: "bridge-kick",
    type: "local",
    modulePath: "./bridge-kick.js",
    tuiModulePath: "./commands/bridge-kick.js",
    description: "Inject bridge failure states for manual recovery testing",
    isEnabled: () => process.env.USER_TYPE === "ant",
    supportsNonInteractive: false,
  },
] as const satisfies readonly LegacyCommandSurfaceSpec[];

const legacyCommandSurfaces = (registeredLegacyCommandSurfaceSpecs as readonly LegacyCommandSurfaceSpec[]).map(
  spec => spec.register === false ? null : legacyCommandSurface(spec),
).filter(
  (command): command is SlashCommand => command !== null,
) satisfies readonly SlashCommand[];

const legacyCommandNames = new Set(legacyCommandSurfaces.map(command => command.name));
if (legacyCommandNames.size !== legacyCommandSurfaces.length) {
  throw new Error("Duplicate legacy command surface registration");
}

const orphanedCommandSurfaceNames = legacyCommandSurfaces.map(
  command => command.name,
);

export function registeredLegacyCommandSurfaceNames(): readonly string[] {
  return orphanedCommandSurfaceNames;
}

/**
 * Build the default registry.
 *
 * The registry owns presentation order for the user-facing command
 * surface and the CLI/TUI dispatch path.
 *
 * Worktree commands are included as thin adapters so the bin entry
 * can migrate off the bespoke `bin/slash.ts` path without a second
 * cutover.
 */
export function buildDefaultRegistry(): CommandRegistry {
  return CommandRegistry.fromCommands([
    // Presentation order mirrors AgenC-style picker prominence.
    modelCommand,
    providerCommand,
    permissionsCommand,
    configCommand,
    hooksCommand,
    helpCommand,
    statusCommand,
    initCommand,
    compactCommand,
    ...legacyCommandSurfaces,
    copyCommand,
    mcpCommand,
    memoryCommand,
    skillsCommand,
    cacheStatsCommand,
    costCommand,
    doctorCommand,
    effortCommand,
    filesCommand,
    releaseNotesCommand,
    reloadPluginsCommand,
    statsCommand,
    usageCommand,
    wikiCommand,
    planCommand,
    resumeCommand,
    forkCommand,
    diffCommand,
    contextCommand,
    keybindingsCommand,
    // Pre-existing worktree adapters
    enterWorktreeCommand,
    exitWorktreeCommand,
    exitCommand,
    clearCommand,
  ]);
}
