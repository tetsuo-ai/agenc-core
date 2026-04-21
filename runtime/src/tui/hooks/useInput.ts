/**
 * useInput — convenience wrapper over the AgenC keybinding context.
 *
 * Consumers that only care about the three top-level chat actions (submit,
 * cancel, cycle mode) don't need to know the keybinding command strings;
 * this hook routes each one through `useKeybinding()` using the canonical
 * `chat:*` command identifiers. An optional `onPaste` receives raw paste
 * bytes directly from Ink's stdin emitter.
 *
 * Wave 2-B owns the real keybinding resolver; this hook is a thin shim so
 * later waves (composer, approval modal) can call one small API. React's
 * rules require that hooks are called unconditionally on every render — we
 * therefore always register an inner no-op handler when the caller hasn't
 * provided a real one, which keeps the hook order stable across renders.
 */

import { useContext, useEffect } from "react";
import StdinContext from "../ink/components/StdinContext.js";
import { InputEvent } from "../ink/events/input-event.js";
import { useKeybinding } from "../keybindings/KeybindingContext.js";

export interface UseInputHandlers {
  /** Fires on the `chat:submit` keybinding (Enter by default). */
  readonly onSubmit?: (text: string) => void;
  /** Fires on the `chat:cancel` keybinding (Escape by default). */
  readonly onCancel?: () => void;
  /** Fires on the `chat:cycleMode` keybinding (Shift+Tab / Meta+M). */
  readonly onCycleMode?: () => void;
  /**
   * Optional raw paste receiver. Subscribes to Ink's stdin event stream
   * and delivers the unparsed bytes of multi-byte paste events. Wave 5
   * adds full bracketed-paste decoding on top of this.
   */
  readonly onPaste?: (bytes: Buffer) => void;
}

/** Stable no-op reused whenever a caller leaves a handler unset. */
const NOOP = (): void => {
  /* no-op */
};

/**
 * Register chat-level keybinding handlers and (optionally) a raw paste
 * receiver. All three keybinding hooks are always called — the handler
 * callback is a no-op when the caller omits it — so React's call order
 * stays identical regardless of which handlers are present.
 *
 * `onSubmit` intentionally takes a `text` argument even though the
 * keybinding layer has no composer text to emit; the composer wave will
 * pass the buffer through its own wrapper that calls `onSubmit(text)`
 * directly. This signature keeps the public API stable across waves.
 */
export function useInput(handlers: UseInputHandlers = {}): void {
  const submitFn = handlers.onSubmit;
  const cancelFn = handlers.onCancel;
  const cycleFn = handlers.onCycleMode;
  const pasteFn = handlers.onPaste;

  useKeybinding(
    "chat:submit",
    submitFn ? () => submitFn("") : NOOP,
    "chat",
  );
  useKeybinding("chat:cancel", cancelFn ?? NOOP, "chat");
  useKeybinding("chat:cycleMode", cycleFn ?? NOOP, "chat");

  const stdin = useContext(StdinContext);
  useEffect(() => {
    if (!pasteFn) return;
    const emitter = stdin.internal_eventEmitter;
    if (!emitter) return;
    const listener = (event: InputEvent): void => {
      // Multi-byte paste events arrive as a single `input` string; forward
      // the raw bytes so downstream code can decide how to decode. Single
      // keystrokes are still emitted but with a tiny payload, which the
      // composer will filter on its own layer.
      if (typeof event.input === "string" && event.input.length > 1) {
        pasteFn(Buffer.from(event.input, "utf8"));
      }
    };
    emitter.on("input", listener);
    return () => {
      emitter.removeListener("input", listener);
    };
  }, [pasteFn, stdin]);
}
