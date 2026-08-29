// T10 Group D — ConfigStore: snapshot + reload + subscribers.
//
// - `current()` returns the frozen current snapshot.
// - `reload()` re-reads disk + env, updates the snapshot, notifies subscribers.
// - `subscribe(listener)` returns an unsubscribe function.
//
// No global state — each ConfigStore is instantiable. bin/agenc.ts
// integration constructs one; SIGUSR1 → reload() wiring lives in T10-I.

import { dirname, resolve } from "node:path";

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
import type { CanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { mergeProviderModelLayer } from "./provider-model-authority.js";
import {
  resolveManagedPathContext,
  type ManagedPathContext,
} from "../utils/settings/managedPath.js";

export interface ConfigStorePublicationMetadata {
  /**
   * Identifies who owns publication of permission authority for this config
   * generation. Direct reloads require the ConfigStore subscriber to publish
   * it; daemon-coordinated reloads publish it inside the registry transaction.
   */
  readonly permissionAuthority:
    | "requires_subscriber_publication"
    | "coordinated_by_permission_mode_registry";
}

export interface CoordinatedConfigStorePublishOptions {
  readonly permissionAuthority: "coordinated_by_permission_mode_registry";
}

export const COORDINATED_CONFIG_STORE_PUBLICATION = Object.freeze({
  permissionAuthority: "coordinated_by_permission_mode_registry" as const,
});

const DIRECT_CONFIG_STORE_PUBLICATION = Object.freeze({
  permissionAuthority: "requires_subscriber_publication" as const,
});

export type ConfigStoreListener = (
  config: AgenCConfig,
  publication: ConfigStorePublicationMetadata,
) => void;

/**
 * Read-only authority surface shared by the live store and a prepared reload.
 * A prepared authority never publishes its snapshot or accepts another reload.
 */
export interface ConfigStoreAuthority extends CanonicalSettingsAuthority {
  readonly warnings: () => readonly string[];
  readonly provenance: (key: string) => ConfigProvenanceEntry | undefined;
  readonly ignored: () => readonly IgnoredConfigValue[];
}

/**
 * One staged reload. The owner must settle it after either publishing or
 * rolling back so later reloads cannot interleave with lifecycle settlement.
 */
export interface PreparedConfigStoreReload {
  readonly config: AgenCConfig;
  readonly authority: ConfigStoreAuthority;
  readonly state: "prepared" | "committed" | "published" | "rolled_back";
  readonly settled: boolean;
  commit(): void;
  publish(options?: CoordinatedConfigStorePublishOptions): void;
  rollback(): void;
  settle(): void;
}

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
  readonly cliOverrides?: AgenCConfig;
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

interface ConfigStoreState {
  readonly snapshot: AgenCConfig;
  readonly warnings: readonly string[];
  readonly provenance: Readonly<Record<string, ConfigProvenanceEntry>>;
  readonly ignored: readonly IgnoredConfigValue[];
  readonly sources: readonly ConfigLayerSnapshot[];
  readonly projectRoot: string;
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
  private reloadGeneration = 0;
  private resolvedProjectRoot: string;
  private readonly resolvedHomeContext: HomeContext;
  private readonly resolvedManagedPaths: ManagedPathContext;
  readonly stateRepository: RuntimeStateRepository;

  constructor(opts: ConfigStoreOptions = {}) {
    const sourceEnvironment = opts.env ?? process.env;
    this.environment = Object.freeze({
      ...sourceEnvironment,
      ...(opts.home !== undefined ? { AGENC_HOME: opts.home } : {}),
    });
    this.opts = Object.freeze({ ...opts, env: this.environment });
    // Start from defaults + env — safe to call before first reload().
    const base = mergeProviderModelLayer(defaultConfig(), opts.base ?? {});
    this.snapshot = applyEnvOverrides(base, this.environment, opts.onWarn);
    this.resolvedProjectRoot = opts.projectRoot ?? opts.cwd ?? process.cwd();
    this.resolvedHomeContext = resolveHomeContext(this.environment, {
      ...(this.environment.HOME !== undefined
        ? { platformHome: this.environment.HOME }
        : {}),
    });
    const managedRootPath = opts.managedConfigPath === undefined
      ? undefined
      : dirname(resolve(opts.managedConfigPath));
    this.resolvedManagedPaths = resolveManagedPathContext(
      this.environment,
      process.platform,
      managedRootPath,
    );
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

  /** Machine-wide Markdown paths captured from this store's environment. */
  get managedPaths(): ManagedPathContext {
    return this.resolvedManagedPaths;
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
    return this.reloadPreparedAndPublish();
  }

  private async reloadPreparedAndPublish(): Promise<AgenCConfig> {
    const prepared = await this.prepareReload();
    try {
      prepared.commit();
      prepared.publish();
      prepared.settle();
      return prepared.config;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        prepared.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        prepared.settle();
      } catch (settleError) {
        rollbackErrors.push(settleError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "config reload failed; rollback was incomplete",
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Load and validate a new repository generation without changing the live
   * store or notifying subscribers. Reload serialization remains held until
   * the returned handle is settled.
   */
  prepareReload(): Promise<PreparedConfigStoreReload> {
    // Run before the first await so the caller continuation inherits this
    // store without a process-global authority.
    enterCanonicalSettingsAuthority(this);
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = this.reloadTail.then(async () => {
      try {
        return await this.prepareReloadUnlocked(release);
      } catch (error) {
        release();
        throw error;
      }
    });
    this.reloadTail = run.then(
      () => settled,
      () => undefined,
    );
    return run;
  }

  private captureState(): ConfigStoreState {
    return {
      snapshot: this.snapshot,
      warnings: this.warningMessages,
      provenance: this.provenanceSnapshot,
      ignored: this.ignoredSnapshot,
      sources: this.sourceSnapshots,
      projectRoot: this.resolvedProjectRoot,
    };
  }

  private applyState(state: ConfigStoreState): void {
    this.snapshot = state.snapshot;
    this.warningMessages = [...state.warnings];
    this.provenanceSnapshot = state.provenance;
    this.ignoredSnapshot = state.ignored;
    this.sourceSnapshots = state.sources;
    this.resolvedProjectRoot = state.projectRoot;
  }

  private notifyListeners(
    config: AgenCConfig,
    warnings: string[],
    publication: ConfigStorePublicationMetadata,
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(config, publication);
      } catch (err) {
        const message =
          `[agenc:config] subscriber threw during reload: ${String(err)}`;
        warnings.push(message);
        this.emitWarning(message);
      }
    }
  }

  private emitWarning(message: string): void {
    try {
      (this.opts.onWarn ?? ((msg: string) => console.warn(msg)))(message);
    } catch {
      // Warning sinks are observers. They cannot veto or split publication.
    }
  }

  private async prepareReloadUnlocked(
    release: () => void,
  ): Promise<PreparedConfigStoreReload> {
    const previous = this.captureState();
    const generation = this.reloadGeneration;
    const base = mergeProviderModelLayer(
      defaultConfig(),
      this.opts.base ?? {},
    );
    const warningMessages: string[] = [];
    const onWarn = (message: string): void => {
      warningMessages.push(message);
    };
    let next: AgenCConfig;
    let provenance: Readonly<Record<string, ConfigProvenanceEntry>> =
      Object.freeze({});
    let ignored: readonly IgnoredConfigValue[] = Object.freeze([]);
    let sources: readonly ConfigLayerSnapshot[] = Object.freeze([]);
    let projectRoot = previous.projectRoot;
    if (this.opts.loader) {
      const loaded = await this.opts.loader({
        home: this.opts.home,
        base,
        onWarn,
      });
      next = applyEnvOverrides(
        mergeProviderModelLayer(defaultConfig(), loaded),
        this.environment,
        onWarn,
      );
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
      provenance = loaded.provenance;
      ignored = loaded.ignored;
      sources = loaded.sources;
      projectRoot = loaded.projectRoot;
    }
    const staged: ConfigStoreState = {
      snapshot: next,
      warnings: warningMessages,
      provenance,
      ignored,
      sources,
      projectRoot,
    };
    const thisStore = this;
    const authority: ConfigStoreAuthority = Object.freeze({
      current: () => staged.snapshot,
      authoritySnapshot: () => Object.freeze({
        config: staged.snapshot,
        layers: staged.sources,
      }),
      sources: (scope: ConfigScope) => Object.freeze(
        staged.sources.filter((snapshot) => snapshot.scope === scope),
      ),
      get projectRoot() {
        return staged.projectRoot;
      },
      get homeContext() {
        return thisStore.resolvedHomeContext;
      },
      get managedPaths() {
        return thisStore.resolvedManagedPaths;
      },
      get stateRepository() {
        return thisStore.stateRepository;
      },
      reload: async () => {
        throw new Error("a prepared config authority cannot reload itself");
      },
      subscribe: () => {
        throw new Error("a prepared config authority cannot add subscribers");
      },
      warnings: () => [...staged.warnings],
      provenance: (key: string) => staged.provenance[key],
      ignored: () => staged.ignored,
    });
    let state: "prepared" | "committed" | "published" | "rolled_back" =
      "prepared";
    let publicationMetadata: ConfigStorePublicationMetadata =
      DIRECT_CONFIG_STORE_PUBLICATION;
    let isSettled = false;
    const assertGeneration = (expected: number): void => {
      if (this.reloadGeneration !== expected) {
        throw new Error("config reload generation changed during publication");
      }
    };
    return Object.freeze({
      config: staged.snapshot,
      authority,
      get state() {
        return state;
      },
      get settled() {
        return isSettled;
      },
      commit: () => {
        if (isSettled || state !== "prepared") {
          throw new Error(`prepared config reload cannot commit from ${state}`);
        }
        assertGeneration(generation);
        this.applyState(staged);
        this.stateRepository.invalidate();
        this.reloadGeneration += 1;
        state = "committed";
      },
      publish: (options?: CoordinatedConfigStorePublishOptions) => {
        if (isSettled || state !== "committed") {
          throw new Error(`prepared config reload cannot publish from ${state}`);
        }
        publicationMetadata =
          options?.permissionAuthority ===
          "coordinated_by_permission_mode_registry"
            ? COORDINATED_CONFIG_STORE_PUBLICATION
            : DIRECT_CONFIG_STORE_PUBLICATION;
        state = "published";
        for (const message of warningMessages) this.emitWarning(message);
        this.notifyListeners(
          staged.snapshot,
          this.warningMessages,
          publicationMetadata,
        );
      },
      rollback: () => {
        if (isSettled) {
          throw new Error("settled config reload cannot roll back");
        }
        if (state === "rolled_back") return;
        if (state === "committed" || state === "published") {
          assertGeneration(generation + 1);
          const notifyRestoredAuthority = state === "published";
          this.applyState(previous);
          this.stateRepository.invalidate();
          this.reloadGeneration += 1;
          if (notifyRestoredAuthority) {
            this.notifyListeners(
              previous.snapshot,
              this.warningMessages,
              publicationMetadata,
            );
          }
        }
        state = "rolled_back";
      },
      settle: () => {
        if (isSettled) return;
        if (state !== "published" && state !== "rolled_back") {
          throw new Error(`prepared config reload cannot settle from ${state}`);
        }
        isSettled = true;
        release();
      },
    });
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
