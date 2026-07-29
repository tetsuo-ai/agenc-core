import React from "react";
import { basename } from "node:path";

import type { TaskState } from "../tasks/types.js";
import { Box, Text } from "../ink.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import { useRegisterKeybindingContext } from "../keybindings/KeybindingContext.js";
import { useInputCapture } from "../keybindings/useKeybinding.js";
import { useAppState } from "../state/AppState.js";
import { taskMayReferencePath } from "./agents/activity.js";
import { getWorkbenchBufferProviderController } from "./buffer/providers/BufferProviderController.js";
import type { BufferProviderSnapshot } from "./buffer/providers/types.js";
import { useBufferStore } from "./buffer/useBufferStore.js";
import { useWorkbenchDispatch, useWorkbenchState } from "./state.js";

export function DirtyBufferLeaveOverlay(): React.ReactElement | null {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const tasks = useAppState((state) => state.tasks);
  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;
  const pending = workbench.pendingBlockedOverlay;
  const pendingIdentityRef = React.useRef(pending);
  const operationEpochRef = React.useRef(0);
  const operationLockIdRef = React.useRef(0);
  useRegisterOverlay("dirty-buffer-leave", pending !== null);
  useRegisterKeybindingContext("Modal", pending !== null);
  const snapshot = useBufferStore();
  const dirtyBuffers = (snapshot.buffers ?? []).filter((buffer) => buffer.modified);
  const [operation, setOperation] = React.useState<
    "idle" | "saving" | "preparing-discard" | "discarding"
  >("idle");
  const operationRef = React.useRef<
    "idle" | "saving" | "preparing-discard" | "discarding"
  >("idle");
  const [discardConfirmation, setDiscardConfirmation] =
    React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useLayoutEffect(() => {
    if (pendingIdentityRef.current === pending) return;
    pendingIdentityRef.current = pending;
    operationEpochRef.current += 1;
  }, [pending]);

  React.useEffect(() => {
    // Replacing the deferred request invalidates the old result, but it
    // cannot cancel a save/discard RPC that already crossed the provider
    // boundary. Keep that mutation lock until its own promise settles.
    setOperation(operationRef.current);
    setDiscardConfirmation(null);
    setError(null);
  }, [pending?.requestId]);

  const resolve = React.useCallback(() => {
    if (pending === null) return;
    dispatch({
      type: "resolveBlockedOverlay",
      requestId: pending.requestId,
    });
  }, [dispatch, pending]);

  const saveAll = React.useCallback(async () => {
    if (pending === null || operationRef.current !== "idle") return;
    const operationEpoch = ++operationEpochRef.current;
    const operationLockId = ++operationLockIdRef.current;
    const isCurrentOperation = () =>
      operationEpochRef.current === operationEpoch &&
      pendingIdentityRef.current === pending;
    operationRef.current = "saving";
    setOperation("saving");
    setError(null);
    try {
      const liveSnapshot =
        getWorkbenchBufferProviderController().getSnapshot();
      const result = await getWorkbenchBufferProviderController().saveAll({
        hasInFlightAgent: dirtyBuffersHaveInFlightAgent(
          liveSnapshot,
          Object.values(tasksRef.current),
        ),
      });
      if (!isCurrentOperation()) return;
      if (!result.saved) {
        const blockers = result.blockedBuffers
          ?.map((buffer) => basename(buffer.filePath ?? buffer.name) || "[No Name]")
          .filter(Boolean)
          .join(", ");
        setError(
          `${result.reason ?? "Some buffers could not be saved."}${blockers ? ` (${blockers})` : ""}`,
        );
        return;
      }
      resolve();
    } catch (cause) {
      if (!isCurrentOperation()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (operationLockIdRef.current === operationLockId) {
        operationRef.current = "idle";
        setOperation("idle");
      }
    }
  }, [pending, resolve]);

  const discardAll = React.useCallback(async () => {
    if (pending === null || operationRef.current !== "idle") return;
    const operationEpoch = ++operationEpochRef.current;
    const operationLockId = ++operationLockIdRef.current;
    const isCurrentOperation = () =>
      operationEpochRef.current === operationEpoch &&
      pendingIdentityRef.current === pending;
    if (discardConfirmation === null) {
      operationRef.current = "preparing-discard";
      setOperation("preparing-discard");
      setError(null);
      try {
        const confirmation =
          await getWorkbenchBufferProviderController().prepareDiscardAll();
        if (!isCurrentOperation()) return;
        if (confirmation === null) {
          setError(
            "Neovim could not freeze the current dirty-buffer set. Review it and try Discard All again.",
          );
          return;
        }
        setDiscardConfirmation(confirmation);
      } catch (cause) {
        if (!isCurrentOperation()) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (operationLockIdRef.current === operationLockId) {
          operationRef.current = "idle";
          setOperation("idle");
        }
      }
      return;
    }
    operationRef.current = "discarding";
    setOperation("discarding");
    setError(null);
    try {
      const discarded =
        await getWorkbenchBufferProviderController().discardAll(
          discardConfirmation,
        );
      if (!isCurrentOperation()) return;
      if (!discarded) {
        setDiscardConfirmation(null);
        setError(
          "The dirty-buffer set changed or Neovim did not confirm Discard All. Review it and press D twice again.",
        );
        return;
      }
      setDiscardConfirmation(null);
      resolve();
    } catch (cause) {
      if (!isCurrentOperation()) return;
      setDiscardConfirmation(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (operationLockIdRef.current === operationLockId) {
        operationRef.current = "idle";
        setOperation("idle");
      }
    }
  }, [discardConfirmation, pending, resolve]);

  const cancel = React.useCallback(() => {
    if (operationRef.current !== "idle") return;
    operationEpochRef.current += 1;
    dispatch({ type: "clearBlockedOverlay" });
  }, [dispatch]);

  useInputCapture(
    React.useCallback((input, key) => {
      if (pending === null) return false;
      // This is a transaction boundary, not a passive warning. Consume every
      // key in the top-level Modal capture phase so no BUFFER, composer, or
      // global handler can mutate state before this decision is resolved.
      if (key.escape || input.toLowerCase() === "c") {
        cancel();
      } else if (input.toLowerCase() === "s") {
        void saveAll();
      } else if (input.toLowerCase() === "d") {
        void discardAll();
      }
      return true;
    }, [cancel, discardAll, pending, saveAll]),
    { context: "Modal", isActive: pending !== null },
  );

  if (pending === null) return null;
  const names = dirtyBuffers
    .slice(0, 4)
    .map((buffer) => basename(buffer.filePath ?? buffer.name) || "[No Name]")
    .join(", ");
  const remaining = Math.max(0, dirtyBuffers.length - 4);

  return (
    <Box
      flexDirection="column"
      backgroundColor="surfaceBackground"
      paddingX={1}
      paddingY={1}
    >
      <Text color="warning" bold>
        {`Unsaved BUFFER changes block ${pending.attemptedAction}.`}
      </Text>
      <Text color="inactive" wrap="truncate-end">
        {names || `${snapshot.dirtyBufferCount || 1} modified buffer`}
        {remaining > 0 ? ` and ${remaining} more` : ""}
      </Text>
      {error ? <Text color="error" wrap="wrap">{error}</Text> : null}
      {operation === "idle" && discardConfirmation !== null ? (
        <Text color="error">
          Press D again to discard every listed change. This cannot be undone.
        </Text>
      ) : (
        <Text color="text">
          {operation === "saving"
            ? "Saving all buffers…"
            : operation === "preparing-discard"
              ? "Checking the dirty-buffer set…"
            : operation === "discarding"
              ? "Discarding all buffers…"
              : "S Save All   D Discard All   Esc Cancel"}
        </Text>
      )}
    </Box>
  );
}

export function dirtyBuffersHaveInFlightAgent(
  snapshot: BufferProviderSnapshot,
  tasks: readonly TaskState[],
): boolean {
  const dirtyPaths = snapshot.buffers
    .filter((buffer) => buffer.modified)
    .map((buffer) => buffer.filePath ?? buffer.absolutePath)
    .filter((path): path is string => path !== null);
  if (dirtyPaths.length === 0 && snapshot.dirty && snapshot.filePath) {
    dirtyPaths.push(snapshot.filePath);
  }
  return tasks.some((task) =>
    task.type !== "local_bash" &&
    (task.status === "running" || task.status === "pending") &&
    dirtyPaths.some((path) => taskMayReferencePath(task, path))
  );
}
