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
import { type HomeContext, resolveHomeContext } from "./home.js";
import {
  type ConfigScope,
  loadLayeredConfig,
  type ConfigLayerSnapshot,
  type ConfigProvenanceEntry,
  type IgnoredConfigValue,
  type LayeredConfigRepositoryOptions,
} from "./repository.js";
import { isProjectTrustedSync } from "../permissions/trust/project-trust.js";
import { enterCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { RuntimeStateRepository } from "./runtime-state-repository.js";

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
  /** Workspace used to resolve project/local configuration layers. */
  readonly cwd?: string;
  readonly projectRoot?: string;
  /** Explicit trust decision; omitted means consult the canonical trust ledger. */
  readonly projectTrusted?: boolean;
  /** Retain repository command hooks for later session-authority filtering. */
  readonly retainUntrustedProjectCommandHooks?: boolean;
  readonly flagConfigPath?: string;
  readonly managedConfigPath?: string;
  readonly managedDropInDir?: string;
  readonly profileName?: string;
  readonly cliOverrides?:
    | AgenCConfig
    | ((config: AgenCConfig) => AgenCConfig | undefined);
  /** Explicit test/embedding seam; the repository must own this store's home. */
  readonly stateRepository?: RuntimeStateRepository;
  /**
   * Test-only fixture seam. Production uses the strict layered repository.
   * Used to inject fixtures in tests.
   */
  readonly loader?: (opts: {
    readonly home?: string;
    readonly base?: AgenCConfig;
    readonly onWarn?: (message: string) => void;
  }) => Promise<AgenCConfig>;
}

export class ConfigStore {
  private snapshot: AgenCConfig;
  private readonly listeners = new Set<ConfigStoreListener>();
  private readonly opts: ConfigStoreOptions;
  private readonly environment: EnvSnapshot;
  private warningMessages: string[] = [];
  private provenanceSnapshot: Readonly<Record<string, ConfigProvenanceEntry>> =
    Object.freeze({});
  private ignoredSnapshot: readonly IgnoredConfigValue[] = Object.freeze([]);
  private sourceSnapshots: readonly ConfigLayerSnapshot[] = Object.freeze([]);
  private reloadTail: Promise<void> = Promise.resolve();
  private resolvedProjectRoot: string;
  private readonly resolvedHomeContext: HomeContext;
  readonly stateRepository: RuntimeStateRepository;

  constructor(opts: ConfigStoreOptions = {}) {
    const sourceEnvironment = opts.env ?? process.env;
    this.environment = Object.freeze({
      ...sourceEnvironment,
      ...(opts.home !== undefined ? { AGENC_HOME: opts.home } : {}),
    });
    this.opts = Object.freeze({ ...opts, env: this.environment });
    // Start from defaults + env — safe to call before first reload().
    const base = opts.base ?? defaultConfig();
    this.snapshot = applyEnvOverrides(base, this.environment, opts.onWarn);
    this.resolvedProjectRoot = opts.projectRoot ?? opts.cwd ?? process.cwd();
    this.resolvedHomeContext = resolveHomeContext(this.environment, {
      ...(this.environment.HOME !== undefined
        ? { platformHome: this.environment.HOME }
        : {}),
    });
    if (
      opts.stateRepository !== undefined &&
      opts.stateRepository.homeContext.path !== this.resolvedHomeContext.path
    ) {
      throw new Error(
        `State repository home ${opts.stateRepository.homeContext.path} does not match ConfigStore home ${this.resolvedHomeContext.path}`,
      );
    }
    this.stateRepository = opts.stateRepository ??
      new RuntimeStateRepository(this.resolvedHomeContext);
  }

  /** Current frozen snapshot. Never mutates. */
  current(): AgenCConfig {
    return this.snapshot;
  }

  /** Atomic config + ordered-layer view for generation-sensitive consumers. */
  authoritySnapshot(): Readonly<{
    config: AgenCConfig;
    layers: readonly ConfigLayerSnapshot[];
  }> {
    return Object.freeze({
      config: this.snapshot,
      layers: this.sourceSnapshots,
    });
  }

  /** Warnings emitted during the most recent reload. */
  warnings(): readonly string[] {
    return [...this.warningMessages];
  }

