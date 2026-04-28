/**
 * Inline toast notifications shown in the composer footer.
 *
 * Ported from upstream's `context/notifications.tsx`. The original
 * threaded `notifications.queue` / `notifications.current` through the
 * shared AppState store so non-React callers could push without going
 * through React. AgenC's existing `AppState.tsx` does not carry a
 * notifications slot (deferred to a later tranche), so this provider
 * owns its own React state. The hook surface is preserved:
 *
 * ```ts
 * const { addNotification, removeNotification } = useNotifications()
 * addNotification({ key: 'foo', text: 'hi', priority: 'medium' })
 * ```
 *
 * Priority queue semantics:
 *   - `immediate` interrupts whatever is currently displayed and re-queues
 *     it (unless that current item was also immediate, which gets dropped).
 *   - `high`/`medium`/`low` are picked in priority order from the queue
 *     when the current slot is empty.
 *   - `fold` lets a caller merge with an existing same-key notification
 *     so e.g. duplicate "compaction running" toasts collapse together.
 *   - `invalidates` lets a notification eject other keys from the queue
 *     and the current slot (e.g. a new error invalidates a stale spinner).
 *
 * Default timeout is 8s; pass `timeoutMs` to override per-notification.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { Theme } from "../theme.js";

type Priority = "low" | "medium" | "high" | "immediate";

type BaseNotification = {
  key: string;
  /**
   * Keys of notifications that this notification invalidates.
   * If a notification is invalidated, it will be removed from the queue
   * and, if currently displayed, cleared immediately.
   */
  invalidates?: string[];
  priority: Priority;
  timeoutMs?: number;
  /**
   * Combine notifications with the same key, like Array.reduce().
   * Called as fold(accumulator, incoming) when a notification with a matching
   * key already exists in the queue or is currently displayed.
   * Returns the merged notification (should carry fold forward for future merges).
   */
  fold?: (accumulator: Notification, incoming: Notification) => Notification;
};

type TextNotification = BaseNotification & {
  text: string;
  color?: keyof Theme["colors"];
};

type JSXNotification = BaseNotification & {
  jsx: ReactNode;
};

export type Notification = TextNotification | JSXNotification;

type AddNotificationFn = (content: Notification) => void;
type RemoveNotificationFn = (key: string) => void;

export interface NotificationsState {
  readonly queue: readonly Notification[];
  readonly current: Notification | null;
}

const DEFAULT_TIMEOUT_MS = 8000;

const PRIORITIES: Record<Priority, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function getNext(
  queue: readonly Notification[],
): Notification | undefined {
  if (queue.length === 0) return undefined;
  return queue.reduce((min, n) =>
    PRIORITIES[n.priority] < PRIORITIES[min.priority] ? n : min,
  );
}

