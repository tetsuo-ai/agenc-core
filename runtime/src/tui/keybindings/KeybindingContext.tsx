import { c as _c } from "react-compiler-runtime";
import { createContext, type ReactNode, type RefObject, useCallback, useContext, useLayoutEffect, useMemo } from 'react';
import type { Key } from '../ink.js';
import { type ChordResolveResult, getBindingDisplayText, resolveKeyWithChordState } from './resolver.js';
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js';

/** Handler registration for action callbacks */
type HandlerRegistration = {
  action: string;
  context: KeybindingContextName;
  handler: () => void;
};
export type InputCaptureRegistration = {
  context: KeybindingContextName;
  handler: (input: string, key: Key) => boolean;
};
type KeybindingContextValue = {
  /** Resolve a key input to an action name (with chord support) */
  resolve: (input: string, key: Key, activeContexts: KeybindingContextName[]) => ChordResolveResult;

  /** Update the pending chord state */
  setPendingChord: (pending: ParsedKeystroke[] | null) => void;

  /** Get display text for an action (e.g., "ctrl+t") */
  getDisplayText: (action: string, context: KeybindingContextName) => string | undefined;

  /** All parsed bindings (for help display) */
  bindings: ParsedBinding[];

  /** Current pending chord keystrokes (null if not in a chord) */
  pendingChord: ParsedKeystroke[] | null;

  /** Currently active keybinding contexts (for priority resolution) */
  activeContexts: Set<KeybindingContextName>;

  /** Register a context as active (call on mount) */
  registerActiveContext: (context: KeybindingContextName) => void;

  /** Unregister a context (call on unmount) */
  unregisterActiveContext: (context: KeybindingContextName) => void;

  /** Register a handler for an action (used by useKeybinding) */
  registerHandler: (registration: HandlerRegistration) => () => void;

  /** Register an early raw input capture (used before child useInput handlers) */
  registerInputCapture: (registration: InputCaptureRegistration) => () => void;

  /** Invoke all handlers for an action (used by ChordInterceptor) */
  invokeAction: (action: string) => boolean;
};
const KeybindingContext = createContext<KeybindingContextValue | null>(null);
type ProviderProps = {
  bindings: ParsedBinding[];
  /** Ref for immediate access to pending chord (avoids React state delay) */
  pendingChordRef: RefObject<ParsedKeystroke[] | null>;
  /** State value for re-renders (UI updates) */
  pendingChord: ParsedKeystroke[] | null;
  setPendingChord: (pending: ParsedKeystroke[] | null) => void;
  activeContexts: Set<KeybindingContextName>;
  registerActiveContext: (context: KeybindingContextName) => void;
  unregisterActiveContext: (context: KeybindingContextName) => void;
  /** Ref to handler registry (used by ChordInterceptor) */
  handlerRegistryRef: RefObject<Map<string, Set<HandlerRegistration>>>;
  /** Ref to early raw input captures (used by ChordInterceptor) */
  inputCaptureRegistryRef?: RefObject<Set<InputCaptureRegistration> | null>;
  children: ReactNode;
};
export function KeybindingProvider(t0: ProviderProps) {
  const {
    bindings,
    pendingChordRef,
    pendingChord,
    setPendingChord,
    activeContexts,
    registerActiveContext,
    unregisterActiveContext,
    handlerRegistryRef,
    inputCaptureRegistryRef,
    children
  } = t0;
  const getDisplay = useCallback((action: string, context: KeybindingContextName) => getBindingDisplayText(action, context, bindings), [bindings]);
  const registerHandler = useCallback((registration: HandlerRegistration) => {
    const registry = handlerRegistryRef.current;
    if (!registry) return _temp;
    if (!registry.has(registration.action)) {
      registry.set(registration.action, new Set());
    }
    registry.get(registration.action)!.add(registration);
    return () => {
      const handlers = registry.get(registration.action);
      if (!handlers) return;
      handlers.delete(registration);
      if (handlers.size === 0) {
        registry.delete(registration.action);
      }
    };
  }, [handlerRegistryRef]);
  const registerInputCapture = useCallback((registration: InputCaptureRegistration) => {
    const registry = inputCaptureRegistryRef?.current;
    if (!registry) return _temp;
    registry.add(registration);
    return () => {
      registry.delete(registration);
    };
  }, [inputCaptureRegistryRef]);
  const invokeAction = useCallback((action_0: string) => {
    const registry_0 = handlerRegistryRef.current;
    if (!registry_0) return false;
    const handlers_0 = registry_0.get(action_0);
    if (!handlers_0 || handlers_0.size === 0) return false;
    for (const registration_0 of handlers_0) {
      if (activeContexts.has(registration_0.context)) {
        registration_0.handler();
        return true;
      }
    }
    return false;
  }, [activeContexts, handlerRegistryRef]);
  const resolve = useCallback((input: string, key: Key, contexts: KeybindingContextName[]) => resolveKeyWithChordState(input, key, contexts, bindings, pendingChordRef.current), [bindings, pendingChordRef]);
  const value = useMemo(() => ({
    resolve,
    setPendingChord,
    getDisplayText: getDisplay,
    bindings,
    pendingChord,
    activeContexts,
    registerActiveContext,
    unregisterActiveContext,
    registerHandler,
    registerInputCapture,
    invokeAction
  }), [activeContexts, bindings, getDisplay, invokeAction, pendingChord, registerActiveContext, registerHandler, registerInputCapture, resolve, setPendingChord, unregisterActiveContext]);
  return <KeybindingContext.Provider value={value}>{children}</KeybindingContext.Provider>;
}
function _temp() {}
export function useKeybindingContext() {
  const ctx = useContext(KeybindingContext);
  if (!ctx) {
    throw new Error("useKeybindingContext must be used within KeybindingProvider");
  }
  return ctx;
}

/**
 * Optional hook that returns undefined outside of KeybindingProvider.
 * Useful for components that may render before provider is available.
 */
export function useOptionalKeybindingContext() {
  return useContext(KeybindingContext);
}

/**
 * Hook to register a keybinding context as active while the component is mounted.
 *
 * When a context is registered, its keybindings take precedence over Global bindings.
 * This allows context-specific bindings (like ThemePicker's ctrl+t) to override
 * global bindings (like the Follow-up toggle) when the context is active.
 *
 * @example
 * ```tsx
 * function ThemePicker() {
 *   useRegisterKeybindingContext('ThemePicker')
 *   // Now ThemePicker's ctrl+t binding takes precedence over Global
 * }
 * ```
 */
export function useRegisterKeybindingContext(context: KeybindingContextName, t0?: boolean) {
  const $ = _c(5);
  const isActive = t0 === undefined ? true : t0;
  const keybindingContext = useOptionalKeybindingContext();
  let t1;
  let t2;
  if ($[0] !== context || $[1] !== isActive || $[2] !== keybindingContext) {
    t1 = () => {
      if (!keybindingContext || !isActive) {
        return;
      }
      keybindingContext.registerActiveContext(context);
      return () => {
        keybindingContext.unregisterActiveContext(context);
      };
    };
    t2 = [context, keybindingContext, isActive];
    $[0] = context;
    $[1] = isActive;
    $[2] = keybindingContext;
    $[3] = t1;
    $[4] = t2;
  } else {
    t1 = $[3];
    t2 = $[4];
  }
  useLayoutEffect(t1, t2);
}
