export const DEFAULT_INPUT_BATCH_DELAY_MS = 45;

/**
 * Known Grok chat model IDs available for `/model` tab completion.
 * Kept in sync with runtime/src/gateway/context-window.ts KNOWN_GROK_MODEL_IDS.
 */
export const KNOWN_CHAT_MODELS = Object.freeze([
  "grok-4.20-multi-agent-beta-0309",
  "grok-4.20-beta-0309-reasoning",
  "grok-4.20-beta-0309-non-reasoning",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-code-fast-1",
  "grok-4-0709",
  "grok-3",
  "grok-3-mini",
]);

export function matchModelNames(query, { limit = 8 } = {}) {
  const q = (query ?? "").toLowerCase();
  if (!q) return KNOWN_CHAT_MODELS.slice(0, limit);
  return KNOWN_CHAT_MODELS
    .filter((id) => id.toLowerCase().includes(q))
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
    name: "/sessions",
    usage: "/sessions [query]",
    description: "List resumable chat sessions, optionally filtered by a local query.",
  }),
  Object.freeze({
    name: "/session",
    usage: "/session <sessionId>",
    description: "Resume a specific chat session.",
  }),
  Object.freeze({
    name: "/history",
    usage: "/history [limit]",
    description: "Show recent chat history for the active session.",
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

const REVIEW_MODE_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/review",
    usage: "/review [scope]",
    description: "Run a findings-first code review of the current changes.",
  }),
  Object.freeze({
    name: "/security-review",
    usage: "/security-review [scope]",
    description: "Run a security-focused review of the current changes.",
  }),
  Object.freeze({
    name: "/pr-comments",
    usage: "/pr-comments [scope]",
    description: "Draft concise PR review comments for the current changes.",
  }),
]);

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
    usage: "/diff [open|next|prev|close]",
    description: "Open the newest diff, move between hunks, or close diff detail mode.",
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
    aliases: ["/policy"],
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
    aliases: ["/threads"],
    usage: "/agents [active|all|query]",
    description: "Inspect active or recent planner/subagent threads from the local watch state.",
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
]);

const EXTENSIBILITY_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/extensibility",
    aliases: ["/extensions"],
    usage: "/extensibility [overview|skills|plugins|mcp|hooks]",
    description: "Inspect local runtime extensibility state, config, and catalogs.",
  }),
  Object.freeze({
    name: "/skills",
    usage: "/skills [list|enable <name>|disable <name>]",
    description: "List runtime skills or toggle one through the live gateway session.",
  }),
  Object.freeze({
    name: "/plugins",
    usage: "/plugins [list|trust <packageName> [subpath ...]|untrust <packageName>]",
    description: "Inspect or update trusted plugin packages in the runtime config.",
  }),
  Object.freeze({
    name: "/mcp",
    usage: "/mcp [list|enable <serverName>|disable <serverName>]",
    description: "Inspect MCP servers or toggle one in the runtime config.",
  }),
  Object.freeze({
    name: "/hooks",
    usage: "/hooks [list|events]",
    description: "Inspect built-in lifecycle hooks and any configured hook handlers.",
  }),
]);

const INPUT_MODE_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/config",
    aliases: ["/settings"],
    usage: "/config [show]",
    description: "Show the local watch UI config and quick toggles.",
  }),
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
    usage: "/theme [show|default|aurora|ember|matrix]",
    description: "Show or switch the local watch color theme.",
  }),
  Object.freeze({
    name: "/statusline",
    usage: "/statusline [show|on|off|toggle]",
    description: "Show or toggle the structured footer statusline locally.",
  }),
  Object.freeze({
    name: "/vim",
    usage: "/vim [show|on|off|toggle]",
    description: "Toggle the local watch composer between default and vim mode.",
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
  })));
}

export const WATCH_COMMANDS = buildWatchCommands();

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

  const looksLikeSlashCommand = (value) => String(value ?? "").trim().startsWith("/");

  const flush = () => {
    clearPendingTimer();
    if (pendingLines.length === 0) return;
    const batch = pendingLines;
    pendingLines = [];
    if (batch.length > 1 && batch.some((entry) => looksLikeSlashCommand(entry))) {
      for (const entry of batch) {
        const value = String(entry ?? "").trim();
        if (value) {
          onDispatch(value);
        }
      }
      return;
    }
    const value = batch.join("\n").trim();
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
      const names = [command.name, ...(command.aliases ?? [])];
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
