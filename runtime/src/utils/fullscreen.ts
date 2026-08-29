import { spawnSync } from 'child_process'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

let loggedTmuxCcDisable = false

/**
 * Cached result from `tmux display-message -p '#{client_control_mode}'`.
 * undefined = not yet queried (or probe failed) — env heuristic stays authoritative.
 */
let tmuxControlModeProbed: boolean | undefined

/**
 * Env-var heuristic for iTerm2's tmux integration mode (`tmux -CC` / `tmux -2CC`).
 *
 * In `-CC` mode, iTerm2 renders tmux panes as native splits — tmux runs
 * as a server (TMUX is set) but iTerm2 is the actual terminal emulator
 * for each pane, so TERM_PROGRAM stays `iTerm.app` and TERM is iTerm2's
 * default (xterm-*). Contrast with regular tmux-inside-iTerm2, where tmux
 * overwrites TERM_PROGRAM to `tmux` and sets TERM to screen-* or tmux-*.
 *
 * This heuristic has known holes (SSH often doesn't propagate TERM_PROGRAM;
 * .tmux.conf can override TERM) — probeTmuxControlModeSync() is the
 * authoritative backstop. Kept as a zero-subprocess fast path.
 */
function isTmuxControlModeEnvHeuristic(): boolean {
  if (!process.env.TMUX) return false
  if (process.env.TERM_PROGRAM !== 'iTerm.app') return false
  // Belt-and-suspenders: in regular tmux TERM is screen-* or tmux-*;
  // in -CC mode iTerm2 sets its own TERM (xterm-*).
  const term = process.env.TERM ?? ''
  return !term.startsWith('screen') && !term.startsWith('tmux')
}

/**
 * Sync one-shot probe: asks tmux directly whether this client is in control
 * mode via `#{client_control_mode}`. Runs on first isTmuxControlMode() call
 * when the env heuristic can't decide; result is cached.
 *
 * Sync (spawnSync) because the answer gates whether we enter fullscreen — an
 * async probe raced against React render and lost: coder-tmux (ssh → tmux -CC
 * on a remote box) doesn't propagate TERM_PROGRAM, so the env heuristic missed,
 * and by the time the async probe resolved we'd already entered alt-screen with
 * mouse tracking enabled. Mouse wheel is dead in iTerm2's -CC integration, so
 * users couldn't scroll at all.
 *
 * Cost: one ~5ms subprocess, only when $TMUX is set AND $TERM_PROGRAM is unset
 * (the SSH-into-tmux case). Local iTerm2 -CC and non-tmux paths skip the spawn.
 *
 * The TMUX env check MUST come first — without it, display-message would
 * query whatever tmux server happens to be running rather than our client.
 */
function probeTmuxControlModeSync(): void {
  // Seed cache with heuristic result so early returns below don't leave it
  // undefined — isTmuxControlMode() is called 15+ times per render, and an
  // undefined cache would re-enter this function (re-spawning tmux in the
  // failure case) on every call.
  tmuxControlModeProbed = isTmuxControlModeEnvHeuristic()
  if (tmuxControlModeProbed) return
  if (!process.env.TMUX) return
  // Only probe when iTerm might be involved: TERM_PROGRAM is iTerm.app
  // (covered above) or not set (SSH often doesn't propagate it). When
  // TERM_PROGRAM is explicitly a non-iTerm terminal, skip — tmux -CC is
  // an iTerm-only feature, so the subprocess would be wasted.
  if (process.env.TERM_PROGRAM) return
  let result
  try {
    result = spawnSync(
      'tmux',
      ['display-message', '-p', '#{client_control_mode}'],
      { encoding: 'utf8', timeout: 2000 },
    )
  } catch {
    // spawnSync can throw on some platforms (e.g. ENOENT on Windows if tmux
    // is absent and the runtime surfaces it as an exception rather than in
    // result.error). Treat the same as a non-zero exit.
    return
  }
  // Non-zero exit / spawn error: tmux too old (format var added in 2.4) or
  // unavailable. Keep the heuristic result cached.
  if (result.status !== 0) return
  tmuxControlModeProbed = result.stdout.trim() === '1'
}

/**
 * True when running under `tmux -CC` (iTerm2 integration mode).
 *
 * The alt-screen / mouse-tracking path in fullscreen mode is unrecoverable
 * in -CC mode (double-click corrupts terminal state; mouse wheel is dead),
 * so callers auto-disable fullscreen.
 *
 * Lazily probes tmux on first call when the env heuristic can't decide.
 */
