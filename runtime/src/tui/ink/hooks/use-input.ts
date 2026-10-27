import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { InputEvent, Key } from '../events/input-event.js'
import { useStdin } from '../components/StdinContext.js'

type Handler = (input: string, key: Key, event: InputEvent) => void

/**
 * A stable function that always calls the latest `callback`. The ref is synced
 * in a layout effect, so it is current as soon as React commits, before the
 * next stdin read is dispatched. useEventCallback from usehooks-ts syncs with
 * useEffect when `window` is undefined, as it is in Node. After a commit that
 * did not come from a key, such as state set after an await, that left the
 * previous render's handler in place until a later scheduler turn, and a key
 * read in between ran it.
 */
function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback)
  useLayoutEffect(() => {
    callbackRef.current = callback
  })
  return useCallback((...args: Args) => callbackRef.current(...args), [])
}

type Options = {
  /**
   * Enable or disable capturing of user input.
   * Useful when there are multiple useInput hooks used at once to avoid handling the same input several times.
   *
   * @default true
   */
  isActive?: boolean
}

/**
 * This hook is used for handling user input.
 * It's a more convenient alternative to using `StdinContext` and listening to `data` events.
 * The callback you pass to `useInput` is called for each character when user enters any input.
 * However, if user pastes text and it's more than one character, the callback will be called only once and the whole string will be passed as `input`.
 *
 * ```
 * import {useInput} from 'ink';
 *
 * const UserInput = () => {
 *   useInput((input, key) => {
 *     if (input === 'q') {
 *       // Exit program
 *     }
 *
 *     if (key.leftArrow) {
 *       // Left arrow key pressed
 *     }
 *   });
 *
 *   return …
 * };
 * ```
 */
const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()

  // useLayoutEffect (not useEffect) so that raw mode is enabled synchronously
  // during React's commit phase, before render() returns. With useEffect, raw
  // mode setup is deferred to the next event loop tick via React's scheduler,
  // leaving the terminal in cooked mode — keystrokes echo and the cursor is
  // visible until the effect fires.
  useLayoutEffect(() => {
    if (options.isActive === false) {
      return
    }

    setRawMode(true)

    return () => {
      setRawMode(false)
    }
  }, [options.isActive, setRawMode])

  // Register the listener once on mount so its slot in the EventEmitter's
  // listener array is stable. If isActive were in the effect's deps, the
  // listener would re-append on false→true, moving it behind listeners
  // that registered while it was inactive — breaking
  // stopImmediatePropagation() ordering. useLatestCallback keeps the
  // reference stable while reading latest isActive/inputHandler from
  // closure (it syncs via useLayoutEffect, so it's compiler-safe).
  const handleData = useLatestCallback((event: InputEvent) => {
    if (options.isActive === false) {
      return
    }
    const { input, key } = event

    // If app is not supposed to exit on Ctrl+C, then let input listener handle it
    // Note: discreteUpdates is called at the App level when emitting events,
    // so all listeners are already within a high-priority update context.
    if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
      inputHandler(input, key, event)
    }
  })

  useEffect(() => {
    internal_eventEmitter?.on('input', handleData)

    return () => {
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData])
}

export default useInput
