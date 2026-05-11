import { randomUUID } from 'crypto'
import type { Tool, ToolUseContext } from '../tools/Tool.js'
import { CanonicalBashTool } from '../tools/canonicalToolSurface.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage, MalformedCommandError, ShellError } from './errors.js'
import type { FrontmatterShell } from './frontmatterParser.js'
import { createAssistantMessage } from './messages.js'
import { hasPermissionsToUseTool } from './permissions/permissions.js'
import { processToolResultBlock } from './toolResultStorage.js'

// Narrow structural slice both BashTool and PowerShellTool satisfy. We can't
// use the base Tool type: it marks call()'s canUseTool/parentMessage as
// required, but both concrete tools have them optional and the original code
// called BashTool.call({ command }, ctx) with just 2 args. We can't use
// `typeof BashTool` either: BashTool's input schema has fields (e.g.
// _simulatedSedEdit) that PowerShellTool's does not.
// NOTE: call() is invoked directly here, bypassing validateInput — any
// load-bearing check must live in call() itself (see PR #23311).
type ShellOut = {
  stdout: string | null | undefined
  stderr: string | null | undefined
  interrupted: boolean
}
type PromptShellTool = Tool & {
  call(
    input: { command: string },
    context: ToolUseContext,
  ): Promise<{ data: unknown }>
}

import { isPowerShellToolEnabled } from './shell/shellToolUtils.js'

// Lazy: this file is on the startup import chain (main → commands →
// loadSkillsDir → here). A static import would load PowerShellTool.ts
// (and transitively parser.ts, validators, etc.) at startup on all
// platforms, defeating tools.ts's lazy require. Deferred until the
// first skill with `shell: powershell` actually runs.
/* eslint-disable @typescript-eslint/no-require-imports */
const getPowerShellTool = (() => {
  let cached: PromptShellTool | undefined
  return (): PromptShellTool => {
    if (!cached) {
      cached = (
        require('../tools/PowerShellTool/PowerShellTool.js') as typeof import('../tools/PowerShellTool/PowerShellTool.js')
      ).PowerShellTool
    }
    return cached
  }
})()
/* eslint-enable @typescript-eslint/no-require-imports */

function normalizeShellToolData(data: unknown): {
  readonly toolData: unknown
  readonly shellOut: ShellOut
} {
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
  const metadata = record.metadata &&
    typeof record.metadata === 'object' &&
    !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {}
  const stdout = typeof metadata.stdout === 'string'
    ? metadata.stdout
    : typeof record.stdout === 'string'
      ? record.stdout
      : typeof record.content === 'string'
        ? record.content
        : typeof data === 'string'
          ? data
          : ''
  const stderr = typeof metadata.stderr === 'string'
    ? metadata.stderr
    : typeof record.stderr === 'string'
      ? record.stderr
      : ''
  const interrupted =
    typeof record.interrupted === 'boolean' ? record.interrupted : false
  const isError =
    record.isError === true || metadata.isError === true
  const canonicalData =
    typeof record.content === 'string' || record.metadata !== undefined
      ? {
          content: typeof record.content === 'string' ? record.content : stdout,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          ...(isError ? { isError: true } : {}),
        }
      : undefined
  return {
    toolData: canonicalData ?? { stdout, stderr, interrupted },
    shellOut: { stdout, stderr, interrupted },
  }
}

// Pattern for code blocks: ```! command ```
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

// Pattern for inline: !`command`
// Uses a positive lookbehind to require whitespace or start-of-line before !
// This prevents false matches inside markdown inline code spans like `!!` or
// adjacent spans like `foo`!`bar`, and shell variables like $!
// eslint-disable-next-line custom-rules/no-lookbehind-regex -- gated by text.includes('!`') below (PR#22986)
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm

/**
 * Parses prompt text and executes any embedded shell commands.
 * Supports two syntaxes:
 * - Code blocks: ```! command ```
 * - Inline: !`command`
 *
 * @param shell - Shell to route commands through. Defaults to bash.
 *   This is *never* read from settings.defaultShell — it comes from .md
 *   frontmatter (author's choice) or is undefined for built-in commands.
 *   See docs/design/ps-shell-selection.md §5.3.
 */
