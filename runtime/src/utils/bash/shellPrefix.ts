import { quote } from './shellQuote.js'

/**
 * Parses a shell prefix that may contain an executable path and arguments.
 *
 * Examples:
 * - "bash" -> quotes as 'bash'
 * - "/usr/bin/bash -c" -> quotes as '/usr/bin/bash' -c
 * - "C:\Program Files\Git\bin\bash.exe -c" -> quotes as 'C:\Program Files\Git\bin\bash.exe' -c
 *
 * @param prefix The shell prefix string containing executable and optional arguments
 * @param command The command to be executed
 * @returns The properly formatted command string with quoted components
 */
export function formatShellPrefixCommand(
  prefix: string,
  command: string,
): string {
  // Split on the FIRST space-before-a-dash: the executable is everything up to
  // the first flag, and the rest are arguments. Using lastIndexOf mis-parsed a
  // multi-flag prefix like `wsl -e bash -c` (exec became `wsl -e bash`). A
  // space-containing executable path with no embedded " -" (the common case) is
  // still handled correctly, since its first " -" is the first flag.
  const spaceBeforeDash = prefix.indexOf(' -')
  if (spaceBeforeDash > 0) {
    const execPath = prefix.substring(0, spaceBeforeDash)
    const args = prefix.substring(spaceBeforeDash + 1)
    return `${quote([execPath])} ${args} ${quote([command])}`
  } else {
    return `${quote([prefix])} ${quote([command])}`
  }
}
