/**
 * React context + provider + hooks for the AgenC keybinding system.
 *
 * The provider subscribes to the Ink runtime's `InputEvent` stream via
 * `StdinContext`, converts each parsed keypress into a canonical chord
 * token, and routes it through the active binding map. Matched commands
 * fire every registered handler (handlers are stored as a Set so multiple
 * subscribers per command are supported).
 *
 * Three runtime behaviors live here and not in the binding definitions:
 *   1. Double-press gating for `ctrl+c` -> `app:interrupt` and
 *      `ctrl+d` -> `app:exit`. First press within the window emits a
 *      warning event; second press within 500 ms fires the real handler.
 *   2. Multi-chord buffering for sequences like `ctrl+x ctrl+e`. The
 *      first chord is held for up to 1000 ms; any unrelated key resets
 *      the buffer.
 *   3. Modal focus. When `activeContext === 'modal'` the chat map is
 *      suspended — the modal owns every keypress except global
 *      (`ctrl+c`, `ctrl+d`, ...).
 *
 * The provider is intentionally transport-agnostic: it accepts a
 * `stdinContext` prop so tests can pump synthetic `InputEvent`s through
 * a stub emitter without needing a real TTY.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Key } from "../ink/events/input-event.js";
import { InputEvent } from "../ink/events/input-event.js";
import type { EventEmitter } from "../ink/events/emitter.js";
import {
  DEFAULT_BINDINGS,
  normalizeKeySequence,
  type BindingCommand,
  type BindingContext,
  type BindingMap,
} from "./defaultBindings.js";

/** Window in ms within which a second Ctrl+C / Ctrl+D fires the real handler. */
export const DOUBLE_PRESS_WINDOW_MS = 500;

/** Window in ms to wait for the second chord of a multi-chord sequence. */
export const CHORD_WINDOW_MS = 1000;

/** Commands that require a double-press confirmation. */
const DOUBLE_PRESS_COMMANDS: ReadonlySet<BindingCommand> = new Set<BindingCommand>([
  "app:interrupt",
  "app:exit",
]);

/**
 * Signal emitted when the user performs the first half of a double-press
 * gesture. UIs can subscribe via `useKeybindingWarning` to show a transient
 * hint ("Press Ctrl+C again to interrupt").
 */
export interface KeybindingWarning {
  command: BindingCommand;
  keySequence: string;
  message: string;
}

export type KeybindingHandlers = {
  [command in BindingCommand]?: () => void;
};

type HandlerKey = `${BindingContext}:${BindingCommand}`;

interface ProviderProps {
  bindings?: Record<BindingContext, BindingMap>;
  /**
   * Optional seam for tests: inject a fake stdin context exposing an
   * `internal_eventEmitter` that emits `InputEvent`s. When omitted the
   * provider subscribes to the real Ink `StdinContext`.
   */
  stdinContext?: { internal_eventEmitter: EventEmitter } | null;
  /**
   * Optional seam for tests / observability: receives warnings emitted
   * on the first half of a double-press gesture.
   */
  onWarning?: (warning: KeybindingWarning) => void;
  children: React.ReactNode;
}

interface KeybindingContextValue {
  activeContext: BindingContext;
  setActiveContext: (ctx: BindingContext) => void;
  registerHandler: (
    context: BindingContext,
    command: BindingCommand,
    handler: () => void,
  ) => () => void;
  /** Last emitted warning (or null). Exposed for consumers that render a hint. */
  lastWarning: KeybindingWarning | null;
}

const KeybindingReactContext = createContext<KeybindingContextValue | null>(null);

/**
 * Build the chord token for a single `Key` + input pair. Matches the
 * canonical form produced by `normalizeKeySequence`: modifiers sorted
 * alphabetically, lowercased, `+`-joined.
 */
