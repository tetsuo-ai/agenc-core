import { useEffect, useSyncExternalStore } from "react";

import { getProjectTreeStore } from "./ProjectTreeStore.js";
import type { ProjectTreeSnapshot } from "../types.js";

export function useProjectTree(): ProjectTreeSnapshot {
  const store = getProjectTreeStore();
  useEffect(() => {
    store.start();
  }, [store]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
