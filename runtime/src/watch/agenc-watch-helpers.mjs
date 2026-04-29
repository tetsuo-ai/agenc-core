export const DEFAULT_INPUT_BATCH_DELAY_MS = 45;

/**
 * Known Grok chat model IDs available for `/model` tab completion.
 * Kept in sync with runtime/src/gateway/context-window.ts KNOWN_GROK_MODEL_IDS.
 */
export const KNOWN_CHAT_MODELS = Object.freeze([
  "grok-4.20-multi-agent-0309",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-code-fast-1",
  "grok-4-0709",
  "grok-3",
  "grok-3-mini",
]);

function modelIdMatchesQuery(id, query) {
  const haystack = id.toLowerCase();
  if (haystack.includes(query)) return true;
  const tokens = query.split(/[\s_]+/).filter(Boolean);
  return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
}

export function matchModelNames(query, { limit = 8 } = {}) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return KNOWN_CHAT_MODELS.slice(0, limit);
  return KNOWN_CHAT_MODELS
    .filter((id) => modelIdMatchesQuery(id, q))
    .slice(0, limit);
}

const CORE_WATCH_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/help",
    aliases: ["/commands"],
    usage: "/help",
    description: "Show the operator command reference.",
  }),
  Object.freeze({
    name: "/new",
    usage: "/new",
    description: "Start a fresh chat session.",
  }),
  Object.freeze({
    name: "/init",
    usage: "/init [--force]",
    description: "Generate an AGENC.md contributor guide for this repo.",
  }),
  Object.freeze({
    name: "/session",
    usage: "/session [status|list|inspect|history|resume|fork]",
    description: "Inspect, list, resume, or fork daemon-backed sessions.",
  }),
  Object.freeze({
    name: "/runs",
    usage: "/runs",
    description: "List active durable background runs.",
  }),
  Object.freeze({
    name: "/inspect",
    usage: "/inspect",
    description: "Inspect the current background run.",
  }),
  Object.freeze({
    name: "/trace",
    usage: "/trace [traceId]",
    description: "List recent traces or inspect one trace by id.",
  }),
  Object.freeze({
    name: "/logs",
    usage: "/logs [lines]",
    description: "Fetch recent daemon logs.",
  }),
  Object.freeze({
    name: "/status",
    usage: "/status",
    description: "Fetch gateway status and active channel info.",
  }),
  Object.freeze({
    name: "/model",
    aliases: ["/models"],
    usage: "/model [model-name | current | list]",
    description: "Show or switch the current LLM model.",
  }),
  Object.freeze({
    name: "/voice",
    usage: "/voice [start|stop|Ara|Rex|Sal|Eve|Leo|status]",
    description: "Start/stop voice session or change persona.",
  }),
  Object.freeze({
    name: "/memory",
    usage: "/memory [search-query]",
    description: "Search conversation memory or list memory sessions.",
  }),
  Object.freeze({
    name: "/maintenance",
    usage: "/maintenance",
    description: "Show maintenance status for sync, memory, and workspace indexing.",
  }),
  Object.freeze({
    name: "/context",
    usage: "/context",
    description: "Show current context window and token usage.",
  }),
  Object.freeze({
    name: "/pause",
    usage: "/pause",
    description: "Pause the current background run.",
  }),
  Object.freeze({
    name: "/resume",
    usage: "/resume",
    description: "Resume the current background run.",
  }),
  Object.freeze({
    name: "/stop",
    usage: "/stop",
    description: "Stop the current background run.",
  }),
  Object.freeze({
    name: "/cancel",
    usage: "/cancel",
    description: "Cancel the active chat turn.",
  }),
  Object.freeze({
    name: "/clear",
    usage: "/clear",
    description: "Clear the local transcript surface.",
  }),
  Object.freeze({
    name: "/events",
    usage: "/events [all|shell|tool|approval|run|agent|system]",
    description: "Filter visible transcript events by category.",
  }),
  Object.freeze({
    name: "/export",
    aliases: ["/copy"],
    usage: "/export",
    description: "Write the current detail view or transcript to a temp file.",
  }),
  Object.freeze({
    name: "/quit",
    aliases: ["/exit"],
    usage: "/quit",
    description: "Exit the watch console.",
  }),
]);

const REVIEW_MODE_COMMANDS = Object.freeze([]);

const CHECKPOINT_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/checkpoint",
    usage: "/checkpoint [label]",
    description: "Save a local watch checkpoint for later rewind.",
  }),
  Object.freeze({
    name: "/checkpoints",
    usage: "/checkpoints [limit]",
    description: "List recent local watch checkpoints with an optional result limit.",
  }),
  Object.freeze({
    name: "/rewind",
    aliases: ["/rollback"],
    usage: "/rewind [checkpoint-id|latest|active]",
    description: "Restore the watch surface to a saved checkpoint.",
  }),
]);

