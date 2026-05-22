import { useSyncExternalStore } from "react";

import { getWorkbenchBufferStore, type WorkbenchBufferSnapshot } from "./BufferStore.js";

export function useBufferStore(): WorkbenchBufferSnapshot {
  const store = getWorkbenchBufferStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
