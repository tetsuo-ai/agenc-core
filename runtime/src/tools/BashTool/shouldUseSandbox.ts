import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-runtime.js'
import { getExecutionAuthoritySettings } from '../../utils/settings/settings.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'
type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
  _dangerouslyDisableSandboxApproved?: boolean
}

// NOTE: excludedCommands is a user-facing convenience feature, not a security boundary.
// It is not a security bug to be able to bypass excludedCommands — the sandbox permission
// system (which prompts users) is the actual security control.
function containsExcludedCommand(command: string): boolean {
  // Only user-configured excluded commands from settings are consulted. A prior
  // "dynamic config" scaffold (a hardcoded-empty { commands, substrings } object
  // and two loops over it) was a refactoring leftover that could never match; it
  // was removed. This path is a user-facing convenience, not a security boundary
  // (see NOTE above) — so it must not be re-wired to a source that could exclude
  // MORE commands from the sandbox.
  const settings = getExecutionAuthoritySettings()
  const userExcludedCommands = settings.sandbox?.excludedCommands ?? []

  if (userExcludedCommands.length === 0) {
    return false
  }

  // Split compound commands (e.g. "docker ps && curl evil.com") into individual
  // subcommands and check each one against excluded patterns. This prevents a
  // compound command from escaping the sandbox just because its first subcommand
  // matches an excluded pattern.
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    subcommands = [command]
  }

  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    // Also try matching with env var prefixes and wrapper commands stripped, so
    // that `FOO=bar bazel ...` and `timeout 30 bazel ...` match `bazel:*`. Not a
    // security boundary (see NOTE at top); the &&-split above already lets
    // `export FOO=bar && bazel ...` match. BINARY_HIJACK_VARS kept as a heuristic.
    //
    // We iteratively apply both stripping operations until no new candidates are
    // produced (fixed-point), matching the approach in filterRulesByContentsMatchingInput.
    // This handles interleaved patterns like `timeout 300 FOO=bar bazel run`
    // where single-pass composition would fail.
    const candidates = [trimmed]
    const seen = new Set(candidates)
    let startIdx = 0
    while (startIdx < candidates.length) {
      const endIdx = candidates.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = candidates[i]!
        const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
        if (!seen.has(envStripped)) {
          candidates.push(envStripped)
          seen.add(envStripped)
        }
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          candidates.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }

    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      for (const cand of candidates) {
        switch (rule.type) {
          case 'prefix':
            if (cand === rule.prefix || cand.startsWith(rule.prefix + ' ')) {
              return true
            }
            break
          case 'exact':
            if (cand === rule.command) {
              return true
            }
            break
          case 'wildcard':
            if (matchWildcardPattern(rule.pattern, cand)) {
              return true
            }
            break
        }
      }
    }
  }

  return false
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  // Only trusted internal callers may request an unsandboxed command. The
  // model-facing Bash schema omits _dangerouslyDisableSandboxApproved, so a
  // tool_use payload cannot disable the sandbox by setting
  // dangerouslyDisableSandbox directly.
  if (
    input.dangerouslyDisableSandbox &&
    input._dangerouslyDisableSandboxApproved &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  if (!input.command) {
    return false
  }
  // Don't sandbox if the command contains user-configured excluded commands
  if (containsExcludedCommand(input.command)) {
    return false
  }
  return true
}
