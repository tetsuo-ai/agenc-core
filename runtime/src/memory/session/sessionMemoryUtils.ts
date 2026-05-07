/**
 * Source-aligned with `src/services/SessionMemory/sessionMemoryUtils.ts` at
 * donor commit 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * This module keeps the extraction thresholds and notes-file path helpers
 * independent from the agent runner so compaction and commands can read the
 * notes state without importing subagent orchestration.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { findGitRoot as findCanonicalGitRoot } from "../../agents/worktree.js";
import { findProjectRootSync } from "../../session/session-store.js";
import {
  isEnvDefinedFalsy,
  isEnvTruthy,
  resolveAgenCConfigHomeDir,
} from "../../utils/envUtils.js";
import { sanitizePathForProjectKey } from "../../services/extractMemories/memory-paths.js";

const EXTRACTION_WAIT_TIMEOUT_MS = 15_000;
const EXTRACTION_STALE_THRESHOLD_MS = 60_000;

export type SessionMemoryEnv = Readonly<Record<string, string | undefined>>;

/**
 * Configuration for session memory extraction thresholds.
 */
export interface SessionMemoryConfig {
  /** Minimum context-window tokens before initializing session memory. */
  readonly minimumMessageTokensToInit: number;
  /** Minimum context-window growth between session memory updates. */
  readonly minimumTokensBetweenUpdate: number;
  /** Number of assistant tool calls between session memory updates. */
  readonly toolCallsBetweenUpdates: number;
}

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
};

export interface SessionMemoryState {
  sessionMemoryConfig: SessionMemoryConfig;
  lastSummarizedMessageId: string | undefined;
  lastSummarizedMessageCount: number;
  extractionStartedAt: number | undefined;
  tokensAtLastExtraction: number;
  sessionMemoryInitialized: boolean;
}

export interface SessionMemoryPathOptions {
  readonly cwd: string;
  readonly sessionId: string;
  readonly env?: SessionMemoryEnv;
  readonly configHomeDir?: string;
  readonly homeDir?: string;
}

const defaultState: SessionMemoryState = createSessionMemoryState();

function effectiveEnv(env: SessionMemoryEnv | undefined): SessionMemoryEnv {
  return env ?? process.env;
}

function normalizeWithTrailingSep(path: string): string {
  return `${normalize(path).replace(/[/\\]+$/u, "")}${sep}`.normalize("NFC");
}

function projectRootForSession(cwd: string): string {
  const stableRoot = findProjectRootSync(cwd)?.rootDir ?? cwd;
  return findCanonicalGitRoot(stableRoot) ?? stableRoot;
}

function safeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  return sanitizePathForProjectKey(trimmed.length > 0 ? trimmed : "default");
}

export function createSessionMemoryState(
  config: Partial<SessionMemoryConfig> = {},
): SessionMemoryState {
  return {
    sessionMemoryConfig: {
      ...DEFAULT_SESSION_MEMORY_CONFIG,
      ...positiveConfig(config),
    },
    lastSummarizedMessageId: undefined,
    lastSummarizedMessageCount: 0,
    extractionStartedAt: undefined,
    tokensAtLastExtraction: 0,
    sessionMemoryInitialized: false,
  };
}

function positiveConfig(
  config: Partial<SessionMemoryConfig>,
): Partial<SessionMemoryConfig> {
  const next: {
    minimumMessageTokensToInit?: number;
    minimumTokensBetweenUpdate?: number;
    toolCallsBetweenUpdates?: number;
  } = {};
  if (
    typeof config.minimumMessageTokensToInit === "number" &&
    config.minimumMessageTokensToInit > 0
  ) {
    next.minimumMessageTokensToInit = config.minimumMessageTokensToInit;
  }
  if (
    typeof config.minimumTokensBetweenUpdate === "number" &&
    config.minimumTokensBetweenUpdate > 0
  ) {
    next.minimumTokensBetweenUpdate = config.minimumTokensBetweenUpdate;
  }
  if (
    typeof config.toolCallsBetweenUpdates === "number" &&
    config.toolCallsBetweenUpdates > 0
  ) {
    next.toolCallsBetweenUpdates = config.toolCallsBetweenUpdates;
  }
  return next;
}

export function resolveSessionMemoryDirectory(
  options: SessionMemoryPathOptions,
): string {
  const env = effectiveEnv(options.env);
  const configHome =
    options.configHomeDir ??
    resolveAgenCConfigHomeDir({
      configDirEnv: env.AGENC_CONFIG_DIR,
      agencHomeEnv: env.AGENC_HOME,
      homeDir: options.homeDir ?? homedir(),
    });
  return normalizeWithTrailingSep(
    join(
      configHome,
      "projects",
      sanitizePathForProjectKey(projectRootForSession(options.cwd)),
      safeSessionId(options.sessionId),
      "session-memory",
    ),
  );
}

export function resolveSessionMemoryPath(
  options: SessionMemoryPathOptions,
): string {
  return join(resolveSessionMemoryDirectory(options), "summary.md");
}