export function keyToChord(input: string, key: Key): string {
  const parts: string[] = [];
  // Modifier order here matches `normalizeKeySequence`'s sorted output so
  // chord lookup is a simple string equality check.
  if (key.meta && !key.escape) {
    // `meta` is Alt/Option on most platforms; Ink folds `option` into `meta`
    // and also sets `meta` when an ESC prefix is seen. We treat a bare
    // Escape keypress (key.escape === true with empty input) distinctly
    // from Alt+<key> so the `escape` binding still fires.
    parts.push("alt");
  }
  if (key.ctrl) parts.push("ctrl");
  if (key.super) parts.push("meta");
  if (key.shift) parts.push("shift");

  // Named special keys take precedence over raw input characters.
  let name: string | null = null;
  if (key.upArrow) name = "up";
  else if (key.downArrow) name = "down";
  else if (key.leftArrow) name = "left";
  else if (key.rightArrow) name = "right";
  else if (key.pageUp) name = "pageup";
  else if (key.pageDown) name = "pagedown";
  else if (key.home) name = "home";
  else if (key.end) name = "end";
  else if (key.tab) name = "tab";
  else if (key.backspace) name = "backspace";
  else if (key.delete) name = "delete";
  else if (key.return) name = "enter";
  else if (key.escape) name = "escape";

  if (name !== null) {
    parts.push(name);
    return parts.join("+");
  }

  // Printable input. Lowercase for canonical form; uppercase letters are
  // flagged via `key.shift` by the Ink input pipeline so we don't need to
  // preserve the visual case here.
  if (input.length > 0) {
    parts.push(input.toLowerCase());
    return parts.join("+");
  }

  // Fall through: an event with no recognizable key (e.g. a stray mouse
  // fragment). Emit an empty string so the resolver skips it.
  return "";
}

/**
 * Try to match a chord (or completed chord sequence) against a binding map.
 * Returns the matched command or `null`.
 */
function matchBinding(
  chord: string,
  bindings: BindingMap,
): BindingCommand | null {
  if (chord.length === 0) return null;
  const hit = bindings[chord];
  return hit ?? null;
}

/**
 * Lightweight predicate: does ANY key in the binding map start with `prefix `?
 * Used to detect multi-chord prefixes without having to iterate the full map
 * on every keystroke.
 */
function hasChordPrefix(chord: string, bindings: BindingMap): boolean {
  const needle = chord + " ";
  for (const key of Object.keys(bindings)) {
    if (key.startsWith(needle)) return true;
  }
  return false;
}

/**
 * Provider. Wraps the app tree and routes keypresses to registered
 * handlers. Typical usage:
 *
 * ```tsx
 * <KeybindingProvider>
 *   <App />
 * </KeybindingProvider>
 * ```
 */
