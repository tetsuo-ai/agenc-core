// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import React, { type PropsWithChildren, useContext, useInsertionEffect } from 'react';
import { getInkInstance } from '../instances.js';
import { setDefaultTextColor } from '../render-node-to-output.js';
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../termio/dec.js';
import { TerminalWriteContext } from '../useTerminalNotification.js';
import Box from './Box.js';
import { TerminalSizeContext } from './TerminalSizeContext.js';
type Props = PropsWithChildren<{
  /** Enable SGR mouse tracking (wheel + click/drag). Default true. */
  mouseTracking?: boolean;
  /**
   * Paint the whole viewport with this color so the screen never depends on
   * the terminal's own default background. Unset keeps the terminal default.
   */
  backgroundColor?: string;
  /** Text color for text that sets none, paired with backgroundColor. */
  foregroundColor?: string;
}>;

/**
 * Run children in the terminal's alternate screen buffer, constrained to
 * the viewport height. While mounted:
 *
 * - Enters the alt screen (DEC 1049), clears it, homes the cursor
 * - Constrains its own height to the terminal row count, so overflow must
 *   be handled via `overflow: scroll` / flexbox (no native scrollback)
 * - Optionally enables SGR mouse tracking (wheel + click/drag) — events
 *   surface as `ParsedKey` (wheel) and update the Ink instance's
 *   selection state (click/drag)
 *
 * On unmount, disables mouse tracking and exits the alt screen, restoring
 * the main screen's content. Safe for use in ctrl-o transcript overlays
 * and similar short-lived fullscreen views — the main screen is preserved.
 *
 * Notifies the Ink instance via `setAltScreenActive()` so the renderer
 * keeps the cursor inside the viewport (preventing the cursor-restore LF
 * from scrolling content) and so signal-exit cleanup can exit the alt
 * screen if the component's own unmount doesn't run.
 */
export function AlternateScreen(t0) {
  const $ = _c(8);
  const {
    children,
    mouseTracking: t1,
    backgroundColor,
    foregroundColor
  } = t0;
  // Set before Ink's output pass for this commit, and cleared on unmount so
  // main-screen rendering keeps the terminal's own text color.
  useInsertionEffect(() => {
    setDefaultTextColor(foregroundColor);
    return () => setDefaultTextColor(undefined);
  }, [foregroundColor]);
  const mouseTracking = t1 === undefined ? true : t1;
  const size = useContext(TerminalSizeContext);
  const writeRaw = useContext(TerminalWriteContext);
  let t2;
  let t3;
  if ($[0] !== mouseTracking || $[1] !== writeRaw) {
    t2 = () => {
      const ink = getInkInstance();
      if (!writeRaw) {
        return;
      }
      writeRaw(ENTER_ALT_SCREEN + "\x1B[2J\x1B[H" + (mouseTracking ? ENABLE_MOUSE_TRACKING : ""));
      ink?.setAltScreenActive(true, mouseTracking);
      return () => {
        ink?.setAltScreenActive(false);
        ink?.clearTextSelection();
        writeRaw((mouseTracking ? DISABLE_MOUSE_TRACKING : "") + EXIT_ALT_SCREEN);
      };
    };
    t3 = [writeRaw, mouseTracking];
    $[0] = mouseTracking;
    $[1] = writeRaw;
    $[2] = t2;
    $[3] = t3;
  } else {
    t2 = $[2];
    t3 = $[3];
  }
  useInsertionEffect(t2, t3);
  const t4 = size?.rows ?? 24;
  let t5;
  if ($[4] !== children || $[5] !== t4 || $[7] !== backgroundColor) {
    t5 = <Box flexDirection="column" height={t4} width="100%" flexShrink={0} backgroundColor={backgroundColor || undefined}>{children}</Box>;
    $[4] = children;
    $[5] = t4;
    $[7] = backgroundColor;
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  return t5;
}
