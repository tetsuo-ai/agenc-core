// T10 Group D — ConfigStore: snapshot + reload + subscribers.
//
// - `current()` returns the frozen current snapshot.
// - `reload()` re-reads disk + env, updates the snapshot, notifies subscribers.
// - `subscribe(listener)` returns an unsubscribe function.
//
// No global state — each ConfigStore is instantiable. bin/agenc.ts
// integration constructs one; SIGUSR1 → reload() wiring lives in T10-I.

import type { AgenCConfig } from "./schema.js";
import { defaultConfig } from "./schema.js";
import type { EnvSnapshot } from "./env.js";
import { applyEnvOverrides } from "./env.js";
import type { LoadConfigOptions } from "./loader.js";
import { loadConfig } from "./loader.js";

export type ConfigStoreListener = (config: AgenCConfig) => void;

export interface ConfigStoreOptions {
  /** Override AgenC home (defaults to env-resolved path). */
  readonly home?: string;
  /** Base config (defaults to `defaultConfig()`). */
  readonly base?: AgenCConfig;
  /** Env snapshot (defaults to `process.env`). */
  readonly env?: EnvSnapshot;
  /** Warning sink for TOML parse errors / read failures. */
  readonly onWarn?: (msg: string) => void;
  /**
   * If provided, called instead of the built-in `loadConfig`.
   * Used to inject fixtures in tests.
   */
  readonly loader?: (opts: LoadConfigOptions) => Promise<AgenCConfig>;
}

export class ConfigStore {
  private snapshot: AgenCConfig;
  private readonly listeners = new Set<ConfigStoreListener>();
  private readonly opts: ConfigStoreOptions;

  constructor(opts: ConfigStoreOptions = {}) {
    this.opts = opts;
    // Start from defaults + env — safe to call before first reload().
    const base = opts.base ?? defaultConfig();
    this.snapshot = applyEnvOverrides(base, opts.env, opts.onWarn);
  }

  /** Current frozen snapshot. Never mutates. */
  current(): AgenCConfig {
    return this.snapshot;
  }

  /**
   * AgenC home directory the store was constructed against, or
   * `undefined` when no override was provided (the loader falls back to
   * its internal env-resolved default in that case). Used by the
   * per-turn relevant-memory attachment producer to derive
   * `<agencHome>/memory` without re-resolving HOME.
   */
  get agencHome(): string | undefined {
    return this.opts.home;
  }

  /**
   * Re-read TOML + env, recompute snapshot, notify subscribers.
   * Returns the new snapshot. Subscriber exceptions are isolated via try/catch
   * so one broken listener cannot poison the reload.
   */
  async reload(): Promise<AgenCConfig> {
    const base = this.opts.base ?? defaultConfig();
    let loaded: AgenCConfig;
    if (this.opts.loader) {
      loaded = await this.opts.loader({
        home: this.opts.home,
        base,
        onWarn: this.opts.onWarn,
      });
    } else {
      const result = await loadConfig({
        home: this.opts.home,
        base,
        onWarn: this.opts.onWarn,
      });
      loaded = result.config;
    }
    const next = applyEnvOverrides(loaded, this.opts.env, this.opts.onWarn);
    this.snapshot = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err) {
        const warn = this.opts.onWarn ?? ((m: string) => console.warn(m));
        warn(`[agenc:config] subscriber threw during reload: ${String(err)}`);
      }
    }
    return next;
  }

  /**
   * Register a listener for snapshot changes. Returns an unsubscribe
   * function. Listeners fire on each successful `reload()`.
   */
  subscribe(listener: ConfigStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of active subscribers (test introspection). */
  subscriberCount(): number {
    return this.listeners.size;
  }
}