export function isTmuxControlMode(): boolean {
  if (tmuxControlModeProbed === undefined) probeTmuxControlModeSync()
  return tmuxControlModeProbed ?? false
}

export function _resetTmuxControlModeProbeForTesting(): void {
  tmuxControlModeProbed = undefined
  loggedTmuxCcDisable = false
}

export type FullscreenTerminalEnvironment = Readonly<
  Partial<
    Pick<
      NodeJS.ProcessEnv,
      'AGENC_NO_FLICKER' | 'TMUX' | 'TERM_PROGRAM' | 'TERM'
    >
  >
>

export type FullscreenResolutionInput = {
  readonly environmentOverride: boolean | undefined
  readonly tmuxControlMode: boolean
  readonly configuredPreference: boolean | undefined
}

/** Parse the terminal-local environment override without reading settings. */
export function readFullscreenEnvironmentOverride(
  env: Pick<FullscreenTerminalEnvironment, 'AGENC_NO_FLICKER'>,
): boolean | undefined {
  if (isEnvDefinedFalsy(env.AGENC_NO_FLICKER)) return false
  if (isEnvTruthy(env.AGENC_NO_FLICKER)) return true
  return undefined
}

/**
 * Resolve the active fullscreen mode from explicit inputs.
 *
 * Priority order:
 *   AGENC_NO_FLICKER=0  → always off
 *   AGENC_NO_FLICKER=1  → always on (overrides tmux -CC guard too)
 *   tmux -CC detected   → off (corrupts terminal state)
 *   configured setting → on/off per user preference
 *   default             → on
 *
 * This function is deliberately pure: the caller owns environment, terminal,
 * and configuration authority.
 */
export function resolveFullscreenEnabled({
  environmentOverride,
  tmuxControlMode,
  configuredPreference,
}: FullscreenResolutionInput): boolean {
  if (environmentOverride !== undefined) return environmentOverride
  if (tmuxControlMode) return false
  return configuredPreference ?? true
}

/**
 * Bind the local terminal detector to an explicit configuration preference.
 * This is the only impure fullscreen adapter: it reads process environment
 * and may run the cached tmux control-mode probe, but never reads settings.
 */
export function isFullscreenEnabledForCurrentTerminal(
  configuredPreference: boolean | undefined,
): boolean {
  const environmentOverride = readFullscreenEnvironmentOverride(process.env)
  // Preserve the existing short-circuit: an explicit env value never probes
  // tmux, and an explicit opt-in overrides tmux control mode.
  const tmuxControlMode =
    environmentOverride === undefined ? isTmuxControlMode() : false
  const enabled = resolveFullscreenEnabled({
    environmentOverride,
    tmuxControlMode,
    configuredPreference,
  })

  if (
    !enabled &&
    environmentOverride === undefined &&
    tmuxControlMode &&
    !loggedTmuxCcDisable
  ) {
    loggedTmuxCcDisable = true
    logForDebugging(
      'fullscreen disabled: tmux -CC (iTerm2 integration mode) detected · set AGENC_NO_FLICKER=1 to override',
    )
  }

  return enabled
}

/**
 * Whether fullscreen mode should enable SGR mouse tracking (DEC 1000/1002/1006).
 * Set AGENC_DISABLE_MOUSE=1 to keep alt-screen + virtualized scroll
 * (keyboard PgUp/PgDn/Ctrl+Home/End still work) but skip mouse capture,
 * so tmux/kitty/terminal-native copy-on-select keeps working.
 *
 * Compare with AGENC_NO_FLICKER=0 which is all-or-nothing — it also
 * disables alt-screen and virtualized scrollback.
 */
export function isMouseTrackingEnabled(): boolean {
  return !isEnvTruthy(process.env.AGENC_DISABLE_MOUSE)
}

/**
 * Whether mouse click handling is disabled (clicks/drags ignored, wheel still
 * works). Set AGENC_DISABLE_MOUSE_CLICKS=1 to prevent accidental clicks
 * from triggering cursor positioning, text selection, or message expansion.
 *
 * Fullscreen-specific — only reachable when AGENC_NO_FLICKER is active.
 */
export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.AGENC_DISABLE_MOUSE_CLICKS)
}
