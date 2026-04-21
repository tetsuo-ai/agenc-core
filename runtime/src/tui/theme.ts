/**
 * AgenC TUI theme.
 *
 * Pulls its palette from the watch primitives module that ships with the
 * runtime (`runtime/src/watch/agenc-watch-ui-primitives.mjs`). The watch
 * primitives are loaded lazily so this module stays usable when the
 * watch/ directory is stripped (e.g. in trimmed CI artifacts). When the
 * primitives are missing the frozen `DEFAULT_THEME` below is returned.
 *
 * Everything exported here is read-only. Consumers that need to mutate
 * a local copy should spread into their own object.
 */

import type { PermissionMode } from "../permissions/types.js";

/**
 * Shape of the theme exposed to the TUI. The structure is stable so Wave
 * 4 components can rely on it; concrete values may swap based on whether
 * the watch primitives resolve.
 */
export type Theme = {
  readonly colors: {
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
    readonly error: string;
    readonly warning: string;
    readonly success: string;
    readonly dim: string;
    readonly modeDefault: string;
    readonly modeAcceptEdits: string;
    readonly modePlan: string;
    readonly modeBypass: string;
    readonly modeAuto: string;
  };
  readonly border: {
    readonly soft: string;
    readonly strong: string;
  };
  readonly spacing: {
    readonly tight: number;
    readonly normal: number;
    readonly loose: number;
  };
  readonly modeIndicatorChar: Readonly<Record<PermissionMode, string>>;
};

/**
 * Fallback theme. Active when `runtime/src/watch/` is not reachable from
 * the running process (stripped CI artifact, unusual install layout,
 * etc.) and when primitives loading throws.
 */
const DEFAULT_THEME: Theme = Object.freeze({
  colors: Object.freeze({
    primary: "cyan",
    secondary: "magenta",
    accent: "yellow",
    error: "red",
    warning: "yellow",
    success: "green",
    dim: "gray",
    modeDefault: "cyan",
    modeAcceptEdits: "green",
    modePlan: "magenta",
    modeBypass: "red",
    modeAuto: "yellow",
  }) as Theme["colors"],
  border: Object.freeze({
    soft: "single",
    strong: "double",
  }) as Theme["border"],
  spacing: Object.freeze({
    tight: 0,
    normal: 1,
    loose: 2,
  }) as Theme["spacing"],
  modeIndicatorChar: Object.freeze({
    default: "›",
    acceptEdits: "»",
    plan: "◆",
    bypassPermissions: "⚠",
    dontAsk: "…",
    auto: "∞",
    bubble: "·",
  }) as Readonly<Record<PermissionMode, string>>,
}) as Theme;

/**
 * Narrow the shape of what we actually read off the watch primitives
 * module. Nothing in here is required — missing keys fall back to the
 * default palette silently.
 */
type WatchPrimitivesModule = {
  readonly color?: Record<string, unknown>;
};

let cachedTheme: Theme | null = null;
let loadAttempted = false;

function coerceAnsi(input: unknown, fallback: string): string {
  return typeof input === "string" && input.length > 0 ? input : fallback;
}

function buildTheme(primitives: WatchPrimitivesModule | null): Theme {
  const color = primitives?.color ?? {};
  return Object.freeze({
    colors: Object.freeze({
      primary: coerceAnsi(
        color["cyan"],
        DEFAULT_THEME.colors.primary,
      ),
      secondary: coerceAnsi(
        color["magenta"],
        DEFAULT_THEME.colors.secondary,
      ),
      accent: coerceAnsi(
        color["amber"],
        DEFAULT_THEME.colors.accent,
      ),
      error: coerceAnsi(color["red"], DEFAULT_THEME.colors.error),
      warning: coerceAnsi(color["yellow"], DEFAULT_THEME.colors.warning),
      success: coerceAnsi(color["green"], DEFAULT_THEME.colors.success),
      dim: coerceAnsi(color["fog"], DEFAULT_THEME.colors.dim),
      modeDefault: coerceAnsi(color["cyan"], DEFAULT_THEME.colors.modeDefault),
      modeAcceptEdits: coerceAnsi(
        color["green"],
        DEFAULT_THEME.colors.modeAcceptEdits,
      ),
      modePlan: coerceAnsi(
        color["magenta"],
        DEFAULT_THEME.colors.modePlan,
      ),
      modeBypass: coerceAnsi(color["red"], DEFAULT_THEME.colors.modeBypass),
      modeAuto: coerceAnsi(color["yellow"], DEFAULT_THEME.colors.modeAuto),
    }) as Theme["colors"],
    border: Object.freeze({
      soft: coerceAnsi(color["border"], DEFAULT_THEME.border.soft),
      strong: coerceAnsi(
        color["borderStrong"],
        DEFAULT_THEME.border.strong,
      ),
    }) as Theme["border"],
    spacing: DEFAULT_THEME.spacing,
    modeIndicatorChar: DEFAULT_THEME.modeIndicatorChar,
  }) as Theme;
}

/**
 * Synchronous accessor used by UI code. Returns the fallback theme until
 * {@link loadTheme} has resolved (or immediately thereafter).
 */
export function getTheme(): Theme {
  return cachedTheme ?? DEFAULT_THEME;
}

/**
 * Trigger a one-time lazy load of the watch primitives module. Safe to
 * call repeatedly — the first invocation resolves everything and later
 * invocations are cheap. Errors fall through to `DEFAULT_THEME` and are
 * not re-thrown.
 */
export async function loadTheme(): Promise<Theme> {
  if (cachedTheme !== null) return cachedTheme;
  if (loadAttempted) return cachedTheme ?? DEFAULT_THEME;
  loadAttempted = true;
  try {
    const mod = (await import(
      "../watch/agenc-watch-ui-primitives.mjs"
    )) as WatchPrimitivesModule;
    cachedTheme = buildTheme(mod);
  } catch {
    cachedTheme = DEFAULT_THEME;
  }
  return cachedTheme;
}

/**
 * Reset internal caches. Intended for tests that need to exercise the
 * fallback path without tearing down the process.
 */
export function __resetThemeForTests(): void {
  cachedTheme = null;
  loadAttempted = false;
}

/**
 * Frozen proxy exposing the currently loaded theme. Importers can
 * destructure `theme.colors.primary` etc. without awaiting
 * `loadTheme()` — they'll receive the default palette until the watch
 * primitives resolve.
 */
export const theme: Theme = new Proxy(DEFAULT_THEME, {
  get(_target, property) {
    const active = getTheme();
    return (active as unknown as Record<string | symbol, unknown>)[property];
  },
}) as Theme;