export interface NotificationsContextValue {
  readonly state: NotificationsState;
  readonly addNotification: AddNotificationFn;
  readonly removeNotification: RemoveNotificationFn;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(
  null,
);

export interface NotificationsProviderProps {
  readonly children: ReactNode;
  readonly initialState?: NotificationsState;
}

const EMPTY_STATE: NotificationsState = { queue: [], current: null };

export function NotificationsProvider({
  children,
  initialState,
}: NotificationsProviderProps): React.ReactElement {
  const [state, setState] = useState<NotificationsState>(
    initialState ?? EMPTY_STATE,
  );

  // Track the active timeout so an incoming `immediate` notification can
  // pre-empt the currently displayed toast cleanly.
  const currentTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearActiveTimeout = useCallback(() => {
    if (currentTimeoutIdRef.current !== null) {
      clearTimeout(currentTimeoutIdRef.current);
      currentTimeoutIdRef.current = null;
    }
  }, []);

  // Process queue when current notification finishes or queue changes.
  // Promotes the highest-priority queued notification into `current` if
  // nothing is currently displayed.
  const processQueue = useCallback((): void => {
    setState((prev) => {
      const next = getNext(prev.queue);
      if (prev.current !== null || !next) {
        return prev;
      }
      currentTimeoutIdRef.current = setTimeout(() => {
        currentTimeoutIdRef.current = null;
        setState((p) => {
          // Compare by key instead of reference to handle re-created notifications
          if (p.current?.key !== next.key) {
            return p;
          }
          return { queue: p.queue, current: null };
        });
        // Re-run after the current finishes to drain the rest of the queue.
        processQueue();
      }, next.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      return {
        queue: prev.queue.filter((entry) => entry !== next),
        current: next,
      };
    });
  }, []);

  const addNotification = useCallback<AddNotificationFn>(
    (notif) => {
      // Handle immediate priority notifications
      if (notif.priority === "immediate") {
        clearActiveTimeout();

        currentTimeoutIdRef.current = setTimeout(() => {
          currentTimeoutIdRef.current = null;
          setState((prev) => {
            if (prev.current?.key !== notif.key) {
              return prev;
            }
            return {
              queue: prev.queue.filter(
                (entry) => !notif.invalidates?.includes(entry.key),
              ),
              current: null,
            };
          });
          processQueue();
        }, notif.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        // Show the immediate notification right away. Re-queue the prior
        // current entry only if it wasn't itself immediate (immediate
        // notifications are not re-queued, they get dropped).
        setState((prev) => ({
          current: notif,
          queue: [
            ...(prev.current ? [prev.current] : []),
            ...prev.queue,
          ].filter(
            (entry) =>
              entry.priority !== "immediate" &&
              !notif.invalidates?.includes(entry.key),
          ),
        }));
        return;
      }

      // Handle non-immediate notifications
      setState((prev) => {
        // Check if we can fold into an existing notification with the same key
        if (notif.fold) {
          // Fold into current notification if keys match
          if (prev.current?.key === notif.key) {
            const folded = notif.fold(prev.current, notif);
            // Reset timeout for the folded notification
            clearActiveTimeout();
            currentTimeoutIdRef.current = setTimeout(() => {
              currentTimeoutIdRef.current = null;
              setState((p) => {
                if (p.current?.key !== folded.key) {
                  return p;
                }
                return { queue: p.queue, current: null };
              });
              processQueue();
            }, folded.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            return { current: folded, queue: prev.queue };
          }

          // Fold into queued notification if keys match
          const queueIdx = prev.queue.findIndex(
            (entry) => entry.key === notif.key,
          );
          if (queueIdx !== -1) {
            const folded = notif.fold(prev.queue[queueIdx]!, notif);
            const newQueue = [...prev.queue];
            newQueue[queueIdx] = folded;
            return { current: prev.current, queue: newQueue };
          }
        }

        // Only add to queue if not already present (prevent duplicates)
        const queuedKeys = new Set(prev.queue.map((entry) => entry.key));
        const shouldAdd =
          !queuedKeys.has(notif.key) && prev.current?.key !== notif.key;
        if (!shouldAdd) return prev;

        const invalidatesCurrent =
          prev.current !== null &&
          (notif.invalidates?.includes(prev.current.key) ?? false);
        if (invalidatesCurrent) {
          clearActiveTimeout();
        }

        return {
          current: invalidatesCurrent ? null : prev.current,
          queue: [
            ...prev.queue.filter(
              (entry) =>
                entry.priority !== "immediate" &&
                !notif.invalidates?.includes(entry.key),
            ),
            notif,
          ],
        };
      });

      // Process queue after adding the notification
      processQueue();
    },
    [clearActiveTimeout, processQueue],
  );

  const removeNotification = useCallback<RemoveNotificationFn>(
    (key) => {
      setState((prev) => {
        const isCurrent = prev.current?.key === key;
        const inQueue = prev.queue.some((entry) => entry.key === key);
        if (!isCurrent && !inQueue) {
          return prev;
        }
        if (isCurrent) {
          clearActiveTimeout();
        }
        return {
          current: isCurrent ? null : prev.current,
          queue: prev.queue.filter((entry) => entry.key !== key),
        };
      });
      processQueue();
    },
    [clearActiveTimeout, processQueue],
  );

  // Process queue on mount if there are notifications in the initial state.
  useEffect(() => {
    if (state.queue.length > 0 && state.current === null) {
      processQueue();
    }
    // Mount-only — `state` is intentionally not in the dependency list to
    // avoid re-running this on every state change. `processQueue` is
    // stable (useCallback with no deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up any pending timeout on unmount.
  useEffect(() => {
    return () => {
      clearActiveTimeout();
    };
  }, [clearActiveTimeout]);

  const value = useMemo<NotificationsContextValue>(
    () => ({ state, addNotification, removeNotification }),
    [state, addNotification, removeNotification],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

/**
 * Push and remove inline toast notifications. Throws when used outside a
 * {@link NotificationsProvider} so consumer wiring bugs surface early.
 */
export function useNotifications(): {
  addNotification: AddNotificationFn;
  removeNotification: RemoveNotificationFn;
} {
  const ctx = useContext(NotificationsContext);
  if (ctx === null) {
    throw new Error(
      "useNotifications must be used inside <NotificationsProvider>",
    );
  }
  return {
    addNotification: ctx.addNotification,
    removeNotification: ctx.removeNotification,
  };
}

/**
 * Read the current notification state. Returns `{ queue: [], current: null }`
 * when called outside the provider — used by status surfaces that may
 * render before the provider is mounted.
 */
export function useNotificationsState(): NotificationsState {
  const ctx = useContext(NotificationsContext);
  return ctx?.state ?? EMPTY_STATE;
}