export const KeybindingProvider: React.FC<ProviderProps> = ({
  bindings,
  stdinContext,
  onWarning,
  children,
}) => {
  const mergedBindings = bindings ?? DEFAULT_BINDINGS;

  // Handler registry keyed by `${context}:${command}` -> Set<handler>. Using
  // a Set allows multiple subscribers for the same command (e.g. a global
  // status bar and the active chat view both listen to `chat:cancel`).
  const handlerRegistryRef = useRef<Map<HandlerKey, Set<() => void>>>(
    new Map(),
  );

  const [activeContext, setActiveContext] = useState<BindingContext>("chat");
  const activeContextRef = useRef<BindingContext>(activeContext);
  useEffect(() => {
    activeContextRef.current = activeContext;
  }, [activeContext]);

  const [lastWarning, setLastWarning] = useState<KeybindingWarning | null>(null);

  // Double-press state. Keyed by command, tracks the timestamp of the first
  // press. A second press within DOUBLE_PRESS_WINDOW_MS fires the handler;
  // otherwise the entry is dropped on the next keystroke or via a timer.
  const doublePressRef = useRef<Map<BindingCommand, number>>(new Map());

  // Multi-chord state. Stores the first chord of a pending sequence and the
  // timestamp at which it was captured. Cleared on timeout or on an
  // unrelated keypress.
  const pendingChordRef = useRef<{ chord: string; at: number } | null>(null);

  const registerHandler = useCallback(
    (
      context: BindingContext,
      command: BindingCommand,
      handler: () => void,
    ): (() => void) => {
      const key: HandlerKey = `${context}:${command}`;
      const registry = handlerRegistryRef.current;
      let set = registry.get(key);
      if (!set) {
        set = new Set<() => void>();
        registry.set(key, set);
      }
      set.add(handler);
      return () => {
        const existing = registry.get(key);
        if (!existing) return;
        existing.delete(handler);
        if (existing.size === 0) {
          registry.delete(key);
        }
      };
    },
    [],
  );

  const fireHandlers = useCallback(
    (context: BindingContext, command: BindingCommand): boolean => {
      const set = handlerRegistryRef.current.get(`${context}:${command}`);
      if (!set || set.size === 0) return false;
      // Snapshot to a fresh array so a handler that unregisters itself
      // mid-call doesn't mutate the iterator.
      for (const handler of Array.from(set)) {
        try {
          handler();
        } catch (err) {
          // Swallow handler errors so one misbehaving subscriber cannot
          // break the rest of the keybinding pipeline. Real failures
          // should show up in the handler's own logging.
          void err;
        }
      }
      return true;
    },
    [],
  );

  const emitWarning = useCallback(
    (warning: KeybindingWarning) => {
      setLastWarning(warning);
      if (onWarning) onWarning(warning);
    },
    [onWarning],
  );

  /**
   * Resolve an incoming chord against the active context, then the global
   * context. Returns the matched command along with the context it
   * matched in. Handles multi-chord buffering and resets the pending
   * chord state on unrelated keypresses.
   */
  const resolveChord = useCallback(
    (
      chord: string,
    ): { context: BindingContext; command: BindingCommand } | null => {
      if (chord.length === 0) return null;

      const contextStack: BindingContext[] =
        activeContextRef.current === "modal"
          ? ["modal", "global"]
          : [activeContextRef.current, "global"];

      const now = Date.now();

      // Continuing an in-progress multi-chord sequence?
      const pending = pendingChordRef.current;
      if (pending !== null) {
        if (now - pending.at > CHORD_WINDOW_MS) {
          pendingChordRef.current = null;
        } else {
          const combined = `${pending.chord} ${chord}`;
          for (const ctx of contextStack) {
            const hit = matchBinding(combined, mergedBindings[ctx]);
            if (hit !== null) {
              pendingChordRef.current = null;
              return { context: ctx, command: hit };
            }
          }
          // Pending chord was set but the second chord didn't match.
          // Reset and fall through so the new chord has a fresh chance
          // to either match directly or become the new pending chord.
          pendingChordRef.current = null;
        }
      }

      // Try a direct match first.
      for (const ctx of contextStack) {
        const hit = matchBinding(chord, mergedBindings[ctx]);
        if (hit !== null) return { context: ctx, command: hit };
      }

      // No direct match. Does this chord begin any multi-chord sequence
      // in one of the active maps? If so, buffer it for the next
      // keypress.
      for (const ctx of contextStack) {
        if (hasChordPrefix(chord, mergedBindings[ctx])) {
          pendingChordRef.current = { chord, at: now };
          return null;
        }
      }

      return null;
    },
    [mergedBindings],
  );

  /**
   * Central keypress handler. Walks: resolve -> double-press gate ->
   * fire handlers. Exposed via `useMemo` so tests can flush a stream of
   * events through the same path the Ink emitter would.
   */
  const handleInputEvent = useCallback(
    (event: InputEvent) => {
      const chord = keyToChord(event.input, event.key);
      if (chord.length === 0) {
        // Unrelated noise — abandon any pending chord buffer so a
        // prefix like `ctrl+x` doesn't sit there forever.
        pendingChordRef.current = null;
        return;
      }

      const match = resolveChord(chord);
      if (match === null) return;

      const { context, command } = match;

      if (DOUBLE_PRESS_COMMANDS.has(command)) {
        const now = Date.now();
        const priorAt = doublePressRef.current.get(command);
        if (typeof priorAt === "number" && now - priorAt <= DOUBLE_PRESS_WINDOW_MS) {
          doublePressRef.current.delete(command);
          fireHandlers(context, command);
          return;
        }
        doublePressRef.current.set(command, now);
        emitWarning({
          command,
          keySequence: chord,
          message: doublePressMessage(command, chord),
        });
        return;
      }

      // Any non-double-press keypress clears the pending double-press
      // window; otherwise an idle Ctrl+C followed by an unrelated key
      // followed by another Ctrl+C would be interpreted as a
      // double-press.
      doublePressRef.current.clear();

      fireHandlers(context, command);
    },
    [resolveChord, fireHandlers, emitWarning],
  );

  // Keep a stable ref so the subscription effect doesn't re-bind on
  // every render (it depends on memoized callbacks, but downstream
  // consumers shouldn't pay for that).
  const handleInputEventRef = useRef(handleInputEvent);
  useEffect(() => {
    handleInputEventRef.current = handleInputEvent;
  }, [handleInputEvent]);

  // Subscribe to the injected stdin context. Tests pass a stub; production
  // passes the real Ink StdinContext value (Wave 2-A wires this up).
  useEffect(() => {
    if (!stdinContext) return;
    const emitter = stdinContext.internal_eventEmitter;
    const listener = (event: InputEvent) => {
      handleInputEventRef.current(event);
    };
    emitter.on("input", listener);
    return () => {
      emitter.removeListener("input", listener);
    };
  }, [stdinContext]);

  const contextValue: KeybindingContextValue = useMemo(
    () => ({
      activeContext,
      setActiveContext,
      registerHandler,
      lastWarning,
    }),
    [activeContext, registerHandler, lastWarning],
  );

  return React.createElement(
    KeybindingReactContext.Provider,
    { value: contextValue },
    children,
  );
};

