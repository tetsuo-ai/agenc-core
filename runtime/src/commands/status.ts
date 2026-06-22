/**
 * `/status` — show session/runtime status.
 *
 * Read-only snapshot of: session id, project root, cwd, model + provider,
 * turn count, token usage (BudgetTracker.emitted + remaining), cost summary,
 * uptime, and permission mode. Runs `immediate: true` — no LLM round-trip.
 *
 * @module
 */

import { spawn } from "node:child_process";

import { monotonicMs } from "../utils/monotonic.js";
import type { Session } from "../session/session.js";
import { isPermissionMode } from "../permissions/types.js";
import { asRecord } from "../utils/record.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import {
  createStatusDashboardSnapshot,
  openStatusDashboard,
} from "./status-menu.js";

export interface StatusLine {
  key: string;
  value: string;
}

interface StatusServices {
  readonly permissionModeRegistry?: {
    readonly current?: () => unknown;
  } | null;
  readonly costSidecar?: unknown;
}

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export type GitStatusSummary =
  | {
      readonly state: "clean" | "dirty";
      readonly branch?: string;
      readonly changedFiles: number;
    }
  | { readonly state: "not-repo"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

type GitRunner = (args: readonly string[], cwd: string) => Promise<GitCommandResult>;

const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    try {
      const child = spawn("git", [...args], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", data => {
        stdout += data.toString("utf8");
      });
      child.stderr.on("data", data => {
        stderr += data.toString("utf8");
      });
      child.on("error", error => {
        resolve({ stdout, stderr: stderr + String(error), code: -1 });
      });
      child.on("close", code => {
        resolve({ stdout, stderr, code });
      });
    } catch (error) {
      resolve({ stdout: "", stderr: String(error), code: -1 });
    }
  });

export function summarizeGitStatus(params: {
  readonly insideWorkTree: GitCommandResult;
  readonly branch: GitCommandResult;
  readonly porcelain: GitCommandResult;
}): GitStatusSummary {
  if (params.insideWorkTree.code !== 0) {
    return { state: "not-repo", message: "Run /status inside a git work tree for branch state." };
  }
  if (params.branch.code !== 0 || params.porcelain.code !== 0) {
    return {
      state: "error",
      message: params.branch.stderr || params.porcelain.stderr || "git status failed",
    };
  }
  const changedFiles = params.porcelain.stdout
    .split("\n")
    .filter(line => line.trim().length > 0).length;
  return {
    state: changedFiles > 0 ? "dirty" : "clean",
    branch: params.branch.stdout.trim() || "detached",
    changedFiles,
  };
}

async function collectGitStatus(
  cwd: string,
  git: GitRunner = runGit,
): Promise<GitStatusSummary> {
  const insideWorkTree = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (insideWorkTree.code !== 0) {
    return summarizeGitStatus({
      insideWorkTree,
      branch: { stdout: "", stderr: "", code: 0 },
      porcelain: { stdout: "", stderr: "", code: 0 },
    });
  }
  const [branch, porcelain] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["status", "--porcelain"], cwd),
  ]);
  return summarizeGitStatus({ insideWorkTree, branch, porcelain });
}

/**
 * Live counters fetched from the daemon-owned session via the
 * `session.snapshot` RPC. The bridge session can't read these
 * directly — `state.history`, `budgetTracker`, etc. live in the
 * daemon's in-process Session.
 */
export interface StatusSnapshot {
  readonly turnCount?: number;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly costUsd?: number;
  };
}

/**
 * Build the status lines from a Session. Exposed for tests so they can
 * assert structure without reaching through the formatting layer.
 */
