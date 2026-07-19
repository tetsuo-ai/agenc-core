/**
 * Shared conservative command-prefix extraction
 *
 * This module provides a factory for deterministic prefix pre-checks used by
 * different shell tools. Commands without a proven local prefix fall through
 * to normal permission approval.
 */

import type { QuerySource } from '../../constants/querySource.js'
import { memoizeWithLRU } from '../memoize.js'

/**
 * Result of command prefix extraction
 */
export type CommandPrefixResult = {
  /** The detected command prefix, or null if no prefix could be determined */
  commandPrefix: string | null
}

/**
 * Result including subcommand prefixes for compound commands
 */
export type CommandSubcommandPrefixResult = CommandPrefixResult & {
  subcommandPrefixes: Map<string, CommandPrefixResult>
}

/**
 * Configuration for creating a command prefix extractor
 */
export type PrefixExtractorConfig = {
  /** Tool name for logging and warning messages */
  toolName: string

  /** The policy spec containing examples for Haiku */
  policySpec: string
  /** Local event name for logging */
  eventName: string

  /** Query source identifier for the API call */
  querySource: QuerySource

  /** Optional pre-check function that can short-circuit the Haiku call */
  preCheck?: (command: string) => CommandPrefixResult | null
}

/**
 * Creates a memoized command prefix extractor function.
 *
 * Uses two-layer memoization: the outer memoized function creates the promise
 * and attaches a .catch handler that evicts the cache entry on rejection.
 * This prevents aborted calls from poisoning future lookups.
 *
 * Bounded to 200 entries via LRU to prevent unbounded growth in heavy sessions.
 *
 * @param config - Configuration for the extractor
 * @returns A memoized async function that extracts command prefixes
 */
export function createCommandPrefixExtractor(config: PrefixExtractorConfig) {
  const { toolName, policySpec, querySource, preCheck } = config

  const memoized = memoizeWithLRU(
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<CommandPrefixResult | null> => {
      const promise = getCommandPrefixImpl(
        command,
        abortSignal,
        isNonInteractiveSession,
        toolName,
        policySpec,
        querySource,
        preCheck,
      )
      // Evict on rejection so aborted calls don't poison future turns.
      // Identity guard: after LRU eviction, a newer promise may occupy
      // this key; a stale rejection must not delete it.
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command)
        }
      })
      return promise
    },
    command => command, // memoize by command only
    200,
  )

  return memoized
}

/**
 * Creates a memoized function to get prefixes for compound commands with subcommands.
 *
 * Uses the same two-layer memoization pattern as createCommandPrefixExtractor:
 * a .catch handler evicts the cache entry on rejection to prevent poisoning.
 *
 * @param getPrefix - The single-command prefix extractor (from createCommandPrefixExtractor)
 * @param splitCommand - Function to split a compound command into subcommands
 * @returns A memoized async function that extracts prefixes for the main command and all subcommands
 */
export function createSubcommandPrefixExtractor(
  getPrefix: ReturnType<typeof createCommandPrefixExtractor>,
  splitCommand: (command: string) => string[] | Promise<string[]>,
) {
  const memoized = memoizeWithLRU(
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<CommandSubcommandPrefixResult | null> => {
      const promise = getCommandSubcommandPrefixImpl(
        command,
        abortSignal,
        isNonInteractiveSession,
        getPrefix,
        splitCommand,
      )
      // Evict on rejection so aborted calls don't poison future turns.
      // Identity guard: after LRU eviction, a newer promise may occupy
      // this key; a stale rejection must not delete it.
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command)
        }
      })
      return promise
    },
    command => command, // memoize by command only
    200,
  )

  return memoized
}

async function getCommandPrefixImpl(
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
  toolName: string,
  policySpec: string,
  querySource: QuerySource,
  preCheck?: (command: string) => CommandPrefixResult | null,
): Promise<CommandPrefixResult | null> {
  // Run pre-check if provided (e.g., isHelpCommand for Bash)
  if (preCheck) {
    const preCheckResult = preCheck(command)
    if (preCheckResult !== null) {
      return preCheckResult
    }
  }

  void isNonInteractiveSession
  void toolName
  void policySpec
  void querySource

  if (abortSignal.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error('Command-prefix extraction aborted')
  }

  // The former model shortcut was outside execution admission. A missing
  // prefix only removes an allowlist suggestion, so the deterministic and
  // conservative fallback is to require the normal permission flow.
  return { commandPrefix: null }
}

async function getCommandSubcommandPrefixImpl(
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
  getPrefix: ReturnType<typeof createCommandPrefixExtractor>,
  splitCommandFn: (command: string) => string[] | Promise<string[]>,
): Promise<CommandSubcommandPrefixResult | null> {
  const subcommands = await splitCommandFn(command)

  const [fullCommandPrefix, ...subcommandPrefixesResults] = await Promise.all([
    getPrefix(command, abortSignal, isNonInteractiveSession),
    ...subcommands.map(async subcommand => ({
      subcommand,
      prefix: await getPrefix(subcommand, abortSignal, isNonInteractiveSession),
    })),
  ])

  if (!fullCommandPrefix) {
    return null
  }

  const subcommandPrefixes = subcommandPrefixesResults.reduce(
    (acc, { subcommand, prefix }) => {
      if (prefix) {
        acc.set(subcommand, prefix)
      }
      return acc
    },
    new Map<string, CommandPrefixResult>(),
  )

  return {
    ...fullCommandPrefix,
    subcommandPrefixes,
  }
}
