// Cherry-picked overlay-context adapter for the wholesale-ported
// search dialogs.
//
// openclaude src/context/overlayContext.tsx (~150 LOC) registers
// overlays in a global stack so a top overlay can be lifted (Esc)
// and re-shown. AgenC has its own overlay system at runtime/src/tui/
// overlay/ but its API doesn't match openclaude's
// useRegisterOverlay() shape.
//
// This shim provides the openclaude API surface (useRegisterOverlay)
// as a no-op so the wholesale-ported dialogs compile. Production
// wiring to AgenC's overlay system can replace this body without
// touching the openclaude-side dialog code.

import { useEffect } from "react";

// Matches openclaude's runtime call shape: useRegisterOverlay(id, enabled?).
export function useRegisterOverlay(_id: string, _enabled?: boolean): void {
  // No-op shim. AgenC's real overlay registration lives in tui/overlay/.
  // Hook into that here when the dialogs become production consumers.
  useEffect(() => {
    return () => {};
  }, []);
}