export function collectStatus(
  session: Session,
  cwd: string,
  nowMs: number = monotonicMs(),
  snapshot?: StatusSnapshot,
): StatusLine[] {
  const lines: StatusLine[] = [];
  // The deferred TUI flow seeds `conversationId` with a synthetic
  // `agenc-tui-idle-<pid>` value until the user sends their first message
  // (then the daemon vends a real `conv-*` id). Don't surface the
  // synthetic placeholder — a returning user can't use it as a resume
  // key, and seeing it is more confusing than not seeing the field.
  // See round-2 finding MD-NEW6.
  const isSyntheticIdleId = /^agenc-tui-idle-\d+$/.test(session.conversationId);
  if (!isSyntheticIdleId) {
    lines.push({ key: "Session ID", value: session.conversationId });
  } else {
    lines.push({
      key: "Session ID",
      value: "(idle — assigned when you send your first message)",
    });
  }
  lines.push({ key: "CWD", value: cwd });

  // Read SessionConfiguration via the lock's synchronous peek. This is
  // safe for an immediate:true display command — no concurrent writer
  // would race a cheap fields-only read, and using `.with()` would
  // force us into an async code path the dispatcher doesn't need.
  //
  // The TUI runs slash commands against an AgenCBridgeSession (daemon
  // client) that does NOT expose `state`. Guard the access so the
  // command degrades to "unknown" lines instead of crashing with a
  // raw `Cannot read properties of undefined (reading 'unsafePeek')`.
  const peekState = (session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const rawState = (typeof peekState === "function"
    ? (peekState.call((session as unknown as { state?: unknown }).state) as {
        sessionConfiguration?: {
          cwd?: string;
          collaborationMode?: { model?: string };
          provider?: { slug?: string };
          approvalPolicy?: { value?: string };
        };
        history?: unknown[];
      })
    : null);
  const stateObj = rawState ?? null;
  // Bridge sessions surface model/provider via sessionConfiguration on
  // the session itself; fall back to that when state is unavailable.
  const fallbackConfig = stateObj?.sessionConfiguration
    ? undefined
    : (session as unknown as {
        sessionConfiguration?: {
          cwd?: string;
          collaborationMode?: { model?: string };
          provider?: { slug?: string };
        };
      }).sessionConfiguration;

  const sc = stateObj?.sessionConfiguration ?? fallbackConfig;
  if (sc) {
    const model = sc.collaborationMode?.model ?? "unknown";
    const provider = sc.provider?.slug ?? "unknown";
    lines.push({ key: "Model", value: model });
    lines.push({ key: "Provider", value: provider });
  } else {
    lines.push({ key: "Model", value: "unknown" });
    lines.push({ key: "Provider", value: "unknown" });
  }

  // Turn count: prefer the daemon snapshot when available (bridge
  // sessions have no local `state.history`), then the in-process
  // state.history length.
  const turnCount =
    snapshot?.turnCount ?? stateObj?.history?.length ?? 0;
  lines.push({ key: "Turn count", value: String(turnCount) });

  // Token usage: prefer BudgetTracker.emitted (in-process); then the
  // daemon-vended snapshot; then a "n/a" placeholder. The daemon
  // snapshot is what makes /status useful on TUI bridge sessions.
  const bt = (session as unknown as { budgetTracker?: typeof session.budgetTracker }).budgetTracker;
  if (bt) {
    const emitted = bt.emitted;
    const remaining = bt.remaining;
    lines.push({ key: "Tokens emitted", value: String(emitted) });
    lines.push({
      key: "Tokens remaining",
      value: remaining === null || !Number.isFinite(remaining)
        ? "unlimited"
        : String(remaining),
    });
  } else if (snapshot?.tokenUsage) {
    const u = snapshot.tokenUsage;
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const totalTokens = u.totalTokens ?? 0;
    // The runtime's per-turn accounting tracks aggregate totalTokens
    // but most providers don't surface the input/output split through
    // the same channel — when both are zero, show just the total.
    const value =
      inputTokens === 0 && outputTokens === 0
        ? String(totalTokens)
        : `${totalTokens} (in: ${inputTokens}, out: ${outputTokens})`;
    lines.push({ key: "Tokens emitted", value });
    if (typeof u.costUsd === "number" && u.costUsd > 0) {
      lines.push({
        key: "Cost (USD)",
        value: `$${u.costUsd.toFixed(4)}`,
      });
    }
  } else {
    lines.push({ key: "Tokens emitted", value: "n/a (budget disabled)" });
  }

  const createdAtMs = (session as unknown as { createdAtMs?: number }).createdAtMs;
  if (typeof createdAtMs === "number" && Number.isFinite(createdAtMs)) {
    lines.push({ key: "Uptime (ms)", value: String(Math.max(0, nowMs - createdAtMs)) });
  }

  // Permission mode — sourced from the T11 `PermissionModeRegistry`
  // (`session.services.permissionModeRegistry`). Fall back to "default"
  // when the registry is not wired (unit-test fixtures, early bootstrap).
  const services = (session as unknown as {
    services?: StatusServices;
  }).services;
  const costSummary = readCostSummary(services?.costSidecar);
  if (costSummary !== null) {
    lines.push({ key: "Cost", value: costSummary });
  }
  const registry = services?.permissionModeRegistry ?? null;
  lines.push({
    key: "Permission mode",
    value: readPermissionMode(registry),
  });

  return lines;
}

function readCostSummary(costSidecar: unknown): string | null {
  const record = asRecord(costSidecar);
  if (record === null || typeof record.formatSummary !== "function") {
    return null;
  }
  const summary = record.formatSummary.call(costSidecar);
  return typeof summary === "string" ? summary : null;
}

function readPermissionMode(
  registry: StatusServices["permissionModeRegistry"],
): string {
  const current = registry?.current?.();
  const record = asRecord(current);
  return isPermissionMode(record?.mode) ? record.mode : "default";
}

/**
 * Render StatusLine[] into a column-aligned text block.
 */
export function formatStatus(lines: ReadonlyArray<StatusLine>): string {
  const width = lines.reduce((m, l) => Math.max(m, l.key.length), 0);
  return lines
    .map((l) => `${l.key.padEnd(width)} : ${l.value}`)
    .join("\n");
}

export const statusCommand: SlashCommand = {
  name: "status",
  description: "Show current session and runtime status",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      // Pull live counters from the daemon if this is a bridge
      // session. Bridge sessions have no local state.history /
      // budgetTracker so we'd otherwise show zeros. Best-effort: if
      // the daemon is unreachable, just render what we have.
      let snapshot: StatusSnapshot | undefined;
      const getDaemonSnapshot = (
        ctx.session as unknown as {
          getDaemonSessionSnapshot?: () => Promise<StatusSnapshot>;
        }
      ).getDaemonSessionSnapshot;
      if (typeof getDaemonSnapshot === "function") {
        try {
          snapshot = await getDaemonSnapshot();
        } catch {
          /* best-effort */
        }
      }
      const lines = collectStatus(ctx.session, ctx.cwd, undefined, snapshot);
      const dashboard = createStatusDashboardSnapshot({
        lines,
        git: await collectGitStatus(ctx.cwd),
        appState: ctx.appState?.getAppState?.(),
      });
      if (openStatusDashboard(ctx, dashboard)) return { kind: "skip" };
      return { kind: "text", text: formatStatus(lines) };
    }),
};
