import React, { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { MailboxProvider } from '../context/mailbox.js';
import type { ConfigStore } from '../../config/store.js';
import { reasoningEffortToEffortLevel } from '../../utils/effort.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { createStore } from './store.js';

import { type AppState, type AppStateStore, getDefaultAppState } from './AppStateStore.js';

// Follow-up: Remove these re-exports once all callers import directly from the
// paired AppStateStore module. Kept for back-compat during migration so .ts
// callers can incrementally move off the .tsx import and stop pulling React.
export { type AppState, type AppStateStore, type CompletionBoundary, getDefaultAppState, getDefaultAppStateForProviderEnvironment, IDLE_SPECULATION_STATE, type SpeculationResult, type SpeculationState } from './AppStateStore.js';
export const AppStoreContext = React.createContext<AppStateStore | null>(null);
type Props = {
  children: React.ReactNode;
  configStore?: ConfigStore;
  initialState?: AppState;
  onChangeAppState?: (args: {
    newState: AppState;
    oldState: AppState;
  }) => void;
};
const HasAppStateContext = React.createContext<boolean>(false);
export function AppStateProvider({
  children,
  configStore,
  initialState,
  onChangeAppState,
}: Props) {
  const hasAppStateContext = useContext(HasAppStateContext);
  if (hasAppStateContext) {
    throw new Error("AppStateProvider can not be nested within another AppStateProvider");
  }
  const [store] = useState(() =>
    createStore(initialState ?? getDefaultAppState(), onChangeAppState),
  );

  useEffect(() => {
    if (configStore === undefined) return;
    return configStore.subscribe(() => {
      const settings = getInitialSettings(configStore);
      store.setState(prev => {
        const previousEffort = reasoningEffortToEffortLevel(
          prev.settings.reasoning_effort,
        );
        const nextEffort = reasoningEffortToEffortLevel(
          settings.reasoning_effort,
        );
        const effortChanged = previousEffort !== nextEffort;
        const swarmChanged = prev.settings.swarmMode !== settings.swarmMode;
        return {
          ...prev,
          settings,
          ...(effortChanged && nextEffort !== undefined
            ? { effortValue: nextEffort }
            : {}),
          ...(swarmChanged && settings.swarmMode !== undefined
            ? { swarmMode: settings.swarmMode }
            : {}),
        };
      });
    });
  }, [configStore, store]);

  return <HasAppStateContext.Provider value={true}>
    <AppStoreContext.Provider value={store}>
      <MailboxProvider>{children}</MailboxProvider>
    </AppStoreContext.Provider>
  </HasAppStateContext.Provider>;
}
function useAppStore(): AppStateStore {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const store = useContext(AppStoreContext);
  if (!store) {
    throw new ReferenceError('useAppState/useSetAppState cannot be called outside of an <AppStateProvider />');
  }
  return store;
}

/**
 * Subscribe to a slice of AppState. Only re-renders when the selected value
 * changes (compared via Object.is).
 *
 * For multiple independent fields, call the hook multiple times:
 * ```
 * const verbose = useAppState(s => s.verbose)
 * const model = useAppState(s => s.mainLoopModel)
 * ```
 *
 * Do NOT return new objects from the selector -- Object.is will always see
 * them as changed. Instead, select an existing sub-object reference:
 * ```
 * const { text, promptId } = useAppState(s => s.promptSuggestion) // good
 * ```
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore();
  const selectorRef = React.useRef(selector);
  const storeRef = React.useRef(store);
  const snapshotRef = React.useRef({
    hasValue: false,
    selector: null as unknown,
    state: null as unknown,
    store: null as unknown,
    value: undefined as unknown,
  });
  // Update refs during render so get() always calls the latest selector/store
  // without creating a new function identity that would trigger useSyncExternalStore
  // to re-sync and cause re-render loops.
  selectorRef.current = selector;
  storeRef.current = store;
  const get = React.useCallback((): T => {
    const currentStore = storeRef.current;
    const currentSelector = selectorRef.current;
    const currentState = currentStore.getState();
    const cached = snapshotRef.current;
    if (
      cached.hasValue &&
      cached.store === currentStore &&
      cached.selector === currentSelector &&
      Object.is(cached.state, currentState)
    ) {
      return cached.value as T;
    }
    const value = currentSelector(currentState);
    snapshotRef.current = {
      hasValue: true,
      selector: currentSelector,
      state: currentState,
      store: currentStore,
      value,
    };
    return value;
  }, []);
  return useSyncExternalStore(store.subscribe, get, get);
}

/**
 * Get the setAppState updater without subscribing to any state.
 * Returns a stable reference that never changes -- components using only
 * this hook will never re-render from state changes.
 */
export function useSetAppState() {
  return useAppStore().setState;
}

export function useOptionalSetAppState() {
  return useContext(AppStoreContext)?.setState;
}

/**
 * Get the store directly (for passing getState/setState to non-React code).
 */
export function useAppStateStore() {
  return useAppStore();
}
const NOOP_SUBSCRIBE = () => () => {};

/**
 * Safe version of useAppState that returns undefined if called outside of AppStateProvider.
 * Useful for components that may be rendered in contexts where AppStateProvider isn't available.
 */
export function useAppStateMaybeOutsideOfProvider<T>(
  selector: (state: AppState) => T,
): T | undefined {
  const store = useContext(AppStoreContext);
  const selectorRef = React.useRef(selector);
  const storeRef = React.useRef(store);
  const snapshotRef = React.useRef({
    hasValue: false,
    selector: null as unknown,
    state: null as unknown,
    store: null as unknown,
    value: undefined as unknown,
  });
  // Update refs during render so get() always calls the latest selector/store
  // without creating a new function identity.
  selectorRef.current = selector;
  storeRef.current = store;
  const get = React.useCallback((): T | undefined => {
    const currentStore = storeRef.current;
    if (!currentStore) return undefined;
    const currentSelector = selectorRef.current;
    const currentState = currentStore.getState();
    const cached = snapshotRef.current;
    if (
      cached.hasValue &&
      cached.store === currentStore &&
      cached.selector === currentSelector &&
      Object.is(cached.state, currentState)
    ) {
      return cached.value as T;
    }
    const value = currentSelector(currentState);
    snapshotRef.current = {
      hasValue: true,
      selector: currentSelector,
      state: currentState,
      store: currentStore,
      value,
    };
    return value;
  }, []);
  return useSyncExternalStore(store ? store.subscribe : NOOP_SUBSCRIBE, get);
}
