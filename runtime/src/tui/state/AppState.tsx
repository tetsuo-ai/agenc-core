/**
 * AgenC TUI app state context.
 *
 * Exposes the subset of session state the cockpit needs to render and
 * react to lifecycle events: current permission mode, streaming flag,
 * and count of in-flight requests. Kept intentionally narrow — the full
 * runtime Session has a much wider public surface but dragging all of
 * that into React-land would make testing miserable.
 *
 * Tests feed in a minimal stub that only implements
 * `services.permissionModeRegistry` (see `SessionLike` below); the real
 * {@link Session} class satisfies it automatically.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { PermissionMode } from "../../permissions/types.js";

/**
 * Minimum shape the TUI cares about from the runtime session. Using a
 * structural type here lets tests pass a tiny stub that only implements
 * `services.permissionModeRegistry` without having to fabricate a full
 * `Session`.
 */
export interface PermissionModeRegistryLike {
  current(): { readonly mode: PermissionMode };
  subscribeToModeChange(
    cb: (next: PermissionMode, previous: PermissionMode) => void,
  ): () => void;
}

export interface SessionLike {
  readonly services: {
    readonly permissionModeRegistry: PermissionModeRegistryLike;
  };
}

/**
 * Matching minimum for the config store. Wave 2 only needs a read-only
 * handle; future waves will add listeners when they wire config-reload
 * UX.
 */
export interface ConfigStoreLike {
  readonly snapshot?: unknown;
}

export interface AgenCAppStateValue {
  readonly mode: PermissionMode;
  readonly session: SessionLike;
  readonly configStore: ConfigStoreLike;
  readonly isStreaming: boolean;
  readonly pendingRequests: number;
  /** Bump `isStreaming` on. Exposed so later waves can drive the cockpit. */
  setStreaming: (next: boolean) => void;
  /** Adjust the in-flight request count. Delta, not absolute. */
  adjustPending: (delta: number) => void;
}

const AgenCAppStateContext = createContext<AgenCAppStateValue | null>(null);

export interface AgenCAppStateProviderProps {
  readonly session: SessionLike;
  readonly configStore: ConfigStoreLike;
  readonly children: ReactNode;
}

export function AgenCAppStateProvider({
  session,
  configStore,
  children,
}: AgenCAppStateProviderProps): React.ReactElement {
  // Seed from whatever the registry reports right now so the very first
  // render already shows the correct mode indicator instead of flashing
  // the "default" mode for a frame.
  const [mode, setMode] = useState<PermissionMode>(
    () => session.services.permissionModeRegistry.current().mode,
  );
  const [isStreaming, setStreaming] = useState<boolean>(false);
  const [pendingRequests, setPendingRequests] = useState<number>(0);

  useEffect(() => {
    const registry = session.services.permissionModeRegistry;
    // Pick up whatever the registry thinks is current right now, in
    // case the session rotated modes between construction and mount.
    setMode(registry.current().mode);
    const unsubscribe = registry.subscribeToModeChange((next) => {
      setMode(next);
    });
    return () => {
      unsubscribe();
    };
  }, [session]);

  const adjustPending = useMemo(
    () =>
      (delta: number): void => {
        setPendingRequests((prev) => Math.max(0, prev + delta));
      },
    [],
  );

  const value = useMemo<AgenCAppStateValue>(
    () => ({
      mode,
      session,
      configStore,
      isStreaming,
      pendingRequests,
      setStreaming,
      adjustPending,
    }),
    [mode, session, configStore, isStreaming, pendingRequests, adjustPending],
  );

  return (
    <AgenCAppStateContext.Provider value={value}>
      {children}
    </AgenCAppStateContext.Provider>
  );
}

/**
 * Read the current AgenC TUI app state. Throws when called outside the
 * provider so consumer bugs surface early.
 */
export function useAgenCAppState(): AgenCAppStateValue {
  const ctx = useContext(AgenCAppStateContext);
  if (ctx === null) {
    throw new Error(
      "useAgenCAppState must be used inside <AgenCAppStateProvider>",
    );
  }
  return ctx;
}

/**
 * Wave 2-B placeholder. Wave 2-B ships
 * `runtime/src/tui/keybindings/KeybindingContext.tsx` exporting the real
 * provider; App.tsx imports from here until that lands. The placeholder
 * is deliberately pass-through — once the real provider lands, consumers
 * can switch the import in App.tsx to the Wave 2-B module and this stub
 * can be deleted.
 */
export interface KeybindingProviderProps {
  readonly bindings: unknown;
  readonly children: ReactNode;
}

export const KeybindingProvider: React.FC<KeybindingProviderProps> = ({
  children,
}) => {
  return <>{children}</>;
};
