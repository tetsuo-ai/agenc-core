export const SHELL_TYPES = ['bash', 'powershell'] as const
export type ShellType = (typeof SHELL_TYPES)[number]
export const DEFAULT_HOOK_SHELL: ShellType = 'bash'

export type PreparedShellCommand = {
  readonly commandString: string
  readonly cwdFilePath: string
  readonly spawnArgs: (commandString: string) => readonly string[]
  readonly environmentOverrides: Readonly<Record<string, string>>
}

export type ShellProvider = {
  type: ShellType
  shellPath: string
  detached: boolean

  /** Build one immutable command plan, including argv and environment. */
  prepareExecCommand(
    command: string,
    opts: {
      id: number | string
      sandboxTmpDir?: string
      tempRoot: string
      useSandbox: boolean
    },
  ): Promise<PreparedShellCommand>
}
