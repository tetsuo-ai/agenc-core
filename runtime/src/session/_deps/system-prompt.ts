/**
 * System-prompt and user/system-context surface for compact's
 * `buildCompactCacheSafeParams`.
 *
 * Ports the openclaude `constants/prompts.ts::getSystemPrompt`,
 * `context.ts::getUserContext` / `getSystemContext`, and
 * `utils/systemPrompt.ts::buildEffectiveSystemPrompt` shapes onto gut
 * primitives so the compact summarizer call inherits a real system
 * prompt, real project memory/instructions, and real git status —
 * matching the cache-safe contract the upstream `forkedAgent` honors
 * (see `runtime/src/llm/compact/_deps/fork-agent.ts`).
 *
 * Why this lives in `_deps/` instead of leaning on
 * `prompts/system-prompt.ts::assembleSystemPrompt`:
 *   - `assembleSystemPrompt` requires a live `Session` + `TurnContext`.
 *     compact's cache-safe builder is invoked from `manual-compact.ts`
 *     and `run-turn.ts` with only a `CompactRuntimeContext` (no
 *     turn-context handle for the new turn we're summarizing FOR), so
 *     we cannot satisfy `assembleSystemPrompt`'s shape from here.
 *   - The lower-level section helpers in `prompts/system-prompt.ts`
 *     are pure functions and safe to call directly. We compose them
 *     here against the compact-runtime inputs (tools list, model,
 *     additional dirs, MCP clients).
 *
 * Cross-cuts that we deliberately do NOT carry:
 *   - Output style: the gut runtime has no output-style subsystem.
 *   - Skill listings: the gut runtime has no skill registry.
 *   - Agent listings: `compact-runtime-context.ts` always passes
 *     `mainThreadAgentDefinition: undefined`, so the agent-prompt
 *     branch in `buildEffectiveSystemPrompt` is a no-op for compact.
 *   - `growthbook`/feature-flag gated sections: gut runtime has no
 *     feature-flag gate, so the always-on baseline subset is used.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadProjectInstructionChain } from "../../prompts/project-instructions.js";
import {
  buildEnvInfoSection,
  getActionsSection,
  getMcpInstructionsSection,
  getOutputEfficiencySection,
  getSessionGuidanceSection,
  getSimpleDoingTasksSection,
  getSimpleIntroSection,
  getSimpleSystemSection,
  getSimpleToneAndStyleSection,
  getSummarizeToolResultsSection,
  getUsingYourToolsSection,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type McpServerInstructionsInput,
} from "../../prompts/system-prompt.js";

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────
// SystemPrompt brand
// ─────────────────────────────────────────────────────────────────────

/**
 * Mirrors the upstream `SystemPrompt` brand from
 * `utils/systemPromptType.ts`. Treated as an opaque string array for
 * cache-key derivation by the upstream `query()` path.
 */
export type SystemPrompt = readonly string[] & {
  readonly __brand: "SystemPrompt";
};

export function asSystemPrompt(
  text: string | readonly string[],
): SystemPrompt {
  return (typeof text === "string" ? [text] : [...text]) as unknown as SystemPrompt;
}

// ─────────────────────────────────────────────────────────────────────
// memoize() — local replacement for lodash-es/memoize so this file has
// no extra dep and so we can attach `.cache.clear()` matching the shape
// the post-compact-cleanup paths call.
// ─────────────────────────────────────────────────────────────────────

interface MemoizedAsync<T> {
  (): Promise<T>;
  cache: { clear: () => void };
}

function memoizeAsync<T>(fn: () => Promise<T>): MemoizedAsync<T> {
  let pending: Promise<T> | null = null;
  let resolved = false;
  let cached: T | undefined;
  const wrapper = (() => {
    if (resolved) return Promise.resolve(cached as T);
    if (pending !== null) return pending;
    pending = fn().then(
      (value) => {
        cached = value;
        resolved = true;
        pending = null;
        return value;
      },
      (err) => {
        // Never cache a rejection — let the next caller retry.
        pending = null;
        throw err;
      },
    );
    return pending;
  }) as MemoizedAsync<T>;
  wrapper.cache = {
    clear: () => {
      pending = null;
      resolved = false;
      cached = undefined;
    },
  };
  return wrapper;
}

// ─────────────────────────────────────────────────────────────────────
// getSystemPrompt — port of openclaude `constants/prompts::getSystemPrompt`
// ─────────────────────────────────────────────────────────────────────

interface ToolLike {
  readonly name?: string;
  readonly function?: { readonly name?: string };
}

