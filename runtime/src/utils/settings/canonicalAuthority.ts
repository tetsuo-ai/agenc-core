import { AsyncLocalStorage } from "node:async_hooks";

import type { HomeContext } from "../../config/home.js";
import type {
  ConfigLayerSnapshot,
  ConfigScope,
} from "../../config/repository.js";
import type { AgenCConfig } from "../../config/schema.js";
import type { RuntimeStateRepository } from "../../config/runtime-state-repository.js";
import type { ManagedPathContext } from "./managedPath.js";

/**
 * Narrow ConfigStore surface bound to one request/session async chain, never
 * a process-global slot.
 */
export interface CanonicalSettingsAuthority {
  readonly authoritySnapshot: () => Readonly<{
    config: AgenCConfig;
    layers: readonly ConfigLayerSnapshot[];
  }>;
  readonly current: () => AgenCConfig;
  readonly sources: (scope: ConfigScope) => readonly ConfigLayerSnapshot[];
  readonly projectRoot: string;
  readonly homeContext: HomeContext;
  readonly managedPaths: ManagedPathContext;
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

/**
 * Process-local cache partitioned by the exact ConfigStore authority object.
 * Weak authority keys keep completed daemon sessions collectible even when
 * their workspace, home, and runtime paths match another live session.
 */
export class CanonicalAuthorityCache<V> {
  private partitions = new WeakMap<CanonicalSettingsAuthority, Map<string, V>>();

  private authority(
    explicit: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
  ): CanonicalSettingsAuthority {
    if (explicit === null) {
      throw new Error("Canonical authority cache requires a ConfigStore authority");
    }
    return explicit;
  }

  get(
    key: string,
    authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
  ): V | undefined {
    return this.partitions.get(this.authority(authority))?.get(key);
  }

  set(
    key: string,
    value: V,
    authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
  ): void {
    const owner = this.authority(authority);
    let partition = this.partitions.get(owner);
    if (partition === undefined) {
      partition = new Map<string, V>();
      this.partitions.set(owner, partition);
    }
    partition.set(key, value);
  }

  delete(
    key: string,
    authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
  ): boolean {
    const owner = this.authority(authority);
    const partition = this.partitions.get(owner);
    if (partition === undefined) return false;
    const deleted = partition.delete(key);
    if (partition.size === 0) this.partitions.delete(owner);
    return deleted;
  }

  values(
    authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
  ): readonly V[] {
    return [...(this.partitions.get(this.authority(authority))?.values() ?? [])];
  }

  clearAuthority(
    authority: CanonicalSettingsAuthority | null = getCanonicalSettingsAuthority(),
  ): void {
    this.partitions.delete(this.authority(authority));
  }

  clear(): void {
    this.partitions = new WeakMap<CanonicalSettingsAuthority, Map<string, V>>();
  }
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
