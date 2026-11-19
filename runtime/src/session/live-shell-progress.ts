import { AsyncLocalStorage } from "node:async_hooks";

// Display-only scope. It never enters provider options or tool arguments.
const live = new AsyncLocalStorage<boolean>();
export const liveShellProgressEnabled = (): boolean => live.getStore() === true;
export const withLiveShellProgress = <T>(enabled: boolean, task: () => T): T => live.run(enabled, task);
