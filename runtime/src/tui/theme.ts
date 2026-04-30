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
import type { Color } from "./ink/styles.js";

/**
 * Shape of the theme exposed to the TUI. The structure is stable so Wave
 * 4 components can rely on it; concrete values may swap based on whether
 * the watch primitives resolve.
 */
export type Theme = {
  readonly colors: {
    readonly primary: Color;
    readonly secondary: Color;
    readonly accent: Color;
    readonly error: Color;
    readonly warning: Color;
    readonly success: Color;
    readonly dim: Color;
    readonly ink: Color;
    readonly muted: Color;
    readonly info: Color;
    readonly line: Color;
    readonly lineStrong: Color;
    readonly surface: Color;
    readonly surfaceAlt: Color;
    readonly modeDefault: Color;
    readonly modeAcceptEdits: Color;
    readonly modePlan: Color;
    readonly modeBypass: Color;
    readonly modeAuto: Color;
    readonly suggestion: Color;
    readonly selectionBg: Color;
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
 *
 * AgenC cyberpunk palette: neon-on-void. Magenta-violet-rose family with
 * crimson reserved for danger semantics. Surfaces are near-true-black with
 * a faint purple cast so neon accents glow rather than scream.
 */
const AGENC_BRAND = Object.freeze({
  fuchsia: "rgb(217,70,239)",
  periwinkle: "rgb(167,139,250)",
  frost: "rgb(192,132,252)",
  ink: "rgb(245,243,255)",
  slateViolet: "rgb(156,163,175)",
  deepSlate: "rgb(71,85,105)",
  void: "rgb(5,2,8)",
  voidLifted: "rgb(15,8,23)",
  deepViolet: "rgb(76,29,149)",
  crimson: "rgb(255,0,60)",
  rose: "rgb(251,113,133)",
});

const DEFAULT_THEME: Theme = Object.freeze({
  colors: Object.freeze({
    primary: AGENC_BRAND.fuchsia,
    secondary: AGENC_BRAND.periwinkle,
    accent: AGENC_BRAND.fuchsia,
    error: AGENC_BRAND.crimson,
    warning: AGENC_BRAND.rose,
    success: AGENC_BRAND.frost,
    dim: AGENC_BRAND.deepSlate,
    ink: AGENC_BRAND.ink,
    muted: AGENC_BRAND.slateViolet,
    info: AGENC_BRAND.periwinkle,
    line: AGENC_BRAND.deepViolet,
    lineStrong: AGENC_BRAND.periwinkle,
    surface: AGENC_BRAND.void,
    surfaceAlt: AGENC_BRAND.voidLifted,
    modeDefault: AGENC_BRAND.periwinkle,
    modeAcceptEdits: AGENC_BRAND.frost,
    modePlan: AGENC_BRAND.fuchsia,
    modeBypass: AGENC_BRAND.crimson,
    modeAuto: AGENC_BRAND.rose,
    suggestion: AGENC_BRAND.frost,
    selectionBg: "rgb(180, 213, 255)",
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

const NAMED_COLOR_MAP: Readonly<Record<string, Color>> = Object.freeze({
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

function normalizeColor(input: unknown, fallback: Color): Color {
  if (typeof input !== "string" || input.length === 0) return fallback;
  if (
    input.startsWith("ansi:") ||
    input.startsWith("ansi256(") ||
    input.startsWith("rgb(") ||
    input.startsWith("#")
  ) {
    return input as Color;
  }

  const named = NAMED_COLOR_MAP[input];
  if (named !== undefined) return named;

  const indexed = ANSI_256_RE.exec(input);
  if (indexed !== null) {
    const value = Number(indexed[1]);
    if (Number.isFinite(value)) return `ansi256(${value})`;
  }

  const rgb = ANSI_RGB_RE.exec(input);
  if (rgb !== null) {
    const red = Number(rgb[1]);
    const green = Number(rgb[2]);
    const blue = Number(rgb[3]);
    if (Number.isFinite(red) && Number.isFinite(green) && Number.isFinite(blue)) {
      return `rgb(${red},${green},${blue})`;
    }
  }

  return fallback;
}

function buildTheme(primitives: WatchPrimitivesModule | null): Theme {
  const color = primitives?.color ?? {};
  return Object.freeze({
    colors: Object.freeze({
      primary: normalizeColor(
        color["agencFuchsia"],
        DEFAULT_THEME.colors.primary,
      ),
      secondary: normalizeColor(
        color["agencPeriwinkle"],
        DEFAULT_THEME.colors.secondary,
      ),
      accent: normalizeColor(
        color["agencFuchsia"],
        DEFAULT_THEME.colors.accent,
      ),
      error: normalizeColor(
        color["agencCrimson"],
        DEFAULT_THEME.colors.error,
      ),
      warning: normalizeColor(
        color["agencRose"],
        DEFAULT_THEME.colors.warning,
      ),
      success: normalizeColor(
        color["agencFrost"],
        DEFAULT_THEME.colors.success,
      ),
      dim: normalizeColor(
        color["agencDeepSlate"],
        DEFAULT_THEME.colors.dim,
      ),
      ink: normalizeColor(color["agencInk"], DEFAULT_THEME.colors.ink),
      muted: normalizeColor(
        color["agencSlateViolet"],
        DEFAULT_THEME.colors.muted,
      ),
      info: normalizeColor(
        color["agencPeriwinkle"],
        DEFAULT_THEME.colors.info,
      ),
      line: normalizeColor(
        color["agencDeepViolet"],
        DEFAULT_THEME.colors.line,
      ),
      lineStrong: normalizeColor(
        color["agencPeriwinkle"],
        DEFAULT_THEME.colors.lineStrong,
      ),
      surface: normalizeColor(
        color["agencVoid"],
        DEFAULT_THEME.colors.surface,
      ),
      surfaceAlt: normalizeColor(
        color["agencVoidLifted"],
        DEFAULT_THEME.colors.surfaceAlt,
      ),
      modeDefault: normalizeColor(
        color["agencPeriwinkle"],
        DEFAULT_THEME.colors.modeDefault,
      ),
      modeAcceptEdits: normalizeColor(
        color["agencFrost"],
        DEFAULT_THEME.colors.modeAcceptEdits,
      ),
      modePlan: normalizeColor(
        color["agencFuchsia"],
        DEFAULT_THEME.colors.modePlan,
      ),
      modeBypass: normalizeColor(
        color["agencCrimson"],
        DEFAULT_THEME.colors.modeBypass,
      ),
      modeAuto: normalizeColor(
        color["agencRose"],
        DEFAULT_THEME.colors.modeAuto,
      ),
      suggestion: DEFAULT_THEME.colors.suggestion,
      selectionBg: DEFAULT_THEME.colors.selectionBg,
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
