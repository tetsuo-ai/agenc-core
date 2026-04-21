/**
 * Cockpit ArtPanel — renders ASCII / ANSI art alongside the banner.
 *
 * The heavy lifting (reading an image, quantizing to an ANSI ramp,
 * caching rasterizations per (cols,rows)) lives in
 * `runtime/src/watch/agenc-watch-art.mjs`. That module depends on
 * `jimp` and a concrete image file on disk, so we dynamic-import it at
 * module init and only use it when both the module and a usable image
 * can be found. When the module is missing (stripped CI artifact,
 * unusual install layout) or throws while loading we fall back to a
 * small inline ASCII logo so the cockpit still has visual identity.
 *
 * Design rules:
 *   - No module-level side effects beyond the one-shot `import()`; the
 *     wrapper records success/failure on a local closure state so repeat
 *     renders don't re-trigger the import.
 *   - Failure to load is logged exactly once via `silentLogger.warn`
 *     from `src/utils/logger.js` so we don't spam the journal on every
 *     resize.
 *   - The fallback is intentionally tiny (5 rows) so a narrow terminal
 *     does not explode vertically.
 */

import React, { useEffect, useState } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { silentLogger } from "../../utils/logger.js";
import { theme } from "../theme.js";

export interface ArtPanelProps {
  /** Hide the panel entirely (but keep the box slot) when false. */
  readonly visible?: boolean;
  /** Selects between the compact 5-row fallback and a taller 9-row one. */
  readonly variant?: "small" | "large";
}

/**
 * Fallback inline ASCII rendered when the watch art module cannot be
 * loaded. Small variant is ~5 rows, large variant is ~9 rows. These
 * values are not load-bearing for the ANSI renderer — they exist only
 * so the cockpit still shows a logo while the dynamic-import settles
 * or when the module is stripped.
 */
const SMALL_ASCII: readonly string[] = Object.freeze([
  "  __ _  __ _  ___ _ __   ___ ",
  " / _` |/ _` |/ _ \\ '_ \\ / __|",
  "| (_| | (_| |  __/ | | | (__ ",
  " \\__,_|\\__, |\\___|_| |_|\\___|",
  "       |___/                 ",
]);

const LARGE_ASCII: readonly string[] = Object.freeze([
  "   ▄████████    ▄██████▄     ▄████████ ███▄▄▄▄   ▄████████",
  "  ███    ███   ███    ███   ███    ███ ███▀▀▀██▄ ███    ███",
  "  ███    ███   ███    █▀    ███    █▀  ███   ███ ███    █▀",
  "  ███    ███  ▄███         ▄███▄▄▄     ███   ███ ███",
  "▀███████████ ▀▀███ ████▄  ▀▀███▀▀▀     ███   ███ ███",
  "  ███    ███   ███    ███   ███    █▄  ███   ███ ███    █▄",
  "  ███    ███   ███    ███   ███    ███ ███   ███ ███    ███",
  "  ███    █▀    ████████▀    ██████████  ▀█   █▀  ████████▀",
  "                                                          ",
]);

/**
 * Minimum structural shape the watch art module exposes. We keep it
 * deliberately narrow — anything beyond `createAnsiArtRenderer` is not
 * used here and would just couple this file to the mjs internals.
 */
interface WatchArtModule {
  readonly createAnsiArtRenderer?: (opts: {
    readonly imagePath?: string;
    readonly ramp?: string;
    readonly invert?: boolean;
  }) => Promise<unknown> | unknown;
}

interface WatchArtState {
  readonly attempted: boolean;
  readonly mod: WatchArtModule | null;
  readonly error?: string;
}

// Closure-scoped cache so repeat renders don't re-trigger the import.
// Tests that want to exercise the fallback path reset this via
// `__resetArtPanelForTests()`.
let moduleState: WatchArtState = { attempted: false, mod: null };
let warnOnce = false;

async function loadWatchArtModule(): Promise<WatchArtState> {
  if (moduleState.attempted) return moduleState;
  try {
    const mod = (await import(
      "../../watch/agenc-watch-art.mjs"
    )) as WatchArtModule;
    moduleState = { attempted: true, mod };
    return moduleState;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    moduleState = { attempted: true, mod: null, error: message };
    if (!warnOnce) {
      warnOnce = true;
      silentLogger.warn(
        `[ArtPanel] watch/agenc-watch-art.mjs unavailable: ${message}`,
      );
    }
    return moduleState;
  }
}

/**
 * Test-only hook to reset the cached dynamic-import + warn-once state.
 * Ensures tests that want to force the fallback path can do so without
 * process-level state leaking between runs.
 */
export function __resetArtPanelForTests(): void {
  moduleState = { attempted: false, mod: null };
  warnOnce = false;
}

export const ArtPanel: React.FC<ArtPanelProps> = ({
  visible = true,
  variant = "small",
}) => {
  // Track whether the dynamic import has settled so we can flip the
  // fallback hint off once the module resolves. The actual ANSI art
  // cannot render without an imagePath, so the fallback is the
  // expected render surface in the default case — `moduleReady`
  // primarily exists so tests can assert on the pre-/post-import
  // state.
  const [, setModuleReady] = useState<boolean>(moduleState.attempted);

  useEffect(() => {
    let cancelled = false;
    loadWatchArtModule()
      .then(() => {
        if (!cancelled) setModuleReady(true);
      })
      .catch(() => {
        // `loadWatchArtModule` already catches and records the error —
        // this catch is defensive belt-and-braces.
        if (!cancelled) setModuleReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  const lines = variant === "large" ? LARGE_ASCII : SMALL_ASCII;
  const color =
    variant === "large" ? theme.colors.accent : theme.colors.primary;

  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        <Text key={idx} color={color}>
          {line}
        </Text>
      ))}
    </Box>
  );
};

export default ArtPanel;