  /** Field-level origin from the most recent strict layered reload. */
  provenance(key: string): ConfigProvenanceEntry | undefined {
    return this.provenanceSnapshot[key];
  }

  /** Repository values intentionally ignored by the authority boundary. */
  ignored(): readonly IgnoredConfigValue[] {
    return this.ignoredSnapshot;
  }

  /** Strict, sanitized source layers from the most recent repository load. */
  sources(scope: ConfigScope): readonly ConfigLayerSnapshot[] {
    return Object.freeze(
      this.sourceSnapshots.filter((snapshot) => snapshot.scope === scope),
    );
  }

  /** Canonical project root used for project/local layer resolution. */
  get projectRoot(): string {
    return this.resolvedProjectRoot;
  }

  /** Canonical home resolved from this store's own immutable environment. */
  get homeContext(): HomeContext {
    return this.resolvedHomeContext;
  }

  /** Canonical AgenC home bound to this store's immutable environment. */
  get agencHome(): string {
    return this.resolvedHomeContext.path;
  }

  /**
   * Re-read TOML + env, recompute snapshot, notify subscribers.
   * Returns the new snapshot. Subscriber exceptions are isolated via try/catch
   * so one broken listener cannot poison the reload.
   */
  reload(): Promise<AgenCConfig> {
    // Run before the first await so the reload and its caller continuation
    // inherit this store without a process-global authority.
    enterCanonicalSettingsAuthority(this);
    const run = this.reloadTail.then(() => this.reloadUnlocked());
    this.reloadTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reloadUnlocked(): Promise<AgenCConfig> {
    this.stateRepository.invalidate();
    const base = this.opts.base ?? defaultConfig();
    this.warningMessages = [];
    const onWarn = (message: string): void => {
      this.warningMessages.push(message);
      (this.opts.onWarn ?? ((msg: string) => console.warn(msg)))(message);
    };
    let next: AgenCConfig;
    if (this.opts.loader) {
      const loaded = await this.opts.loader({
        home: this.opts.home,
        base,
        onWarn,
      });
      next = applyEnvOverrides(loaded, this.environment, onWarn);
      this.provenanceSnapshot = Object.freeze({});
      this.ignoredSnapshot = Object.freeze([]);
      this.sourceSnapshots = Object.freeze([]);
    } else {
      const env = this.environment;
      const home = this.resolvedHomeContext;
      const repositoryOptions: LayeredConfigRepositoryOptions = {
        env,
        home,
        ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
        ...(this.opts.projectRoot !== undefined
          ? { projectRoot: this.opts.projectRoot }
          : {}),
        ...(this.opts.flagConfigPath !== undefined
          ? { flagConfigPath: this.opts.flagConfigPath }
          : {}),
        ...(this.opts.managedConfigPath !== undefined
          ? { managedConfigPath: this.opts.managedConfigPath }
          : {}),
        ...(this.opts.managedDropInDir !== undefined
          ? { managedDropInDir: this.opts.managedDropInDir }
          : {}),
        ...(this.opts.profileName !== undefined
          ? { profileName: this.opts.profileName }
          : {}),
        ...(this.opts.cliOverrides !== undefined
          ? { cliOverrides: this.opts.cliOverrides }
          : {}),
        ...(this.opts.base !== undefined
          ? { pluginDefaults: this.opts.base }
          : {}),
        onWarn,
        projectTrusted: this.opts.projectTrusted ?? false,
        retainUntrustedProjectCommandHooks:
          this.opts.retainUntrustedProjectCommandHooks === true,
      };
      let loaded = await loadLayeredConfig(repositoryOptions);
      const projectTrusted = this.opts.projectTrusted ?? isProjectTrustedSync({
        agencHome: home.path,
        env: env as NodeJS.ProcessEnv,
        projectRoot: loaded.projectRoot,
      });
      if (projectTrusted && this.opts.projectTrusted === undefined) {
        loaded = await loadLayeredConfig({
          ...repositoryOptions,
          projectTrusted: true,
        });
      }
      next = loaded.config;
      this.provenanceSnapshot = loaded.provenance;
      this.ignoredSnapshot = loaded.ignored;
      this.sourceSnapshots = loaded.sources;
      this.resolvedProjectRoot = loaded.projectRoot;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err) {
        onWarn(`[agenc:config] subscriber threw during reload: ${String(err)}`);
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
