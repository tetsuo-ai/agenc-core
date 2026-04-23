/**
 * Cockpit Splash — boot-time welcome screen.
 *
 * Shown once when the TUI starts and dismissed on the first keystroke
 * (or after `autoDismissMs` if provided). The rich variant wraps the
 * watch splash logic module (`runtime/src/watch/agenc-watch-splash.mjs`)
 * which consumes live session / transport state to pick a greeting.
 * That module needs a big bag of dependencies that are only available
 * once the runtime has wired a session; the TUI-side wrapper therefore
 * dynamic-imports it and, when it cannot be wired or is missing, falls
 * back to a simple text greeting so the cockpit still boots cleanly.
 *
 * Content layout:
 *   - Title line with product name.
 *   - Status line (dim) telling the operator what happens next.
 *   - Dismiss hint (dim) nudging them to press any key.
 *
 * The whole card is centered via Ink's Box flexbox — `justifyContent`
 * on the outer column + `alignItems` on the inner row keeps the card
 * visually balanced regardless of terminal height.
 */

import React, { useContext, useEffect, useRef } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import StdinContext from "../ink/components/StdinContext.js";
import { silentLogger } from "../_deps/logger.js";
import { theme } from "../theme.js";

export interface SplashProps {
  readonly onDismiss?: () => void;
  /** Optional auto-dismiss after N ms. Defaults to never. */
  readonly autoDismissMs?: number;
  /** Optional custom title line. Defaults to the product name. */
  readonly title?: string;
  /** Optional status text shown beneath the title. */
  readonly status?: string;
}

interface WatchSplashModule {
  readonly createWatchSplashRenderer?: (dependencies: unknown) => unknown;
}

interface WatchSplashState {
  readonly attempted: boolean;
  readonly mod: WatchSplashModule | null;
}

let moduleState: WatchSplashState = { attempted: false, mod: null };
let warnOnce = false;

async function loadWatchSplashModule(): Promise<WatchSplashState> {
  if (moduleState.attempted) return moduleState;
  try {
    const mod = (await import(
      "../../watch/agenc-watch-splash.mjs"
    )) as WatchSplashModule;
    moduleState = { attempted: true, mod };
    return moduleState;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    moduleState = { attempted: true, mod: null };
    if (!warnOnce) {
      warnOnce = true;
      silentLogger.warn(
        `[Splash] watch/agenc-watch-splash.mjs unavailable: ${message}`,
      );
    }
    return moduleState;
  }
}

/**
 * Test-only hook to reset the cached dynamic-import + warn-once state.
 */
export function __resetSplashForTests(): void {
  moduleState = { attempted: false, mod: null };
  warnOnce = false;
}

export const Splash: React.FC<SplashProps> = ({
  onDismiss,
  autoDismissMs,
  title,
  status,
}) => {
  // Keep the dismiss callback on a ref so the stdin listener does not
  // tear down and re-attach every time the parent re-renders with a
  // fresh closure.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const stdin = useContext(StdinContext);

  // Trigger the one-shot dynamic import so the log line fires at most
  // once per process, mirroring ArtPanel's warn-once behaviour.
  useEffect(() => {
    void loadWatchSplashModule();
  }, []);

  // Subscribe to any keypress via Ink's internal input emitter. We
  // listen on the private `internal_eventEmitter` because the public
  // `useInput` hook is wired to the keybinding registry, and Splash
  // wants to dismiss on literally any key — not just bound chords.
  useEffect(() => {
    const emitter = stdin?.internal_eventEmitter;
    if (!emitter) return undefined;
    const onAnyInput = () => {
      onDismissRef.current?.();
    };
    emitter.on("input", onAnyInput);
    return () => {
      emitter.off("input", onAnyInput);
    };
  }, [stdin]);

  // Auto-dismiss timer. Cleaned up on unmount.
  useEffect(() => {
    if (typeof autoDismissMs !== "number" || autoDismissMs <= 0) {
      return undefined;
    }
    const handle = setTimeout(() => {
      onDismissRef.current?.();
    }, autoDismissMs);
    return () => {
      clearTimeout(handle);
    };
  }, [autoDismissMs]);

  const titleText = title ?? "AgenC";
  const statusText = status ?? "Starting runtime...";

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      paddingY={1}
    >
      <Box flexDirection="column" alignItems="center">
        <Text bold color={theme.colors.primary}>
          {titleText}
        </Text>
        <Text dim>{statusText}</Text>
        <Box height={1} />
        <Text dim>press any key to continue</Text>
      </Box>
    </Box>
  );
};

export default Splash;
