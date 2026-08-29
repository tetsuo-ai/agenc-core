import { AsyncLocalStorage } from "node:async_hooks";

export interface StartupProviderSelectionSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const startupProviderSelection =
  new AsyncLocalStorage<StartupProviderSelectionSnapshot>();

export function runWithStartupProviderSelectionSnapshot<T>(
  selection: StartupProviderSelectionSnapshot,
  operation: () => T,
): T {
  return startupProviderSelection.run(selection, operation);
}

export function readStartupProviderSelectionSnapshot():
  | StartupProviderSelectionSnapshot
  | undefined {
  return startupProviderSelection.getStore();
}

export function enterStartupProviderSelectionSnapshotForTests(
  selection: StartupProviderSelectionSnapshot,
): void {
  startupProviderSelection.enterWith(selection);
}
