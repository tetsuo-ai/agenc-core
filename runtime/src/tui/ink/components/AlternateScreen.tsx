import { c as _c } from "react-compiler-runtime";
import React, { type PropsWithChildren, useContext, useInsertionEffect } from 'react';
import instances from '../instances.js';
import { DISABLE_ALTERNATE_SCROLL, DISABLE_MOUSE_TRACKING, ENABLE_ALTERNATE_SCROLL, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../termio/dec.js';
import { TerminalWriteContext } from '../useTerminalNotification.js';
import Box from './Box.js';
import StdoutContext from './StdoutContext.js';
import { TerminalSizeContext } from './TerminalSizeContext.js';
type Props = PropsWithChildren<{
  /** Enable SGR mouse tracking (wheel + click/drag). Default true. */
  mouseTracking?: boolean;
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
 * and similar temporary fullscreen views — the main screen is preserved.
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
    mouseTracking: t1
  } = t0;
  const mouseTracking = t1 === undefined ? true : t1;
  const size = useContext(TerminalSizeContext);
  const writeRaw = useContext(TerminalWriteContext);
  const stdout = useContext(StdoutContext);
  let t2;
  let t3;
  if ($[0] !== mouseTracking || $[1] !== stdout || $[2] !== writeRaw) {
    t2 = () => {
      const ink = instances.get(stdout);
      if (!writeRaw) {
        return;
      }
      writeRaw(ENTER_ALT_SCREEN + "\x1B[2J\x1B[H" + ENABLE_ALTERNATE_SCROLL + (mouseTracking ? ENABLE_MOUSE_TRACKING : ""));
      ink?.setAltScreenActive(true, mouseTracking);
      return () => {
        ink?.setAltScreenActive(false);
        ink?.clearTextSelection();
        writeRaw((mouseTracking ? DISABLE_MOUSE_TRACKING : "") + DISABLE_ALTERNATE_SCROLL + EXIT_ALT_SCREEN);
      };
    };
    t3 = [stdout, writeRaw, mouseTracking];
    $[0] = mouseTracking;
    $[1] = stdout;
    $[2] = writeRaw;
    $[3] = t2;
    $[4] = t3;
  } else {
    t2 = $[3];
    t3 = $[4];
  }
  useInsertionEffect(t2, t3);
  const t4 = size?.rows ?? 24;
  let t5;
  if ($[5] !== children || $[6] !== t4) {
    t5 = <Box flexDirection="column" height={t4} width="100%" flexShrink={0}>{children}</Box>;
    $[5] = children;
    $[6] = t4;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  return t5;
}
