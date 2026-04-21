/**
 * Cockpit status line — configurable single-row status strip.
 *
 * Items are specified via `config.statusLine.items: string[]` (schema
 * extension landed alongside this module in
 * `src/config/schema.ts::PartialStatusLineConfig`). The renderer loops
 * over the configured keys in order and looks each one up in the
 * resolver table below.
 *
 * Supported keys (case-sensitive):
 *   - `"model"`   — current model slug
 *   - `"mode"`    — permission mode
 *   - `"session"` — session id short form (last 8 chars)
 *   - `"cwd"`     — basename of the current working directory
 *   - `"git"`     — current git branch (cached 2 s)
 *   - `"tokens"`  — token count surfaced by the session state
 *   - `"context"` — context % full (0–100)
 *   - `"time"`    — local HH:MM
 *
 * Unknown keys resolve to an empty string so a typo in the operator's
 * config silently hides that segment instead of crashing the cockpit.
 *
 * `resolveStatusItem` is exported as a pure async function so tests can
 * exercise the resolver table directly without mounting the React
 * component. The component wraps each render in a lightweight
 * `useEffect` that re-runs the resolvers whenever `items`, `session`,
 * or `cwd` changes.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import React, { useEffect, useState } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { theme } from "../theme.js";

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────
// Session-like shape + config store shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimum structural shape the status line needs from the live
 * session. Mirrors Wave 2-C's pattern (structural type, not the real
 * `Session` class) so tests can wire a tiny stub.
 *
 * Every field is optional — the resolver returns an empty string for a
 * field that is not surfaced. This lets operators configure segments
 * that depend on future wiring without crashing today's cockpit.
 */
export interface SessionLike {
  readonly model?: string;
  readonly mode?: string;
  readonly sessionId?: string;
  readonly tokensUsed?: number;
  readonly contextPercent?: number;
}

export interface ConfigStoreLike {
  readonly snapshot?: unknown;
}

export interface StatusLineConfigProps {
  readonly items: readonly string[];
  readonly session: SessionLike;
  readonly configStore?: ConfigStoreLike;
  /** Override the current working directory — primarily a test hook. */
  readonly cwd?: string;
}

/**
 * Default items shown when `config.statusLine.items` is absent.
 */
export const DEFAULT_STATUS_LINE_ITEMS: readonly string[] = Object.freeze([
  "model",
  "mode",
  "cwd",
]);

// ─────────────────────────────────────────────────────────────────────
// git branch cache (2 s)
// ─────────────────────────────────────────────────────────────────────

const GIT_CACHE_TTL_MS = 2_000;

interface GitCacheEntry {
  readonly branch: string;
  readonly expiresAt: number;
}

// Cache is keyed by cwd so status bars rendered from different
// workspaces don't pollute each other.
const gitBranchCache = new Map<string, GitCacheEntry>();

/**
 * Test-only hook to flush the git branch cache between runs so the
 * "caches within 2s" assertion is not contaminated by previous tests.
 */
export function __resetGitCacheForTesting(): void {
  gitBranchCache.clear();
}

/**
 * Indirection so tests can swap the concrete command runner. We use
 * `execFile` (not `exec`) to avoid a shell — the args are fixed so
 * there is no user input to escape.
 */
export type GitBranchReader = (cwd: string) => Promise<string>;

let gitBranchReader: GitBranchReader = async (cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd, timeout: 2_000 },
  );
  return String(stdout).trim();
};

/**
 * Override the git command runner. Tests use this instead of mocking
 * `node:child_process` globally. The previous reader is returned so
 * callers can restore it after their assertion.
 */
export function __setGitBranchReaderForTesting(
  next: GitBranchReader,
): GitBranchReader {
  const prev = gitBranchReader;
  gitBranchReader = next;
  return prev;
}

async function readGitBranch(cwd: string): Promise<string> {
  const now = Date.now();
  const cached = gitBranchCache.get(cwd);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.branch;
  }
  try {
    const branch = await gitBranchReader(cwd);
    gitBranchCache.set(cwd, {
      branch,
      expiresAt: now + GIT_CACHE_TTL_MS,
    });
    return branch;
  } catch {
    // Failure to resolve → cache an empty string for the TTL so we
    // don't keep hitting execFile inside a tight render loop. The
    // cache entry still expires after 2 s so transient failures
    // recover naturally.
    gitBranchCache.set(cwd, { branch: "", expiresAt: now + GIT_CACHE_TTL_MS });
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pure resolver
// ─────────────────────────────────────────────────────────────────────

function shortSessionId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 8) return trimmed;
  return trimmed.slice(-8);
}

function formatHHMM(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Resolve a single status-line item key to its display string. Kept as
 * a free async function so tests can hit each resolver branch without
 * mounting the component.
 *
 * Unknown keys resolve to `""` — this is intentional so typos in the
 * operator config silently hide that segment instead of crashing.
 */
export async function resolveStatusItem(
  key: string,
  ctx: { session: unknown; cwd: string },
): Promise<string> {
  const session = (ctx.session ?? {}) as SessionLike;
  switch (key) {
    case "model":
      return typeof session.model === "string" ? session.model : "";
    case "mode":
      return typeof session.mode === "string" ? session.mode : "";
    case "session":
      return shortSessionId(session.sessionId);
    case "cwd":
      return basename(ctx.cwd) || ctx.cwd;
    case "git":
      return readGitBranch(ctx.cwd);
    case "tokens":
      return typeof session.tokensUsed === "number" && session.tokensUsed > 0
        ? String(session.tokensUsed)
        : "0";
    case "context":
      if (typeof session.contextPercent !== "number") return "0";
      return `${Math.max(0, Math.min(100, Math.round(session.contextPercent)))}`;
    case "time":
      return formatHHMM(new Date());
    default:
      return "";
  }
}

// ─────────────────────────────────────────────────────────────────────
// React component
// ─────────────────────────────────────────────────────────────────────

const LABEL_FOR: Readonly<Record<string, string>> = Object.freeze({
  model: "model",
  mode: "mode",
  session: "session",
  cwd: "cwd",
  git: "git",
  tokens: "tokens",
  context: "context",
  time: "time",
});

interface ResolvedItem {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export const StatusLineConfig: React.FC<StatusLineConfigProps> = ({
  items,
  session,
  cwd,
}) => {
  const [resolved, setResolved] = useState<readonly ResolvedItem[]>(() =>
    items.map((key) => ({
      key,
      label: LABEL_FOR[key] ?? key,
      value: "",
    })),
  );

  useEffect(() => {
    let cancelled = false;
    const workingDir = cwd ?? process.cwd();
    const workItems = items;
    void (async () => {
      const next: ResolvedItem[] = [];
      for (const key of workItems) {
        const value = await resolveStatusItem(key, {
          session,
          cwd: workingDir,
        });
        next.push({ key, label: LABEL_FOR[key] ?? key, value });
      }
      if (!cancelled) setResolved(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [items, session, cwd]);

  return (
    <Box flexDirection="row" flexWrap="wrap">
      {resolved.map((item, idx) => (
        <Box key={`${item.key}-${idx}`}>
          {idx > 0 ? <Text dim> · </Text> : null}
          <Text dim>{item.label}:</Text>
          <Text color={theme.colors.primary}>{item.value || "—"}</Text>
        </Box>
      ))}
    </Box>
  );
};

export default StatusLineConfig;
