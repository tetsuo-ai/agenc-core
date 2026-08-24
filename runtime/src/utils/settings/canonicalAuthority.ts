import { AsyncLocalStorage } from "node:async_hooks";

import type { HomeContext } from "../../config/home.js";
import type {
  ConfigLayerSnapshot,
  ConfigScope,
} from "../../config/repository.js";
import type { AgenCConfig } from "../../config/schema.js";
import type { RuntimeStateRepository } from "../../config/runtime-state-repository.js";

/**
 * Narrow ConfigStore surface bound to one request/session async chain, never
 * a process-global slot.
 */
export interface CanonicalSettingsAuthority {
  readonly current: () => AgenCConfig;
  readonly sources: (scope: ConfigScope) => readonly ConfigLayerSnapshot[];
  readonly projectRoot: string;
  readonly homeContext: HomeContext;
  readonly stateRepository: RuntimeStateRepository;
  readonly reload: () => Promise<unknown>;
  readonly subscribe: (
    listener: (config: AgenCConfig) => void,
  ) => (() => void) | void;
}

const authorityStorage = new AsyncLocalStorage<
  CanonicalSettingsAuthority | null
>();

/**
 * Bind an authority to the current asynchronous execution chain. This is
 * called before ConfigStore.reload() reaches its first await, so the caller's
 * continuation inherits the same store while concurrent sessions stay
 * isolated.
 */
export function enterCanonicalSettingsAuthority(
  authority: CanonicalSettingsAuthority,
): void {
  authorityStorage.enterWith(authority);
}

/** Explicit scope helper for detached/session task boundaries and tests. */
export function runWithCanonicalSettingsAuthority<T>(
  authority: CanonicalSettingsAuthority,
  fn: () => T,
): T {
  return authorityStorage.run(authority, fn);
}

export function getCanonicalSettingsAuthority():
  | CanonicalSettingsAuthority
  | null {
  return authorityStorage.getStore() ?? null;
}

export function getCanonicalConfigLayers(
  scope: ConfigScope,
  authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
): readonly ConfigLayerSnapshot[] {
  return authority?.sources(scope) ?? Object.freeze([]);
}

export function resetCanonicalSettingsAuthorityForTesting(): void {
  authorityStorage.enterWith(null);
}