interface McpClientLike {
  readonly name?: string;
  readonly type?: string;
  readonly instructions?: string;
}

function readToolName(tool: unknown): string | null {
  if (!tool || typeof tool !== "object") return null;
  const t = tool as ToolLike;
  if (typeof t.name === "string" && t.name.length > 0) return t.name;
  if (
    t.function &&
    typeof t.function.name === "string" &&
    t.function.name.length > 0
  ) {
    return t.function.name;
  }
  return null;
}

function buildEnabledToolNames(tools: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = readToolName(tool);
    if (name) names.add(name);
  }
  return names;
}

function buildMcpServerInstructions(
  mcpClients: readonly unknown[] | undefined,
): McpServerInstructionsInput[] {
  if (!mcpClients || mcpClients.length === 0) return [];
  const out: McpServerInstructionsInput[] = [];
  for (const client of mcpClients) {
    if (!client || typeof client !== "object") continue;
    const c = client as McpClientLike;
    if (c.type !== undefined && c.type !== "connected") continue;
    const name = c.name;
    const instructions = c.instructions;
    if (
      typeof name === "string" &&
      typeof instructions === "string" &&
      name.length > 0 &&
      instructions.trim().length > 0
    ) {
      out.push({ name, instructions });
    }
  }
  return out;
}

/**
 * Build the cache-safe default system prompt for compact's summarizer
 * fork. Mirrors the openclaude `getSystemPrompt(tools, model, addDirs,
 * mcpClients)` shape: returns an ordered list of section strings. The
 * upstream consumer (`buildEffectiveSystemPrompt`) wraps this list with
 * `customSystemPrompt` / `appendSystemPrompt` overrides.
 *
 * Notes vs. upstream:
 *   - No `CLAUDE_CODE_SIMPLE` short-path: gut runtime exposes the same
 *     gating via `AGENC_SIMPLE`, but compact does not need the minimal
 *     output (cache reuse is what matters). The full sectioned prompt
 *     is built unconditionally here.
 *   - No output-style / skills / proactive branches (no subsystem).
 *   - `additionalWorkingDirectories` are surfaced as a single env-info
 *     bullet rather than a separate section walk.
 */
export async function getSystemPrompt(
  tools: readonly unknown[] = [],
  model: string = "unknown",
  additionalWorkingDirectories: readonly string[] = [],
  mcpClients: readonly unknown[] = [],
): Promise<string[]> {
  const enabledToolNames = buildEnabledToolNames(tools);
  const mcpServers = buildMcpServerInstructions(mcpClients);
  const cwd = process.cwd();

  const additionalDirsSuffix =
    additionalWorkingDirectories.length > 0
      ? `\nAdditional working directories: ${additionalWorkingDirectories.join(", ")}`
      : "";

  const envSection = buildEnvInfoSection({ model, cwd }) + additionalDirsSuffix;

  // Static (cache-prefix friendly) head — same order as upstream.
  const sections: Array<string | null> = [
    getSimpleIntroSection(false),
    getSimpleSystemSection(),
    getSimpleDoingTasksSection(),
    getActionsSection(),
    getUsingYourToolsSection(enabledToolNames),
    getSimpleToneAndStyleSection(),
    getOutputEfficiencySection(),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    // Dynamic tail — session-scoped; left lean for compact context.
    getSessionGuidanceSection(enabledToolNames, false),
    envSection,
    getMcpInstructionsSection(mcpServers),
    getSummarizeToolResultsSection(),
  ];

  return sections.filter((s): s is string => s !== null && s.length > 0);
}

// ─────────────────────────────────────────────────────────────────────
// getUserContext — project memory / instructions / current date.
// Memoized for the duration of a session; `runPostCompactCleanup`
// calls `getUserContext.cache.clear()` after a compact boundary so the
// next turn re-reads project files.
// ─────────────────────────────────────────────────────────────────────