function doublePressMessage(command: BindingCommand, chord: string): string {
  const readable = chord.replace(/\+/g, "+");
  if (command === "app:interrupt") {
    return `Press ${readable} again within ${DOUBLE_PRESS_WINDOW_MS}ms to interrupt.`;
  }
  if (command === "app:exit") {
    return `Press ${readable} again within ${DOUBLE_PRESS_WINDOW_MS}ms to exit.`;
  }
  return `Press ${readable} again within ${DOUBLE_PRESS_WINDOW_MS}ms to confirm.`;
}

/**
 * Register a handler for a command in a specific context. The handler is
 * removed automatically on component unmount.
 */
export function useKeybinding(
  command: BindingCommand,
  handler: () => void,
  context: BindingContext = "chat",
): void {
  const ctx = useContext(KeybindingReactContext);
  if (!ctx) {
    throw new Error(
      "useKeybinding must be used inside a <KeybindingProvider>.",
    );
  }

  // Store the latest handler on a ref so changes to the handler identity
  // don't re-register with the provider (which would briefly deregister
  // and re-register, losing any in-flight double-press state).
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const invoke = () => {
      handlerRef.current();
    };
    return ctx.registerHandler(context, command, invoke);
  }, [ctx, command, context]);
}

/**
 * Switch the active binding context — e.g. push `'modal'` when a confirm
 * dialog mounts, pop back to `'chat'` on unmount.
 */
export function useSetKeybindingContext(): (ctx: BindingContext) => void {
  const ctx = useContext(KeybindingReactContext);
  if (!ctx) {
    throw new Error(
      "useSetKeybindingContext must be used inside a <KeybindingProvider>.",
    );
  }
  return ctx.setActiveContext;
}

/**
 * Returns the most recent warning (e.g. double-press hint) emitted by the
 * provider. Components can render a transient hint by subscribing to this
 * value.
 */
export function useKeybindingWarning(): KeybindingWarning | null {
  const ctx = useContext(KeybindingReactContext);
  if (!ctx) return null;
  return ctx.lastWarning;
}

/**
 * Escape hatch used in a handful of places (and tests) that need to
 * synthesize a keypress directly, bypassing the stdin emitter. NOT part
 * of the public API but exported so the test suite can verify provider
 * behavior without setting up a full Ink render tree.
 */
export function __createInputEventForTest(
  input: string,
  key: Partial<Key>,
): InputEvent {
  // Build a minimal ParsedKey shape; InputEvent re-derives `key` and
  // `input` from it. We pass the parsed-shape expected by InputEvent's
  // constructor so the shape remains a single source of truth.
  const parsedKey = {
    kind: "key" as const,
    name: "",
    fn: false,
    ctrl: !!key.ctrl,
    meta: !!key.meta,
    shift: !!key.shift,
    option: false,
    super: !!key.super,
    sequence: input,
    raw: input,
  };
  // `InputEvent`'s constructor only reads the fields we set above, so an
  // `as never` cast is the tightest way to signal "yes, this shape is
  // intentional" without exporting the private `ParsedKey` type surface.
  return new InputEvent(parsedKey as never);
}

/**
 * Normalizer re-exported for symmetry so downstream consumers only need to
 * import from this module.
 */
export { normalizeKeySequence };
