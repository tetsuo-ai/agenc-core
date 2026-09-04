import { execaSync } from 'execa'
import { dirname } from 'node:path'

export interface SecureStorageCommandOptions {
  readonly input?: string
  readonly reject?: false
  readonly stdio?: readonly [
    'ignore' | 'pipe',
    'ignore' | 'pipe',
    'ignore' | 'pipe',
  ]
}

export interface SecureStorageCommandResult {
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  /** Why there is no exit code: the signal that ended the child, or the spawn error. */
  readonly failure?: string
}

/** Injectable, shell-free subprocess boundary shared by native secure storage adapters. */
export type SecureStorageCommandRunner = (
  command: string,
  args: string[],
  options?: SecureStorageCommandOptions,
) => SecureStorageCommandResult

/**
 * A child that ends without an exit code was signalled, hit an output cap, or
 * never spawned. Name which, so the caller's error says more than "undefined".
 */
export function describeMissingExitCode(result: {
  readonly signal?: string
  readonly isMaxBuffer?: boolean
  readonly timedOut?: boolean
  readonly code?: string
  readonly shortMessage?: string
  readonly originalMessage?: string
}): string {
  const parts: string[] = []
  if (result.signal) parts.push(`signal ${result.signal}`)
  if (result.isMaxBuffer) parts.push('output exceeded the buffer limit')
  if (result.timedOut) parts.push('timed out')
  if (result.code) parts.push(`spawn error ${result.code}`)
  const message = result.originalMessage ?? result.shortMessage
  if (message) parts.push(message.slice(0, 200))
  return parts.length > 0 ? parts.join('; ') : 'no exit code and no error reported'
}

export const runSecureStorageCommand: SecureStorageCommandRunner = (
  command,
  args,
  options,
) => {
  // The helper's own directory outlives any caller cwd; a daemon whose
  // inherited working directory was deleted otherwise fails every spawn with
  // ENOENT (#2149).
  const result = execaSync(command, args, { cwd: dirname(command), ...options })
  return {
    exitCode: result.exitCode ?? undefined,
    stdout: typeof result.stdout === 'string' ? result.stdout : undefined,
    stderr: typeof result.stderr === 'string' ? result.stderr : undefined,
    ...(result.exitCode === undefined
      ? { failure: describeMissingExitCode(result) }
      : {}),
  }
}