const DIFF_REVIEW_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/diff",
    usage: "/diff [--staged|--from <ref>|--to <ref>|--files <a,b>]",
    description: "Use the shared daemon-backed diff surface.",
  }),
  Object.freeze({
    name: "/diff-view",
    usage: "/diff-view [open|next|prev|close]",
    description: "Open the newest diff detail, move between hunks, or close diff detail mode.",
  }),
]);

const COMPACTION_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/compact",
    usage: "/compact [now|status]",
    description: "Force conversation compaction or inspect compaction pressure.",
  }),
]);

const PERMISSIONS_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/permissions",
    usage: "/permissions [status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]|allow <toolPattern>|deny <toolPattern>|clear <toolPattern>|reset]",
    description: "Inspect policy state or simulate approval/policy decisions.",
  }),
  Object.freeze({
    name: "/approvals",
    aliases: ["/approve"],
    usage: "/approvals [list|approve <requestId>|deny <requestId>|always <requestId>]",
    description: "List or resolve pending approval requests for the active session.",
  }),
]);

const ATTACHMENT_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/attach",
    usage: "/attach <path>",
    description: "Queue a local file or image attachment for the next prompt.",
  }),
  Object.freeze({
    name: "/attachments",
    usage: "/attachments",
    description: "List the currently queued local attachments.",
  }),
  Object.freeze({
    name: "/unattach",
    aliases: ["/detach"],
    usage: "/unattach [all|index|attachment-id|path]",
    description: "Remove queued attachments by index, id, path, or clear them all.",
  }),
]);

const EXPORT_BUNDLE_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/bundle",
    aliases: ["/export-bundle"],
    usage: "/bundle",
    description: "Write a local JSON bundle with transcript, checkpoints, summary, and planner state.",
  }),
]);

const INSIGHTS_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/insights",
    usage: "/insights",
    description: "Show a local watch summary for session health, queue pressure, planner state, and checkpoints.",
  }),
]);

const THREAD_SWITCHER_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/agents",
    usage: "/agents [roles|list|spawn|assign|inspect|stop]",
    description: "Use the shared child-agent orchestration surface.",
  }),
]);

const SESSION_INDEXING_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/session-label",
    aliases: ["/rename-session"],
    usage: "/session-label [show|clear|<label>]",
    description: "Show, set, or clear a local label for the active session.",
  }),
]);

const RUN_CONTROL_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/run-cancel",
    usage: "/run-cancel [reason]",
    description: "Cancel the active durable run immediately.",
  }),
  Object.freeze({
    name: "/run-objective",
    usage: "/run-objective <objective>",
    description: "Edit the active durable run objective.",
  }),
  Object.freeze({
    name: "/run-constraints",
    usage: "/run-constraints <json>",
    description: "Amend durable run verifier/heartbeat constraints with a JSON object.",
  }),
  Object.freeze({
    name: "/run-budget",
    usage: "/run-budget <json>",
    description: "Adjust durable run budget limits with a JSON object.",
  }),
  Object.freeze({
    name: "/run-compact",
    usage: "/run-compact [reason]",
    description: "Force durable run compaction immediately.",
  }),
  Object.freeze({
    name: "/run-worker",
    usage: "/run-worker <json>",
    description: "Reassign durable run worker affinity with a JSON object.",
  }),
  Object.freeze({
    name: "/retry-run",
    aliases: ["/rerun"],
    usage: "/retry-run [reason]",
    description: "Retry the active durable run from its latest checkpoint.",
  }),
  Object.freeze({
    name: "/retry-step",
    usage: "/retry-step <stepName> [--trace <traceId>] [--reason <text>]",
    description: "Retry the active durable run from the latest checkpoint with a targeted step focus.",
  }),
  Object.freeze({
    name: "/retry-trace",
    usage: "/retry-trace <traceId> [stepName] [--reason <text>]",
    description: "Retry the active durable run from the latest checkpoint with a targeted trace focus.",
  }),
  Object.freeze({
    name: "/run-fork",
    usage: "/run-fork <targetSessionId> [--objective <text>] [--reason <text>]",
    description: "Fork the active durable run checkpoint into a new durable-run session.",
  }),
  Object.freeze({
    name: "/verify-override",
    usage: "/verify-override <continue|complete|fail> <reason> [--user-update <text>]",
    description: "Apply an operator verification override to the active durable run.",
  }),
]);

