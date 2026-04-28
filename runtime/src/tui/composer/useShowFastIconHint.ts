/**
 * Show the `/fast` hint next to the fast-mode icon for the first 5
 * seconds the icon is visible in a session.
 *
 * Ported from upstream. The "shown once per process" flag lives at
 * module scope so navigating between transcript and composer doesn't
 * re-trigger the hint.
 */
import { useEffect, useState } from "react";

const HINT_DISPLAY_DURATION_MS = 5000;

let hasShownThisSession = false;

export function useShowFastIconHint(showFastIcon: boolean): boolean {
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (hasShownThisSession || !showFastIcon) {
      return;
    }

    hasShownThisSession = true;
    setShowHint(true);

    const timer = setTimeout(() => setShowHint(false), HINT_DISPLAY_DURATION_MS);

    return (): void => {
      clearTimeout(timer);
      setShowHint(false);
    };
  }, [showFastIcon]);

  return showHint;
}
