import { join } from "node:path";

import {
  LOCAL_CONFIG_RELATIVE_PATH,
  PROJECT_CONFIG_RELATIVE_PATH,
} from "../../config/project-config-paths.js";
import {
  readStrictConfigLayer,
  trustActivatedRepositoryKeys,
} from "../../config/repository.js";
import type {
  AgenCConfig,
  HooksMap,
  McpServerConfig,
} from "../../config/schema.js";
import { HOOK_EVENT_NAMES } from "../../config/schema.js";
import { isTrustRecord } from "./records.js";

/** One row of the trust card: a label and its values, one per line. */
export interface ProjectTrustItem {
  readonly label: string;
  readonly values: readonly string[];
}

/** What trusting a project root would turn on. */
export interface ProjectTrustReview {
  /** Repository settings that stay inactive until the root is trusted. */
  readonly repoItems: readonly ProjectTrustItem[];
  /**
   * The user's own extensions (hooks, status line, plugins). They run only in
   * trusted roots, so trusting this one lets them run here.
   */
  readonly userItems: readonly ProjectTrustItem[];
}

export interface ProjectTrustReviewOptions {
  /** The canonical project root whose repository config is reviewed. */
  readonly projectRoot: string;
  /** The effective config, used for the user's own hooks and status line. */
  readonly config: AgenCConfig;
}

const REPOSITORY_LAYERS = [
  { scope: "project", segments: PROJECT_CONFIG_RELATIVE_PATH, label: "project config" },
  { scope: "local", segments: LOCAL_CONFIG_RELATIVE_PATH, label: "local config" },
] as const;

const HOOK_EVENT_PHRASES: Readonly<Record<string, string>> = {
  PreToolUse: "before each tool",
  PostToolUse: "after each tool",
  PostToolUseFailure: "after a tool fails",
  PermissionRequest: "on approval requests",
  UserPromptSubmit: "when you send a message",
  SessionStart: "when a session starts",
  SubagentStop: "when a sub-agent ends",
  SessionEnd: "when a session ends",
  Notification: "on notifications",
  Stop: "when a turn ends",
  StopFailure: "when a turn fails",
  PreCompact: "before compaction",
  PostCompact: "after compaction",
};

function hookTiming(event: string, matcher: string | undefined): string {
  const scoped = matcher !== undefined && matcher !== "" && matcher !== "*";
  if (scoped && event === "PreToolUse") return `before ${matcher}`;
  if (scoped && event === "PostToolUse") return `after ${matcher}`;
  return HOOK_EVENT_PHRASES[event] ?? `on ${event}`;
}

function orderedHookEvents(hooks: HooksMap): string[] {
  const known = new Set<string>(HOOK_EVENT_NAMES);
  const events = Object.keys(hooks);
  return [
    ...HOOK_EVENT_NAMES.filter((event) => events.includes(event)),
    ...events.filter((event) => !known.has(event)).sort(),
  ];
}

/** One line per enabled hook: the command and when it runs. */
function describeHooks(hooks: unknown): string[] {
  if (!isTrustRecord(hooks)) return [];
  const lines: string[] = [];
  const map = hooks as HooksMap;
  for (const event of orderedHookEvents(map)) {
    const matchers = map[event];
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!isTrustRecord(matcher) || matcher.enabled === false) continue;
      const scope = typeof matcher.matcher === "string" ? matcher.matcher : undefined;
      const commands = Array.isArray(matcher.hooks) ? matcher.hooks : [];
      for (const hook of commands) {
        if (!isTrustRecord(hook) || hook.enabled === false) continue;
        const what =
          typeof hook.command === "string" && hook.command.trim().length > 0
            ? hook.command.trim()
            : `a ${String(hook.type ?? "hook")} hook`;
        lines.push(`${what} ${hookTiming(event, scope)}`);
      }
    }
  }
  return lines;
}

/** One line per enabled MCP server: its name and what it starts or calls. */
function describeMcpServers(servers: unknown): string[] {
  if (!isTrustRecord(servers)) return [];
  const lines: string[] = [];
  for (const name of Object.keys(servers).sort()) {
    const server = servers[name];
    if (isTrustRecord(server) && server.enabled === false) continue;
    const config = (isTrustRecord(server) ? server : {}) as McpServerConfig;
    const command = [config.command, ...(config.args ?? [])]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ");
    const target = command.length > 0 ? command : config.endpoint;
    lines.push(target ? `${name} (${target})` : name);
  }
  return lines;
}