export async function executeShellCommandsInPrompt(
  text: string,
  context: ToolUseContext,
  slashCommandName: string,
  shell?: FrontmatterShell,
): Promise<string> {
  let result = text

  // Resolve the tool once. `shell === undefined` and `shell === 'bash'` both
  // hit BashTool. PowerShell only when the runtime gate allows — a skill
  // author's frontmatter choice doesn't override the user's opt-in/out.
  const shellTool: PromptShellTool =
    shell === 'powershell' && isPowerShellToolEnabled()
      ? getPowerShellTool()
      : CanonicalBashTool as PromptShellTool

  // INLINE_PATTERN's lookbehind is ~100x slower than BLOCK_PATTERN on large
  // skill content (265µs vs 2µs @ 17KB). 93% of skills have no !` at all,
  // so gate the expensive scan on a cheap substring check. BLOCK_PATTERN
  // (```!) doesn't require !` in the text, so it's always scanned.
  const blockMatches = text.matchAll(BLOCK_PATTERN)
  const inlineMatches = text.includes('!`') ? text.matchAll(INLINE_PATTERN) : []

  await Promise.all(
    [...blockMatches, ...inlineMatches].map(async match => {
      const command = match[1]?.trim()
      if (command) {
        try {
          // Check permissions before executing
          const permissionResult = await hasPermissionsToUseTool(
            shellTool,
            { command },
            context,
            createAssistantMessage({ content: [] }),
            '',
          )

          if (permissionResult.behavior !== 'allow') {
            logForDebugging(
              `Shell command permission check failed for command in ${slashCommandName}: ${command}. Error: ${permissionResult.message}`,
            )
            throw new MalformedCommandError(
              `Shell command permission check failed for pattern "${match[0]}": ${permissionResult.message || 'Permission denied'}`,
            )
          }

          const { data } = await shellTool.call({ command }, context)
          const { toolData, shellOut } = normalizeShellToolData(data)
          // Reuse the same persistence flow as regular Bash tool calls
          const toolResultBlock = await processToolResultBlock(
            shellTool,
            toolData,
            randomUUID(),
          )
          // Extract the string content from the block
          const output =
            typeof toolResultBlock.content === 'string'
              ? toolResultBlock.content
              : formatBashOutput(
                  shellOut.stdout,
                  shellOut.stderr,
                )
          // Function replacer — String.replace interprets $$, $&, $`, $' in
          // the replacement string even with a string search pattern. Shell
          // output (especially PowerShell: $env:PATH, $$, $PSVersionTable)
          // is arbitrary user data; a bare string arg would corrupt it.
          result = result.replace(match[0], () => output)
        } catch (e) {
          if (e instanceof MalformedCommandError) {
            throw e
          }
          formatBashError(e, match[0])
        }
      }
    }),
  )

  return result
}

function formatBashOutput(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  inline = false,
): string {
  const normalizedStdout = typeof stdout === 'string' ? stdout : ''
  const normalizedStderr = typeof stderr === 'string' ? stderr : ''
  const parts: string[] = []

  if (normalizedStdout.trim()) {
    parts.push(normalizedStdout.trim())
  }

  if (normalizedStderr.trim()) {
    if (inline) {
      parts.push(`[stderr: ${normalizedStderr.trim()}]`)
    } else {
      parts.push(`[stderr]\n${normalizedStderr.trim()}`)
    }
  }

  return parts.join(inline ? ' ' : '\n')
}

function formatBashError(e: unknown, pattern: string, inline = false): never {
  if (e instanceof ShellError) {
    if (e.interrupted) {
      throw new MalformedCommandError(
        `Shell command interrupted for pattern "${pattern}": [Command interrupted]`,
      )
    }
    const output = formatBashOutput(e.stdout, e.stderr, inline)
    throw new MalformedCommandError(
      `Shell command failed for pattern "${pattern}": ${output}`,
    )
  }

  const message = errorMessage(e)
  const formatted = inline ? `[Error: ${message}]` : `[Error]\n${message}`
  throw new MalformedCommandError(formatted)
}