const REMOTE_TOOL_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/desktop",
    usage: "/desktop <start|stop|status|vnc|list|attach>",
    description: "Manage remote desktop/browser sandboxes from the watch TUI.",
  }),
  Object.freeze({
    name: "/market",
    usage: "/market <tasks|skills|governance|disputes|reputation> ...",
    description: "Inspect and mutate marketplace tasks, skills, governance, disputes, and reputation from the main watch TUI.",
  }),
]);

const EXTENSIBILITY_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/extensibility",
    usage: "/extensibility [overview|skills|plugins|mcp|hooks]",
    description: "Inspect local runtime extensibility state, config, and catalogs.",
  }),
  Object.freeze({
    name: "/skills",
    usage: "/skills [list|enable <name>|disable <name>]",
    description: "Use the shared local-skill surface.",
  }),
  Object.freeze({
    name: "/mcp",
    usage: "/mcp [status|list|inspect <server>|tools [server]|validate [server]|reconnect <server>|enable <server>|disable <server>]",
    description: "Use the shared daemon-backed MCP surface.",
  }),
  Object.freeze({
    name: "/hooks",
    usage: "/hooks [list|events]",
    description: "Inspect built-in lifecycle hooks and any configured hook handlers.",
  }),
  Object.freeze({
    name: "/xai",
    usage: "/xai [set|status|validate|clear]",
    description: "Manage the local xAI API key stored in the runtime config.",
  }),
]);

const INPUT_MODE_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/input-mode",
    usage: "/input-mode [show|default|vim]",
    description: "Show or switch the local input profile for the watch composer.",
  }),
  Object.freeze({
    name: "/keybindings",
    usage: "/keybindings [show|default|vim]",
    description: "Show or switch the local keybinding profile.",
  }),
  Object.freeze({
    name: "/theme",
    usage: "/theme [show|default|aurora|ember]",
    description: "Show or switch the local watch color theme.",
  }),
]);

export function buildWatchCommands({ featureFlags = {} } = {}) {
  const commands = [...CORE_WATCH_COMMANDS];
  if (featureFlags?.reviewModes === true) {
    commands.push(...REVIEW_MODE_COMMANDS);
  }
  if (featureFlags?.checkpoints === true) {
    commands.push(...CHECKPOINT_COMMANDS);
  }
  if (featureFlags?.diffReview === true) {
    commands.push(...DIFF_REVIEW_COMMANDS);
  }
  if (featureFlags?.compactionControls === true) {
    commands.push(...COMPACTION_COMMANDS);
  }
  if (featureFlags?.permissionsControls === true) {
    commands.push(...PERMISSIONS_COMMANDS);
  }
  if (featureFlags?.attachments === true) {
    commands.push(...ATTACHMENT_COMMANDS);
  }
  if (featureFlags?.exportBundles === true) {
    commands.push(...EXPORT_BUNDLE_COMMANDS);
  }
  if (featureFlags?.insights === true) {
    commands.push(...INSIGHTS_COMMANDS);
  }
  if (featureFlags?.threadSwitcher === true) {
    commands.push(...THREAD_SWITCHER_COMMANDS);
  }
  if (featureFlags?.sessionIndexing === true) {
    commands.push(...SESSION_INDEXING_COMMANDS);
  }
  if (featureFlags?.rerunFromTrace === true) {
    commands.push(...RUN_CONTROL_COMMANDS);
  }
  if (featureFlags?.remoteTools === true) {
    commands.push(...REMOTE_TOOL_COMMANDS);
  }
  if (featureFlags?.extensibilityHub === true) {
    commands.push(...EXTENSIBILITY_COMMANDS);
  }
  if (featureFlags?.inputModes === true) {
    commands.push(...INPUT_MODE_COMMANDS);
  }
  return Object.freeze(commands.map((command) => Object.freeze({
    ...command,
    aliases: Array.isArray(command.aliases) ? Object.freeze([...command.aliases]) : command.aliases,
    deprecatedAliases: Array.isArray(command.deprecatedAliases)
      ? Object.freeze([...command.deprecatedAliases])
      : command.deprecatedAliases,
  })));
}

export const WATCH_COMMANDS = buildWatchCommands();

