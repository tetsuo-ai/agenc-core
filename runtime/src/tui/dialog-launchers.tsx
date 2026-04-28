/**
 * Dialog launcher infrastructure for AgenC's TUI.
 *
 * Generic helpers that mount a one-off dialog into the live overlay
 * stack and return a `Promise<T>` resolved when the dialog calls its
 * `done` callback. They let imperative code paths (slash commands,
 * keybinding handlers, top-level setup flows) bridge into React without
 * each call site re-implementing the push/pop/resolve dance.
 *
 * Two flavors live here:
 *
 *   - {@link showDialog} — generic mount. The renderer receives a
 *     `done(result)` callback; whatever it passes resolves the
 *     promise. The overlay is popped immediately before resolution so
 *     callers don't see a dialog still on screen during their
 *     `.then(...)`.
 *
 *   - {@link showSetupDialog} — same surface, with a slot reserved for
 *     wrappers (AppStateProvider, KeybindingSetup, etc.) when AgenC
 *     grows them. Today the wrapper is a passthrough — keep the seam
 *     so call sites don't have to migrate later.
 *
 * Plus the higher-level {@link renderAndRun} / {@link exitWithError} /
 * {@link exitWithMessage} helpers re-exported from
 * `./interactive-helpers.js` for ergonomic single-import call sites.
 *
 * Individual `launchX` functions for specific dialogs are intentionally
 * skipped in this batch: their target dialogs (BypassPermissionsModeDialog,
 * AssistantInstallWizard, TerminalSetup, OAuth, BridgeDialog,
 * AutoModeOptIn, ChannelDowngrade, ManagedSettingsSecurity,
 * AwsAuth, agents/*, MCP setup, AutoUpdater) are not part of the AgenC
 * port scope. The shared infrastructure is enough to build them once
 * the underlying dialogs land.
 */

import * as React from 'react'
import { useEffect } from 'react'
import {
  useOverlayStack,
  type OverlayContextValue,
} from './overlay/OverlayProvider.js'

export {
  exitWithError,
  exitWithMessage,
  renderAndRun,
} from './interactive-helpers.js'

/**
 * Generic dialog launcher. Mounts JSX into the overlay stack and
 * returns a promise that resolves once the dialog calls its `done`
 * callback. The overlay is popped before the promise resolves so a
 * follow-up `await` or `.then` chain sees a clean overlay stack.
 */
export function showDialog<T = void>(
  overlay: OverlayContextValue,
  renderer: (done: (result: T) => void) => React.ReactNode,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let id: string | null = null
    const done = (result: T): void => {
      // Pop first so re-entrant launches don't see this overlay still
      // mounted while the resolver runs.
      if (id !== null) {
        try {
          overlay.popOverlay(id)
        } catch {
          // Best-effort.
        }
      }
      resolve(result)
    }
    id = overlay.pushOverlay(renderer(done))
  })
}

/**
 * Hook flavor — call from a React component to access a curried
 * `showDialog`. Useful when the launch site already has a hook scope.
 */
export function useDialogLauncher() {
  const overlay = useOverlayStack()
  return React.useMemo(
    () => ({
      showDialog: <T,>(
        renderer: (done: (result: T) => void) => React.ReactNode,
      ) => showDialog<T>(overlay, renderer),
      showSetupDialog: <T,>(
        renderer: (done: (result: T) => void) => React.ReactNode,
      ) => showSetupDialog<T>(overlay, renderer),
    }),
    [overlay],
  )
}

/**
 * Show a setup dialog. Today this is a passthrough over
 * {@link showDialog}; the seam is preserved so future wrappers
 * (state providers, keybinding scopes) can be inserted in one place.
 */
export function showSetupDialog<T = void>(
  overlay: OverlayContextValue,
  renderer: (done: (result: T) => void) => React.ReactNode,
): Promise<T> {
  return showDialog<T>(overlay, (done) => (
    <SetupWrapper>{renderer(done)}</SetupWrapper>
  ))
}

/**
 * Setup-dialog wrapper slot. Currently a passthrough so all setup
 * dialogs share an extension point. When AgenC needs scoped state
 * providers around setup screens (e.g. an isolated keybinding scope),
 * add them here.
 */
function SetupWrapper({
  children,
}: {
  readonly children: React.ReactNode
}): React.ReactElement {
  return <>{children}</>
}

/**
 * Imperative bridge: mount JSX into a known overlay context without a
 * surrounding component scope. Equivalent to {@link showDialog} but
 * convenient for top-level boot code that already holds an
 * {@link OverlayContextValue}. Returns a teardown closure so the caller
 * can dismiss the overlay early (e.g. on global cancel).
 */
export function mountOverlay(
  overlay: OverlayContextValue,
  node: React.ReactNode,
): () => void {
  const id = overlay.pushOverlay(node)
  return () => {
    try {
      overlay.popOverlay(id)
    } catch {
      // Best-effort on teardown.
    }
  }
}

/**
 * Convenience component: mounts an effect-only overlay (no children)
 * and forwards a `done` callback. Lets call sites describe a dialog
 * lifecycle declaratively from inside a React tree without manually
 * juggling `useEffect` cleanup.
 */
export function OverlaySlot({
  render,
  onDone,
}: {
  readonly render: (done: () => void) => React.ReactNode
  readonly onDone: () => void
}): null {
  const overlay = useOverlayStack()
  useEffect(() => {
    let dismissed = false
    const id = overlay.pushOverlay(
      render(() => {
        if (dismissed) return
        dismissed = true
        try {
          overlay.popOverlay(id)
        } catch {
          // Best-effort.
        }
        onDone()
      }),
    )
    return () => {
      if (dismissed) return
      dismissed = true
      try {
        overlay.popOverlay(id)
      } catch {
        // Best-effort.
      }
    }
    // We intentionally re-mount only when the overlay context identity
    // changes; render/onDone are captured per push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay])
  return null
}
