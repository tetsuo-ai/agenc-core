import { execaSync } from 'execa'

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
}

/** Injectable, shell-free subprocess boundary shared by native secure storage adapters. */
export type SecureStorageCommandRunner = (
  command: string,
  args: string[],
  options?: SecureStorageCommandOptions,
) => SecureStorageCommandResult

export const runSecureStorageCommand: SecureStorageCommandRunner = (
  command,
  args,
  options,
) => {
  const result = execaSync(command, args, options)
  return {
    exitCode: result.exitCode ?? undefined,
    stdout: typeof result.stdout === 'string' ? result.stdout : undefined,
    stderr: typeof result.stderr === 'string' ? result.stderr : undefined,
  }
}