export function mergeWatchCommandCatalog(localCommands = WATCH_COMMANDS, sharedCatalog = []) {
  const merged = [...localCommands];
  const seen = new Map(
    localCommands
      .map((command, index) => [String(command?.name ?? "").trim().toLowerCase(), index])
      .filter(([name]) => Boolean(name)),
  );
  for (const entry of sharedCatalog) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const clients = Array.isArray(entry.clients) ? entry.clients : [];
    if (clients.length > 0 && !clients.includes("console")) {
      continue;
    }
    const name = typeof entry.name === "string" ? `/${entry.name.trim()}` : "";
    if (!name) {
      continue;
    }
    const normalizedName = name.toLowerCase();
    const aliases = [
      ...(Array.isArray(entry.aliases) ? entry.aliases : []),
    ]
      .map((alias) => (typeof alias === "string" ? `/${alias.trim()}` : ""))
      .filter(Boolean);
    const deprecatedAliases = (Array.isArray(entry.deprecatedAliases) ? entry.deprecatedAliases : [])
      .map((alias) => (typeof alias === "string" ? `/${alias.trim()}` : ""))
      .filter(Boolean);
    const args = typeof entry.args === "string" && entry.args.trim().length > 0
      ? ` ${entry.args.trim()}`
      : "";
    const nextEntry = Object.freeze({
      name,
      aliases: Object.freeze(aliases),
      deprecatedAliases: Object.freeze(deprecatedAliases),
      usage: `${name}${args}`,
      description:
        typeof entry.description === "string" && entry.description.trim().length > 0
          ? entry.description.trim()
          : "Runtime command",
    });
    const existingIndex = seen.get(normalizedName);
    if (existingIndex !== undefined) {
      merged[existingIndex] = nextEntry;
      continue;
    }
    seen.set(normalizedName, merged.length);
    merged.push(nextEntry);
  }
  return Object.freeze(merged);
}

const BACKGROUND_RUN_STATES = new Set([
  "pending",
  "running",
  "working",
  "blocked",
  "partial",
  "needs_verification",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "suspended",
]);

export function shouldAutoInspectRun(runDetail, runState) {
  if (runDetail && typeof runDetail === "object") {
    return true;
  }
  const normalizedState = String(runState ?? "")
    .trim()
    .toLowerCase();
  return BACKGROUND_RUN_STATES.has(normalizedState);
}

export function createOperatorInputBatcher({
  onDispatch,
  delayMs = DEFAULT_INPUT_BATCH_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof onDispatch !== "function") {
    throw new TypeError("createOperatorInputBatcher requires an onDispatch callback");
  }

  let pendingLines = [];
  let timer = null;

  const clearPendingTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearPendingTimer();
    if (pendingLines.length === 0) return;
    const value = pendingLines.join("\n").trim();
    pendingLines = [];
    if (value) {
      onDispatch(value);
    }
  };

  const scheduleFlush = () => {
    clearPendingTimer();
    timer = setTimer(() => {
      timer = null;
      flush();
    }, delayMs);
  };

  return {
    push(line) {
      const trimmed = String(line ?? "").trim();
      if (!trimmed) {
        return;
      }
      pendingLines.push(trimmed);
      scheduleFlush();
    },
    flush,
    dispose({ flushPending = false } = {}) {
      if (flushPending) {
        flush();
        return;
      }
      clearPendingTimer();
      pendingLines = [];
    },
  };
}

function normalizeSlashInput(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function findWatchCommandDefinition(nameOrAlias, { commands = WATCH_COMMANDS } = {}) {
  const normalized = normalizeSlashInput(nameOrAlias);
  if (!normalized.startsWith("/")) {
    return null;
  }
  for (const command of commands) {
    if (command.name === normalized) {
      return command;
    }
    if (Array.isArray(command.aliases) && command.aliases.includes(normalized)) {
      return command;
    }
    if (Array.isArray(command.deprecatedAliases) && command.deprecatedAliases.includes(normalized)) {
      return command;
    }
  }
  return null;
}

export function matchWatchCommands(input, { limit = WATCH_COMMANDS.length, commands = WATCH_COMMANDS } = {}) {
  const normalized = normalizeSlashInput(input);
  if (!normalized.startsWith("/")) {
    return [];
  }
  const [commandToken = "/"] = normalized.split(/\s+/, 1);
  const query = commandToken === "/" ? "" : commandToken.slice(1);
  const ranked = commands
    .map((command) => {
      const names = [
        command.name,
        ...(command.aliases ?? []),
        ...(command.deprecatedAliases ?? []),
      ];
      const exact = names.some((name) => name === commandToken);
      const startsWith = names.some((name) => name.slice(1).startsWith(query));
      if (query.length > 0 && !exact && !startsWith) {
        return null;
      }
      return {
        command,
        score: exact ? 0 : startsWith ? 1 : 2,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.command.name.localeCompare(right.command.name);
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.command);
  return ranked;
}

export function parseWatchSlashCommand(input, { commands = WATCH_COMMANDS } = {}) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [commandToken = "", ...args] = trimmed.split(/\s+/);
  const command = findWatchCommandDefinition(commandToken, { commands });
  if (!command) {
    return {
      raw: trimmed,
      commandToken,
      args,
      command: null,
    };
  }
  return {
    raw: trimmed,
    commandToken,
    args,
    command,
  };
}
