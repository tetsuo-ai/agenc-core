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
    readonly ink: string;
    readonly muted: string;
    readonly info: string;
    readonly line: string;
    readonly lineStrong: string;
    readonly surface: string;
    readonly surfaceAlt: string;
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
const AGENC_BRAND = Object.freeze({
  accent: "rgb(206,98,50)",
  secondary: "rgb(188,105,225)",
  line: "rgb(87,62,126)",
  lineStrong: "rgb(177,104,255)",
  surface: "rgb(37,31,55)",
  surfaceAlt: "rgb(83,57,111)",
});

const DEFAULT_THEME: Theme = Object.freeze({
  colors: Object.freeze({
    primary: "ansi256(117)",
    secondary: AGENC_BRAND.secondary,
    accent: AGENC_BRAND.accent,
    error: "ansi256(203)",
    warning: "ansi256(221)",
    success: "ansi256(50)",
    dim: "ansi256(97)",
    ink: "ansi256(225)",
    muted: "ansi256(189)",
    info: "ansi256(111)",
    line: AGENC_BRAND.line,
    lineStrong: AGENC_BRAND.lineStrong,
    surface: AGENC_BRAND.surface,
    surfaceAlt: AGENC_BRAND.surfaceAlt,
    modeDefault: "ansi256(117)",
    modeAcceptEdits: "ansi256(50)",
    modePlan: "ansi256(177)",
    modeBypass: "ansi256(203)",
    modeAuto: "ansi256(221)",
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
 * Inputs to {@link modeValueColor}. When the composer wants to also reflect
 * activity (streaming / pending approvals) the caller passes the relevant
 * flags; surfaces that only express mode (e.g., the StatusLine) leave both
 * undefined.
 */
export interface ModeValueColorContext {
  /** Pending approval count — non-zero overrides mode color with `warning`. */
  readonly pendingRequestCount?: number;
  /** Whether the model is currently streaming a response. */
  readonly isStreaming?: boolean;
  /**
   * Theme colors to consult. Caller passes this so renderers can use
   * the same theme instance they already have without re-importing.
   */
  readonly colors: Theme["colors"];
}

/**
 * Single source of truth for "what color should this surface show for the
 * given mode". The StatusLine and Composer leading-glyph render sites
 * consume the same helper so the `◆`/`⚠`/`›` glyph never drifts in color
 * across the UI.
 *
 * Color precedence (highest first):
 *   1. `pendingRequestCount > 0`      → `warning`        (approval pending)
 *   2. mode ∈ {plan, bypass, auto, acceptEdits, bubble} → mode's own token
 *   3. mode === default                → `accent` while streaming, else `primary`
 *
 * Step 1 preserves the existing "approval-pending" affordance — it is
 * the only state worth tinting on top of mode. Step 3 preserves the
 * "ember while thinking" UX *only* in default mode, so non-default modes
 * never get their mode color overwritten by the streaming tint.
 */
export function modeValueColor(
  mode: PermissionMode,
  ctx: ModeValueColorContext,
): string {
  const { colors } = ctx;
  if ((ctx.pendingRequestCount ?? 0) > 0) return colors.warning;
  switch (mode) {
    case "acceptEdits":
      return colors.modeAcceptEdits;
    case "plan":
      return colors.modePlan;
    case "bypassPermissions":
    case "dontAsk":
      return colors.modeBypass;
    case "auto":
      return colors.modeAuto;
    case "bubble":
      return colors.dim;
    case "default":
    default:
      return ctx.isStreaming ? colors.accent : colors.modeDefault;
  }
}

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

const NAMED_COLOR_MAP: Readonly<Record<string, string>> = Object.freeze({
  black: "ansi:black",
  red: "ansi:red",
  green: "ansi:green",
  yellow: "ansi:yellow",
  blue: "ansi:blue",
  magenta: "ansi:magenta",
  cyan: "ansi:cyan",
  white: "ansi:white",
  gray: "ansi:blackBright",
  grey: "ansi:blackBright",
  brightBlack: "ansi:blackBright",
  brightRed: "ansi:redBright",
  brightGreen: "ansi:greenBright",
  brightYellow: "ansi:yellowBright",
  brightBlue: "ansi:blueBright",
  brightMagenta: "ansi:magentaBright",
  brightCyan: "ansi:cyanBright",
  brightWhite: "ansi:whiteBright",
});

const ANSI_256_RE = /^\x1b\[(?:38|48);5;(\d+)m$/;
const ANSI_RGB_RE = /^\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m$/;

function normalizeColor(input: unknown, fallback: string): string {
  if (typeof input !== "string" || input.length === 0) return fallback;
  if (
    input.startsWith("ansi:") ||
    input.startsWith("ansi256(") ||
    input.startsWith("rgb(") ||
    input.startsWith("#")
  ) {
    return input;
  }

  const named = NAMED_COLOR_MAP[input];
  if (named !== undefined) return named;

  const indexed = ANSI_256_RE.exec(input);
  if (indexed !== null) {
    return `ansi256(${indexed[1]})`;
  }

  const rgb = ANSI_RGB_RE.exec(input);
  if (rgb !== null) {
    return `rgb(${rgb[1]},${rgb[2]},${rgb[3]})`;
  }

  return fallback;
}

function buildTheme(primitives: WatchPrimitivesModule | null): Theme {
  const color = primitives?.color ?? {};
  return Object.freeze({
    colors: Object.freeze({
      primary: normalizeColor(
        color["cyan"],
        DEFAULT_THEME.colors.primary,
      ),
      secondary: normalizeColor(
        color["agencPurple"],
        DEFAULT_THEME.colors.secondary,
      ),
      accent: normalizeColor(
        color["agencEmber"],
        DEFAULT_THEME.colors.accent,
      ),
      error: normalizeColor(color["red"], DEFAULT_THEME.colors.error),
      warning: normalizeColor(color["yellow"], DEFAULT_THEME.colors.warning),
      success: normalizeColor(color["green"], DEFAULT_THEME.colors.success),
      dim: normalizeColor(color["fog"], DEFAULT_THEME.colors.dim),
      ink: normalizeColor(color["ink"], DEFAULT_THEME.colors.ink),
      muted: normalizeColor(color["softInk"], DEFAULT_THEME.colors.muted),
      info: normalizeColor(color["teal"], DEFAULT_THEME.colors.info),
      line: normalizeColor(color["border"], DEFAULT_THEME.colors.line),
      lineStrong: normalizeColor(
        color["borderStrong"],
        DEFAULT_THEME.colors.lineStrong,
      ),
      surface: normalizeColor(
        color["agencSurface"],
        DEFAULT_THEME.colors.surface,
      ),
      surfaceAlt: normalizeColor(
        color["agencSurfaceHi"],
        DEFAULT_THEME.colors.surfaceAlt,
      ),
      modeDefault: normalizeColor(color["cyan"], DEFAULT_THEME.colors.modeDefault),
      modeAcceptEdits: normalizeColor(
        color["green"],
        DEFAULT_THEME.colors.modeAcceptEdits,
      ),
      modePlan: normalizeColor(
        color["magenta"],
        DEFAULT_THEME.colors.modePlan,
      ),
      modeBypass: normalizeColor(color["red"], DEFAULT_THEME.colors.modeBypass),
      modeAuto: normalizeColor(color["yellow"], DEFAULT_THEME.colors.modeAuto),
    }) as Theme["colors"],
    border: DEFAULT_THEME.border,
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
