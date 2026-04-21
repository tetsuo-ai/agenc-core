/**
 * Minimal overlay stack for the AgenC TUI.
 *
 * Wave 2 scope: expose `pushOverlay()` / `popOverlay()` via React context
 * so later waves (approval modals, settings sheets, etc.) can layer UI
 * above the main chat surface without knowing about each other. The
 * actual rendering of the overlay stack is handled alongside the rest
 * of the tree by `TUIRoot` — this module only owns the stack state.
 *
 * Design notes:
 *   - Each overlay is a `ReactNode` rendered by the consumer via
 *     `useOverlayStack()`. We intentionally keep this simple; richer
 *     lifecycle hooks (onClose, backdrop dismissal, focus trap) can be
 *     layered on later without breaking consumers.
 *   - IDs are generated internally so `popOverlay()` can target a
 *     specific slot even if the stack has been reordered in the future.
 *     `popOverlay()` without an id pops the top-most entry.
 *   - The stack is intentionally unbounded. Stack discipline is the
 *     caller's responsibility; the context layer only enforces
 *     push/pop parity.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type OverlayId = string;

export interface OverlayEntry {
  readonly id: OverlayId;
  readonly node: ReactNode;
}

export interface OverlayContextValue {
  readonly overlays: readonly OverlayEntry[];
  /**
   * Push an overlay onto the top of the stack. Returns the id assigned
   * to the new entry so the caller can later `popOverlay(id)` to remove
   * that specific entry instead of the top of the stack.
   */
  pushOverlay: (node: ReactNode) => OverlayId;
  /**
   * Remove an overlay. Without arguments, pops the top-most entry. With
   * an id, removes that specific entry wherever it sits in the stack.
   * Unknown ids are ignored.
   */
  popOverlay: (id?: OverlayId) => void;
  /** Clear every overlay. Intended for error/reset paths. */
  clearOverlays: () => void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export interface OverlayProviderProps {
  readonly children: ReactNode;
}

export function OverlayProvider({
  children,
}: OverlayProviderProps): React.ReactElement {
  const [overlays, setOverlays] = useState<readonly OverlayEntry[]>([]);
  const nextIdRef = useRef(0);

  const pushOverlay = useCallback((node: ReactNode): OverlayId => {
    nextIdRef.current += 1;
    const id = `overlay-${nextIdRef.current}`;
    setOverlays((prev) => [...prev, { id, node }]);
    return id;
  }, []);

  const popOverlay = useCallback((id?: OverlayId) => {
    setOverlays((prev) => {
      if (prev.length === 0) return prev;
      if (id === undefined) return prev.slice(0, -1);
      const idx = prev.findIndex((entry) => entry.id === id);
      if (idx < 0) return prev;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    });
  }, []);

  const clearOverlays = useCallback(() => {
    setOverlays((prev) => (prev.length === 0 ? prev : []));
  }, []);

  const value = useMemo<OverlayContextValue>(
    () => ({ overlays, pushOverlay, popOverlay, clearOverlays }),
    [overlays, pushOverlay, popOverlay, clearOverlays],
  );

  return (
    <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>
  );
}

/**
 * Access the overlay stack from anywhere in the TUI tree. Throws when
 * called outside an {@link OverlayProvider} so consumer bugs surface
 * early during development.
 */
export function useOverlayStack(): OverlayContextValue {
  const ctx = useContext(OverlayContext);
  if (ctx === null) {
    throw new Error("useOverlayStack must be used inside <OverlayProvider>");
  }
  return ctx;
}
