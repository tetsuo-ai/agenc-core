import { useSyncExternalStore } from "react";

import {
  getWorkbenchBufferProviderController,
} from "./providers/BufferProviderController.js";
import type { BufferProviderSnapshot } from "./providers/types.js";

export function useBufferStore(): BufferProviderSnapshot {
  const store = getWorkbenchBufferProviderController();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
