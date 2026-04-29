/**
 * Interactive boot helpers for the AgenC TUI.
 *
 * The render-and-exit lifecycle helpers split out of upstream's
 * `interactiveHelpers.tsx`. AgenC owns its own bootstrap path
 * (`tui/main.tsx::bootTUI`); these helpers cover the smaller
 * "render-then-unmount" cases used by one-off setup screens, fatal
 * errors, and short-lived informational outputs that need to render
 * through Ink (`console.error` is swallowed once Ink patches the
 * console).
 *
 * Provided helpers:
 *   - {@link renderAndRun} — render an element and resolve once the
 *     tree exits. Mirrors upstream's signature.
 *   - {@link exitWithError} — render a red error message and exit
 *     non-zero.
 *   - {@link exitWithMessage} — generic render-then-exit, color and
 *     exit code configurable.
 *
 * The Ink root is created on demand via `createRoot` from
 * `tui/ink/root.ts` so callers don't need a live `bootTUI` handle to
 * use these helpers.
 */

import * as React from 'react'
import { Text } from './ink-public.js'
import { createRoot, type Root } from './ink/root.js'
import type { Theme } from './theme.js'

/**
 * Get-or-create an Ink root bound to the given streams. Callers that
 * already hold a `Root` (e.g. from `bootTUI`) can pass it through; the
 * helpers will reuse it instead of creating a new one. Default streams
 * are the live process streams.
 */
async function ensureRoot(root?: Root): Promise<Root> {
  if (root) return root
  return createRoot({
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  })
}

/**
 * Render the given element and resolve once Ink unmounts the tree.
 * Suitable for setup screens that own the entire terminal until the
 * user dismisses them.
 */
export async function renderAndRun(
  element: React.ReactNode,
  root?: Root,
): Promise<void> {
  const target = await ensureRoot(root)
  target.render(element)
  await target.waitUntilExit()
}

/**
 * Render an error message through Ink, unmount, then exit with the
 * given exit code (default 1). Use this for fatal errors after Ink has
 * been mounted — `console.error` is swallowed by Ink's `patchConsole`,
 * so we render through the React tree instead.
 */
export async function exitWithError(
  message: string,
  options?: {
    readonly root?: Root
    readonly exitCode?: number
    readonly beforeExit?: () => Promise<void> | void
    readonly stderr?: NodeJS.WriteStream
  },
): Promise<never> {
  return exitWithMessage(message, {
    color: 'error',
    exitCode: options?.exitCode ?? 1,
    root: options?.root,
    beforeExit: options?.beforeExit,
    stderr: options?.stderr,
  })
}

export interface ExitWithMessageOptions {
  readonly color?: keyof Theme['colors']
  readonly exitCode?: number
  readonly root?: Root
  readonly beforeExit?: () => Promise<void> | void
  /**
   * Optional stderr stream — when provided, the message is also
   * written there in plain text after Ink unmounts. Useful for CI
   * logs that capture stderr but not the TTY frame.
   */
  readonly stderr?: NodeJS.WriteStream
}

/**
 * Render `message` via Ink, wait for the next paint to flush, unmount,
 * await any caller cleanup, and then `process.exit`. Returns `never`
 * but is async so callers can `await` ordering with other shutdown
 * work.
 */
export async function exitWithMessage(
  message: string,
  options?: ExitWithMessageOptions,
): Promise<never> {
  const root = await ensureRoot(options?.root)
  const exitCode = options?.exitCode ?? 1
  const color = options?.color
  root.render(
    color ? <Text color={color}>{message}</Text> : <Text>{message}</Text>,
  )
  // Give Ink a microtask to flush the frame before unmount.
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve)
  })
  try {
    root.unmount()
  } catch {
    // Ink may have torn itself down.
  }
  if (options?.stderr) {
    try {
      options.stderr.write(`${message}\n`)
    } catch {
      // Stderr may itself be half-dead.
    }
  }
  if (options?.beforeExit) {
    try {
      await options.beforeExit()
    } catch {
      // Best-effort cleanup.
    }
  }
  // eslint-disable-next-line no-restricted-syntax -- exit after Ink unmount
  process.exit(exitCode) as never
  // Help TS understand exit doesn't return.
  throw new Error('unreachable')
}