function isoDateOnly(now: Date = new Date()): string {
  // YYYY-MM-DD in local time. Display only (matches upstream's
  // `getLocalISODate` shape; no deadline arithmetic relies on it).
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function loadProjectInstructionsForCwd(
  cwd: string,
): Promise<string | null> {
  try {
    const chain = await loadProjectInstructionChain({ cwd });
    if (chain.length === 0) return null;
    const blocks: string[] = [];
    for (const entry of chain) {
      const trimmed = entry.content.trim();
      if (trimmed.length === 0) continue;
      blocks.push(`Contents of ${entry.path}:\n\n${trimmed}`);
    }
    return blocks.length > 0 ? blocks.join("\n\n") : null;
  } catch {
    // Project-instructions discovery is best-effort. Failure here must
    // never block compaction.
    return null;
  }
}

const _getUserContextImpl = memoizeAsync<{ [k: string]: string }>(async () => {
  const cwd = process.cwd();
  const projectInstructions = await loadProjectInstructionsForCwd(cwd);
  return {
    ...(projectInstructions ? { projectInstructions } : {}),
    currentDate: `Today's date is ${isoDateOnly()}.`,
  };
});

export const getUserContext: MemoizedAsync<{ [k: string]: string }> =
  _getUserContextImpl;

// ─────────────────────────────────────────────────────────────────────
// getSystemContext — git status snapshot. Memoized; `runPostCompactCleanup`
// implicitly resets via `getUserContext.cache.clear()` upstream — gut
// matches the same explicit-clear contract on this export so the post-
// compact path can reset both caches symmetrically.
// ─────────────────────────────────────────────────────────────────────

const MAX_GIT_STATUS_CHARS = 2000;

async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 1500,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return out === "true";
}

async function buildGitStatus(cwd: string): Promise<string | null> {
  if (!(await isGitRepo(cwd))) return null;

  const [branch, mainBranch, statusRaw, log, userName] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    // Best-effort default branch. `git symbolic-ref refs/remotes/origin/HEAD`
    // works when origin/HEAD is set; otherwise fall back to "main".
    runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd).then(
      (out) => {
        if (out.length === 0) return "main";
        // strip the leading "origin/"
        const slash = out.indexOf("/");
        return slash >= 0 ? out.slice(slash + 1) : out;
      },
    ),
    runGit(["--no-optional-locks", "status", "--short"], cwd),
    runGit(["--no-optional-locks", "log", "--oneline", "-n", "5"], cwd),
    runGit(["config", "user.name"], cwd),
  ]);

  if (!branch) return null;

  const truncatedStatus =
    statusRaw.length > MAX_GIT_STATUS_CHARS
      ? statusRaw.substring(0, MAX_GIT_STATUS_CHARS) +
        '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using the shell tool)'
      : statusRaw;

  return [
    `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
    `Current branch: ${branch}`,
    `Main branch (you will usually use this for PRs): ${mainBranch}`,
    ...(userName ? [`Git user: ${userName}`] : []),
    `Status:\n${truncatedStatus || "(clean)"}`,
    `Recent commits:\n${log}`,
  ].join("\n\n");
}

const _getSystemContextImpl = memoizeAsync<{ [k: string]: string }>(async () => {
  // Skip git work in tests to avoid hitting a real repo from suites that
  // mock outward. Matches upstream `getGitStatus` early-return.
  if (process.env.NODE_ENV === "test") {
    return {};
  }
  const gitStatus = await buildGitStatus(process.cwd());
  return {
    ...(gitStatus ? { gitStatus } : {}),
  };
});

export const getSystemContext: MemoizedAsync<{ [k: string]: string }> =
  _getSystemContextImpl;

// ─────────────────────────────────────────────────────────────────────
// buildEffectiveSystemPrompt — port of upstream
// `utils/systemPrompt.ts::buildEffectiveSystemPrompt`, trimmed to the
// branches compact actually exercises.
// ─────────────────────────────────────────────────────────────────────

/**
 * Compose the final system prompt for the compact summarizer call:
 *
 *   0. `overrideSystemPrompt` — REPLACES everything (loop-mode override).
 *   1. `customSystemPrompt` — REPLACES the default sectioned prompt.
 *   2. Otherwise — use `defaultSystemPrompt` as-is.
 *
 *   `appendSystemPrompt` is concatenated at the end unless an override
 *   was applied.
 *
 * We deliberately drop the upstream coordinator-mode and agent-prompt
 * branches: gut compact-runtime always passes
 * `mainThreadAgentDefinition: undefined`, and there is no coordinator
 * subsystem in the gut tree.
 */
export function buildEffectiveSystemPrompt(input: {
  mainThreadAgentDefinition?: unknown;
  toolUseContext?: unknown;
  customSystemPrompt?: string;
  defaultSystemPrompt: readonly string[];
  appendSystemPrompt?: string;
  overrideSystemPrompt?: string | null;
}): SystemPrompt {
  if (input.overrideSystemPrompt) {
    return asSystemPrompt([input.overrideSystemPrompt]);
  }
  return asSystemPrompt([
    ...(input.customSystemPrompt
      ? [input.customSystemPrompt]
      : input.defaultSystemPrompt),
    ...(input.appendSystemPrompt ? [input.appendSystemPrompt] : []),
  ]);
}