export function isSessionMemoryEnabled(
  env: SessionMemoryEnv | undefined = undefined,
): boolean {
  const source = effectiveEnv(env);
  if (isEnvTruthy(source.AGENC_DISABLE_SESSION_MEMORY)) return false;
  if (isEnvDefinedFalsy(source.AGENC_SESSION_MEMORY_ENABLED)) return false;
  if (isEnvTruthy(source.AGENC_SESSION_MEMORY_ENABLED)) return true;
  if (isEnvTruthy(source.AGENC_SIMPLE)) return false;
  if (
    isEnvTruthy(source.AGENC_REMOTE) &&
    !source.AGENC_REMOTE_MEMORY_DIR
  ) {
    return false;
  }
  const autoCompactDisabled =
    source.DISABLE_AUTO_COMPACT ?? source.AGENC_DISABLE_AUTO_COMPACT;
  if (isEnvTruthy(autoCompactDisabled)) return false;
  return true;
}

/**
 * Get the message marker up to which the session memory is current.
 */
export function getLastSummarizedMessageId(
  state: SessionMemoryState = defaultState,
): string | undefined {
  return state.lastSummarizedMessageId;
}

export function getLastSummarizedMessageCount(
  state: SessionMemoryState = defaultState,
): number {
  return state.lastSummarizedMessageCount;
}

/**
 * Set the last summarized message marker.
 */
export function setLastSummarizedMessageId(
  messageId: string | undefined,
  state: SessionMemoryState = defaultState,
): void {
  state.lastSummarizedMessageId = messageId;
}

export function setLastSummarizedMessageCount(
  messageCount: number,
  state: SessionMemoryState = defaultState,
): void {
  state.lastSummarizedMessageCount = Math.max(0, Math.trunc(messageCount));
}

export function markExtractionStarted(
  state: SessionMemoryState = defaultState,
): void {
  state.extractionStartedAt = Date.now();
}

export function markExtractionCompleted(
  state: SessionMemoryState = defaultState,
): void {
  state.extractionStartedAt = undefined;
}

/**
 * Wait for any in-progress session memory extraction to complete.
 */
export async function waitForSessionMemoryExtraction(
  state: SessionMemoryState = defaultState,
): Promise<void> {
  const startTime = Date.now();
  while (state.extractionStartedAt !== undefined) {
    const extractionAge = Date.now() - state.extractionStartedAt;
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) return;
    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) return;
    await delay(1_000);
  }
}

/**
 * Get the current session memory content.
 */
export async function getSessionMemoryContent(
  options?: SessionMemoryPathOptions | string,
): Promise<string | null> {
  const memoryPath =
    typeof options === "string"
      ? options
      : options
        ? resolveSessionMemoryPath(options)
        : null;
  if (memoryPath === null) return null;
  try {
    return await readFile(memoryPath, { encoding: "utf8" });
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "EACCES" ||
      code === "EPERM"
    ) {
      return null;
    }
    throw error;
  }
}

export function setSessionMemoryConfig(
  config: Partial<SessionMemoryConfig>,
  state: SessionMemoryState = defaultState,
): void {
  state.sessionMemoryConfig = {
    ...state.sessionMemoryConfig,
    ...positiveConfig(config),
  };
}

export function getSessionMemoryConfig(
  state: SessionMemoryState = defaultState,
): SessionMemoryConfig {
  return { ...state.sessionMemoryConfig };
}

export function recordExtractionTokenCount(
  currentTokenCount: number,
  state: SessionMemoryState = defaultState,
): void {
  state.tokensAtLastExtraction = Math.max(0, Math.trunc(currentTokenCount));
}

export function isSessionMemoryInitialized(
  state: SessionMemoryState = defaultState,
): boolean {
  return state.sessionMemoryInitialized;
}

export function markSessionMemoryInitialized(
  state: SessionMemoryState = defaultState,
): void {
  state.sessionMemoryInitialized = true;
}

export function hasMetInitializationThreshold(
  currentTokenCount: number,
  state: SessionMemoryState = defaultState,
): boolean {
  return currentTokenCount >= state.sessionMemoryConfig.minimumMessageTokensToInit;
}

export function hasMetUpdateThreshold(
  currentTokenCount: number,
  state: SessionMemoryState = defaultState,
): boolean {
  const tokensSinceLastExtraction =
    currentTokenCount - state.tokensAtLastExtraction;
  return (
    tokensSinceLastExtraction >=
    state.sessionMemoryConfig.minimumTokensBetweenUpdate
  );
}

export function getToolCallsBetweenUpdates(
  state: SessionMemoryState = defaultState,
): number {
  return state.sessionMemoryConfig.toolCallsBetweenUpdates;
}

export function resetSessionMemoryState(
  state: SessionMemoryState = defaultState,
): void {
  state.sessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG };
  state.tokensAtLastExtraction = 0;
  state.sessionMemoryInitialized = false;
  state.lastSummarizedMessageId = undefined;
  state.lastSummarizedMessageCount = 0;
  state.extractionStartedAt = undefined;
}