/** Environment variable NAMES only; values can be secrets. */
function describeShellEnvironment(policy: unknown): string[] {
  if (!isTrustRecord(policy)) return [];
  const names = isTrustRecord(policy.set) ? Object.keys(policy.set).sort() : [];
  return names.length > 0 ? [names.join(", ")] : ["environment policy"];
}

function pushValues(
  rows: Map<string, string[]>,
  label: string,
  values: readonly string[],
): void {
  if (values.length === 0) return;
  rows.set(label, [...(rows.get(label) ?? []), ...values]);
}

function toItems(
  rows: Map<string, string[]>,
  order: readonly string[],
): ProjectTrustItem[] {
  return order
    .filter((label) => (rows.get(label)?.length ?? 0) > 0)
    .map((label) => ({ label, values: [...new Set(rows.get(label))] }));
}

async function reviewRepositorySettings(
  projectRoot: string,
): Promise<ProjectTrustItem[]> {
  const rows = new Map<string, string[]>();
  for (const { scope, segments, label: layerLabel } of REPOSITORY_LAYERS) {
    // Read the files fresh rather than from a loaded store, so the review sees
    // the same bytes the caller fingerprints around this call.
    const snapshot = await readStrictConfigLayer(
      join(projectRoot, ...segments),
      scope,
      layerLabel,
    );
    if (snapshot === null) continue;
    const keys = new Set(trustActivatedRepositoryKeys(snapshot));
    const raw = snapshot.config as Readonly<Record<string, unknown>>;
    const other: string[] = [];
    for (const key of [...keys].sort()) {
      if (key === "hooks") {
        pushValues(rows, "Hooks", describeHooks(raw.hooks));
      } else if (key === "mcp_servers") {
        pushValues(rows, "MCP servers", describeMcpServers(raw.mcp_servers));
      } else if (key === "shell_environment_policy") {
        pushValues(rows, "Shell env", describeShellEnvironment(raw.shell_environment_policy));
      } else {
        other.push(key);
      }
    }
    // A declared but empty section still turns on when trusted; name it.
    for (const [key, label] of [
      ["hooks", "Hooks"],
      ["mcp_servers", "MCP servers"],
      ["shell_environment_policy", "Shell env"],
    ] as const) {
      if (keys.has(key) && !rows.has(label)) other.push(key);
    }
    if (other.length > 0) pushValues(rows, "Settings", [other.sort().join(", ")]);
  }
  return toItems(rows, ["Hooks", "MCP servers", "Shell env", "Settings"]);
}

function reviewUserExtensions(config: AgenCConfig): ProjectTrustItem[] {
  const rows = new Map<string, string[]>();
  if (config.disableAllHooks !== true) {
    pushValues(rows, "Your hooks", describeHooks(config.hooks));
  }
  const statusLine = config.statusLine?.command?.trim();
  if (statusLine) pushValues(rows, "Status line", [statusLine]);
  if (config.plugins?.enabled === true) {
    pushValues(rows, "Plugins", ["enabled, their hooks run in trusted folders"]);
  }
  return toItems(rows, ["Your hooks", "Status line", "Plugins"]);
}

/**
 * Describe what trusting a project root would turn on, in plain words.
 * Repository keys come from the config repository's own sanitizer, so the
 * list matches what trust actually activates. Environment values are never
 * shown, only names.
 */
export async function reviewProjectTrust(
  options: ProjectTrustReviewOptions,
): Promise<ProjectTrustReview> {
  return {
    repoItems: await reviewRepositorySettings(options.projectRoot),
    userItems: reviewUserExtensions(options.config),
  };
}

export function projectTrustReviewIsEmpty(review: ProjectTrustReview): boolean {
  return review.repoItems.length === 0 && review.userItems.length === 0;
}

const INLINE_LABELS: Readonly<Record<string, string>> = {
  "MCP servers": "MCP servers",
  "Status line": "your status line",
  Plugins: "your plugins",
};

/** Short names of what needs review, for one-line headless refusals. */
export function summarizeProjectTrustReview(review: ProjectTrustReview): string {
  return [...review.repoItems, ...review.userItems]
    .map((item) => INLINE_LABELS[item.label] ?? item.label.toLowerCase())
    .join(", ");
}
