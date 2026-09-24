// T10 Group D — ConfigStore: snapshot + reload + subscribers.
//
// - `current()` returns the frozen current snapshot.
// - `reload()` re-reads disk + env, updates the snapshot, notifies subscribers.
// - `reloadAgentsSection()` re-reads them for the `[agents]` section only.
// - `limitAgentsSection()` narrows that section when it cannot be re-read.
// - `subscribe(listener)` returns an unsubscribe function.
//
// No global state — each ConfigStore is instantiable. bin/agenc.ts
// integration constructs one; SIGUSR1 → reload() wiring lives in T10-I.

import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { AgenCConfig, AgentsConfig, SubagentEffort, SubagentLimit, SubagentSpeed } from "./schema.js";
import { defaultConfig, SUBAGENT_EFFORTS, SUBAGENT_SPEEDS } from "./schema.js";
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
import {
  enterCanonicalSettingsAuthority,
  runWithCanonicalSettingsAuthority,
} from "../utils/settings/canonicalAuthority.js";
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
  /**
   * Set when only these sections changed and every other value is the
   * previous snapshot's (`reloadAgentsSection`). Absent after a full reload.
   */
  readonly sections?: readonly ConfigStoreSection[];
}

/** A section a live store can take from its sources without a full reload. */
export type ConfigStoreSection = "agents";

export interface ConfigStoreSubscribeOptions {
  /**
   * Also run when only these sections change. Without them a listener runs
   * after full reloads only, so a section change never wakes work such as
   * the MCP, permission and hook reloads.
   */
  readonly sections?: readonly ConfigStoreSection[];
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

const AGENTS_SECTION_PUBLICATION: ConfigStorePublicationMetadata =
  Object.freeze({
    ...DIRECT_CONFIG_STORE_PUBLICATION,
    sections: Object.freeze(["agents" as const]),
  });

let configReadClock = 0;

/**
 * A mark that orders config reads and daemon refreshes in this process: a
 * read whose mark is lower than a refresh's began before that refresh.
 */
export function nextConfigReadMark(): number {
  configReadClock += 1;
  return configReadClock;
}

/**
 * The cross-provider subagent policy that both `current` and `limit` allow:
 * on only if both are on, only the providers both allow, asking at each
 * spawn if either asks, choosing providers automatically only if both do,
 * and each sub-agent limit no higher than either. It is never wider than
 * `current`. An omitted `limit` allows nothing.
 */
export function narrowAgentsConfig(
  current: AgentsConfig | undefined,
  limit: AgentsConfig | undefined,
): AgentsConfig {
  const allowed = new Set(limit?.allowed_providers ?? []);
  return Object.freeze({
    cross_provider_enabled:
      current?.cross_provider_enabled === true &&
      limit?.cross_provider_enabled === true,
    allowed_providers: Object.freeze(
      (current?.allowed_providers ?? []).filter((provider) =>
        allowed.has(provider)
      ),
    ),
    cross_provider_ask_each_spawn:
      current?.cross_provider_ask_each_spawn === true ||
      limit?.cross_provider_ask_each_spawn === true,
    cross_provider_auto:
      current?.cross_provider_auto === true && limit?.cross_provider_auto === true,
    ...withSubagentLimits(lowerSubagentLimits(current?.subagent_limits, limit?.subagent_limits)),
  });
}

/** The `subagent_limits` entry of an `[agents]` section, left out when every limit is the lowest. */
function withSubagentLimits(
  limits: Readonly<Record<string, SubagentLimit>>,
): { readonly subagent_limits?: Readonly<Record<string, SubagentLimit>> } {
  return Object.keys(limits).length > 0 ? { subagent_limits: limits } : {};
}

/** Unset effort and speed are the lowest: each model's lowest level, standard. */
function effortRank(effort: SubagentEffort | undefined): number {
  return effort === undefined ? -1 : SUBAGENT_EFFORTS.indexOf(effort);
}

function speedRank(speed: SubagentSpeed | undefined): number {
  return speed === undefined ? -1 : SUBAGENT_SPEEDS.indexOf(speed);
}

function lowerEffort(a: SubagentEffort | undefined, b: SubagentEffort | undefined): SubagentEffort | undefined {
  return effortRank(a) <= effortRank(b) ? a : b;
}

function lowerSpeed(a: SubagentSpeed | undefined, b: SubagentSpeed | undefined): SubagentSpeed | undefined {
  return speedRank(a) <= speedRank(b) ? a : b;
}

/** Sub-agent limits as a frozen map, without providers left at the lowest. */
function subagentLimitMap(
  entries: Iterable<readonly [string, SubagentEffort | undefined, SubagentSpeed | undefined]>,
): Readonly<Record<string, SubagentLimit>> {
  const out: Record<string, SubagentLimit> = {};
  for (const [provider, effort, speed] of entries) {
    if (effort === undefined && speed === undefined) continue;
    out[provider] = Object.freeze({
      ...(effort !== undefined ? { effort } : {}),
      ...(speed !== undefined ? { speed } : {}),
    });
  }
  return Object.freeze(out);
}

/** Each of `current`'s sub-agent limits, no higher than `limit`'s for that provider. */
function lowerSubagentLimits(
  current: Readonly<Record<string, SubagentLimit>> | undefined,
  limit: Readonly<Record<string, SubagentLimit>> | undefined,
): Readonly<Record<string, SubagentLimit>> {
  return subagentLimitMap(Object.entries(current ?? {}).map(([provider, own]) => [
    provider,
    lowerEffort(own.effort, limit?.[provider]?.effort),
    lowerSpeed(own.speed, limit?.[provider]?.speed),
  ] as const));
}

/**
 * The daemon's own `[agents]` view before and after the save that a daemon
 * reload applies. Without `previous`, what the save took away is unknown.
 * Without `next`, the view allows nothing.
 */
export interface AgentsConfigChange {
  readonly previous?: AgentsConfig;
  readonly next?: AgentsConfig;
}

/**
 * Whether `change` took anything away: a provider `previous` allowed and
 * `next` does not, the feature or automatic choice turned off, asking at each
 * spawn turned on, or a sub-agent limit lowered.
 * An unknown `previous` counts as taking away all that `next` does not allow.
 */
export function agentsChangeRevokes(change: AgentsConfigChange): boolean {
  return change.previous === undefined ||
    !sameAgentsPolicy(
      narrowAgentsConfig(change.previous, change.next),
      change.previous,
    );
}

/**
 * `current` without what `change` took away (`agentsChangeRevokes`): the
 * providers `previous` allowed and `next` does not, the feature if `next`
 * turned it off, not asking at each spawn if `next` started asking,
 * automatic choice if `next` turned it off, and any sub-agent limit above
 * one that `next` lowered.
 * Everything else in `current` stays, such as what a session's own
 * `--config` file, profile or `-c` allows. With an unknown `previous` it is
 * `narrowAgentsConfig(current, next)`. It is never wider than `current`.
 */
export function revokeAgentsConfig(
  current: AgentsConfig | undefined,
  change: AgentsConfigChange,
): AgentsConfig {
  const { previous, next } = change;
  if (previous === undefined) return narrowAgentsConfig(current, next);
  const kept = new Set(next?.allowed_providers ?? []);
  const removed = new Set(
    (previous.allowed_providers ?? []).filter((provider) => !kept.has(provider)),
  );
  return Object.freeze({
    cross_provider_enabled:
      current?.cross_provider_enabled === true &&
      (previous.cross_provider_enabled !== true ||
        next?.cross_provider_enabled === true),
    allowed_providers: Object.freeze(
      (current?.allowed_providers ?? []).filter((provider) =>
        !removed.has(provider)
      ),
    ),
    cross_provider_ask_each_spawn:
      current?.cross_provider_ask_each_spawn === true ||
      (previous.cross_provider_ask_each_spawn !== true &&
        next?.cross_provider_ask_each_spawn === true),
    cross_provider_auto:
      current?.cross_provider_auto === true &&
      (previous.cross_provider_auto !== true || next?.cross_provider_auto === true),
    ...withSubagentLimits(subagentLimitMap(
      Object.entries(current?.subagent_limits ?? {}).map(([provider, own]) => {
        const before = previous.subagent_limits?.[provider];
        const after = next?.subagent_limits?.[provider];
        return [
          provider,
          effortRank(after?.effort) < effortRank(before?.effort)
            ? lowerEffort(own.effort, after?.effort) : own.effort,
          speedRank(after?.speed) < speedRank(before?.speed)
            ? lowerSpeed(own.speed, after?.speed) : own.speed,
        ] as const;
      }),
    )),
  });
}

/** Whether two `agents` sections grant the same thing. */
function sameAgentsPolicy(
  a: AgentsConfig | undefined,
  b: AgentsConfig | undefined,
): boolean {
  return (a?.cross_provider_enabled === true) ===
      (b?.cross_provider_enabled === true) &&
    (a?.cross_provider_ask_each_spawn === true) ===
      (b?.cross_provider_ask_each_spawn === true) &&
    (a?.cross_provider_auto === true) === (b?.cross_provider_auto === true) &&
    isDeepStrictEqual(a?.allowed_providers ?? [], b?.allowed_providers ?? []) &&
    // Lowering a map by itself normalizes it: providers at the lowest drop out.
    isDeepStrictEqual(
      lowerSubagentLimits(a?.subagent_limits, a?.subagent_limits),
      lowerSubagentLimits(b?.subagent_limits, b?.subagent_limits),
    );
}

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
 * rolling back so later reloads cannot interleave with store publication.
 */
export interface PreparedConfigStoreReload {
  /**
   * What this reload read. While a failed refresh's limit applies
   * (`ConfigStore.limitAgentsSection`), its `agents` section, like that of
   * `authority.current()`, can be wider than `current().agents`: the store
   * commits and publishes it within the limit. Read that section from the
   * store.
   */
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
  /** When the read that `snapshot.agents` came from began. */
  readonly agentsReadStartedAt: number;
}

/**
 * What a refresh of the `agents` section that failed left behind: until a
 * read that began at or after `since` is published, the section stays within
 * `agents`.
 */
interface AgentsSectionLimit {
  readonly agents: AgentsConfig;
  readonly since: number;
}

export class ConfigStore {
  private snapshot: AgenCConfig;
  private readonly listeners = new Set<ConfigStoreListener>();
  /** Listeners that also run when only the `agents` section changes. */
  private readonly agentsSectionListeners = new Set<ConfigStoreListener>();
  /**
   * The `agents` section those listeners last heard. The live one can differ:
   * a committed reload changes `current()` before it publishes or rolls back.
   */
  private heardAgents: AgentsConfig | undefined;
  /** When the read that the current `agents` section came from began. */
  private agentsReadMark = 0;
  private agentsLimit: AgentsSectionLimit | undefined;
  /** When each prepared reload's read began. */
  private readonly preparedReadMarks =
    new WeakMap<PreparedConfigStoreReload, number>();
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
    this.heardAgents = this.snapshot.agents;
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

  /**
   * Atomic config + ordered-layer view for generation-sensitive consumers.
   * The `agents` section is the exception: `reloadAgentsSection()` and
   * `limitAgentsSection()` change `config.agents` without a full reload, so
   * the layers can still hold older `agents` values. Read that section from
   * `config` (or `current()`), never from the layers.
   */
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

  /**
   * Field-level origin from the most recent strict layered reload. `agents.*`
   * entries describe that reload, not a later `reloadAgentsSection()` or
   * `limitAgentsSection()`, so they can disagree with `current().agents`.
   */
  provenance(key: string): ConfigProvenanceEntry | undefined {
    return this.provenanceSnapshot[key];
  }

  /** Repository values intentionally ignored by the authority boundary. */
  ignored(): readonly IgnoredConfigValue[] {
    return this.ignoredSnapshot;
  }

  /**
   * Strict, sanitized source layers from the most recent repository load.
   * Their `agents` values can be older than `current().agents`, as in
   * `authoritySnapshot()`.
   */
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

  /**
   * Re-read this store's sources, as `reload()` does, and take only their
   * `agents` section (the cross-provider subagent policy) into the snapshot.
   * A daemon reload uses it for open sessions: their explicit `--config`
   * file, profile, environment, CLI and managed layers still apply, and every
   * other value, the layers, warnings and provenance stay as the last full
   * reload left them. When the section changed, only the listeners
   * subscribed with `sections: ["agents"]` run. Resolves to whether it
   * changed. A read that fails leaves the store as it was; the caller can
   * then narrow it with `limitAgentsSection()`.
   */
  reloadAgentsSection(): Promise<boolean> {
    // prepareReload binds this store to the caller's async context. Keep that
    // inside, so a caller that refreshes several stores keeps its own.
    return runWithCanonicalSettingsAuthority(this, async () => {
      const prepared = await this.prepareReload();
      try {
        const readMark = this.preparedReadMarks.get(prepared) ?? 0;
        // This read began after the refresh that left a limit began, so it
        // has what that refresh could not read.
        if (this.agentsLimit !== undefined && readMark >= this.agentsLimit.since) {
          this.agentsLimit = undefined;
        }
        this.agentsReadMark = readMark;
        const changed = this.publishAgentsSection(
          this.agentsWithinLimit(prepared.config.agents, readMark),
        );
        if (changed) this.reloadGeneration += 1;
        return changed;
      } finally {
        // Nothing else of the prepared generation is committed.
        prepared.rollback();
        prepared.settle();
      }
    });
  }

  /**
   * Fail closed after a refresh that began at `since` could not re-read this
   * store's sources, or did not finish in time: the `agents` section becomes
   * what both it and `limit` allow (`narrowAgentsConfig`), which never widens
   * it. So does any read that began before `since` and is published later,
   * such as a coordinated reload that holds the reload lock now. The first
   * read that began at or after `since` and is published replaces the limit.
   * Needs no reload lock, so a held lock cannot delay it. Tells the listeners
   * subscribed with `sections: ["agents"]` when the section changed or
   * differs from what they last heard, and returns whether it told them.
   */
  limitAgentsSection(limit: AgentsConfig | undefined, since: number): boolean {
    this.agentsLimit = {
      agents: narrowAgentsConfig(this.snapshot.agents, limit),
      since: Math.max(since, this.agentsLimit?.since ?? since),
    };
    return this.publishAgentsSection(
      this.agentsWithinLimit(this.snapshot.agents, this.agentsReadMark),
    );
  }

  /**
   * When the read that the current `agents` section came from began
   * (`nextConfigReadMark`). 0 before the first read.
   */
  agentsReadStartedAt(): number {
    return this.agentsReadMark;
  }

  /** `agents` as read at `readMark`, within the limit a failed refresh left. */
  private agentsWithinLimit(
    agents: AgentsConfig | undefined,
    readMark: number,
  ): AgentsConfig | undefined {
    const limit = this.agentsLimit;
    if (limit === undefined || readMark >= limit.since) return agents;
    const narrowed = narrowAgentsConfig(agents, limit.agents);
    return sameAgentsPolicy(narrowed, agents) ? agents : narrowed;
  }

  /** `snapshot` with its `agents` section within the limit, if any. */
  private snapshotWithinLimit(
    snapshot: AgenCConfig,
    readMark: number,
  ): AgenCConfig {
    const agents = this.agentsWithinLimit(snapshot.agents, readMark);
    return agents === snapshot.agents
      ? snapshot
      : Object.freeze({ ...snapshot, agents });
  }

  /**
   * Takes `agents` into the snapshot and tells the listeners subscribed to
   * that section (`tellAgentsSection`). Returns whether it told them.
   */
  private publishAgentsSection(agents: AgentsConfig | undefined): boolean {
    const changed = !isDeepStrictEqual(agents, this.snapshot.agents);
    if (changed) this.snapshot = Object.freeze({ ...this.snapshot, agents });
    return this.tellAgentsSection(changed);
  }

  /**
   * Tells the listeners subscribed to the `agents` section about the live
   * one when it just `changed` or differs from what they last heard. A
   * listener may also hold a section nobody published, read from `current()`
   * while a committed reload had not yet published or rolled back. Returns
   * whether it told them.
   */
  private tellAgentsSection(changed: boolean): boolean {
    if (!changed && isDeepStrictEqual(this.snapshot.agents, this.heardAgents)) {
      return false;
    }
    this.notifyListeners(
      this.snapshot,
      this.warningMessages,
      AGENTS_SECTION_PUBLICATION,
      this.agentsSectionListeners,
    );
    return true;
  }

  private async reloadPreparedAndPublish(): Promise<AgenCConfig> {
    const prepared = await this.prepareReload();
    try {
      prepared.commit();
      prepared.publish();
      prepared.settle();
      // `prepared.config`, unless a failed refresh's limit narrowed `agents`.
      return this.snapshot;
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
   * store or notifying subscribers. Only canonical writers bump plugin
   * lifecycle revisions; this read takes no lifecycle locks and never retires
   * a running plugin generation. Reload serialization remains held until the
   * returned handle is settled.
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
      agentsReadStartedAt: this.agentsReadMark,
    };
  }

  private applyState(state: ConfigStoreState): void {
    // A read from before a failed refresh stays within the limit it left.
    this.snapshot = this.snapshotWithinLimit(
      state.snapshot,
      state.agentsReadStartedAt,
    );
    this.agentsReadMark = state.agentsReadStartedAt;
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
    listeners: ReadonlySet<ConfigStoreListener> = this.listeners,
  ): void {
    // Every listener subscribed to the `agents` section is in both sets.
    this.heardAgents = config.agents;
    for (const listener of listeners) {
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

  /**
   * Re-read this store's captured sources without entering publication.
   * While a failed refresh's limit applies (`limitAgentsSection`), the
   * `agents` section of its `current()` can be wider than this store's
   * `current().agents`. Read that section from the store.
   */
  async readSourceAuthority(): Promise<ConfigStoreAuthority> {
    return this.authorityForState(await this.loadStateFromSources());
  }

  private async loadStateFromSources(): Promise<ConfigStoreState> {
    const agentsReadStartedAt = nextConfigReadMark();
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
    let projectRoot = this.resolvedProjectRoot;
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
    return {
      snapshot: next,
      warnings: warningMessages,
      provenance,
      ignored,
      sources,
      projectRoot,
      agentsReadStartedAt,
    };
  }

  private authorityForState(staged: ConfigStoreState): ConfigStoreAuthority {
    const thisStore = this;
    return Object.freeze({
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
        throw new Error("a read-only config authority cannot reload itself");
      },
      subscribe: () => {
        throw new Error("a read-only config authority cannot add subscribers");
      },
      warnings: () => [...staged.warnings],
      provenance: (key: string) => staged.provenance[key],
      ignored: () => staged.ignored,
    });
  }

  private async prepareReloadUnlocked(
    release: () => void,
  ): Promise<PreparedConfigStoreReload> {
    const previous = this.captureState();
    const generation = this.reloadGeneration;
    const staged = await this.loadStateFromSources();
    const authority = this.authorityForState(staged);
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
    const prepared: PreparedConfigStoreReload = Object.freeze({
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
        for (const message of staged.warnings) this.emitWarning(message);
        // The live snapshot: `staged.snapshot` unless its `agents` section is
        // kept within a failed refresh's limit.
        this.notifyListeners(
          this.snapshot,
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
          const committedAgents = this.snapshot.agents;
          this.applyState(previous);
          this.stateRepository.invalidate();
          this.reloadGeneration += 1;
          if (notifyRestoredAuthority) {
            this.notifyListeners(
              this.snapshot,
              this.warningMessages,
              publicationMetadata,
            );
          } else {
            // Nothing published the commit, but `current()` returned it, and
            // a failed refresh's limit can narrow the restored read below
            // what the agents listeners last heard. They hear either change.
            this.tellAgentsSection(
              !isDeepStrictEqual(this.snapshot.agents, committedAgents),
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
        // Only a published read that began after a failed refresh began
        // replaces its limit: a rollback restores an older read.
        if (
          state === "published" &&
          this.agentsLimit !== undefined &&
          staged.agentsReadStartedAt >= this.agentsLimit.since
        ) {
          this.agentsLimit = undefined;
        }
        isSettled = true;
        release();
      },
    });
    this.preparedReadMarks.set(prepared, staged.agentsReadStartedAt);
    return prepared;
  }

  /**
   * Register a listener for snapshot changes. Returns an unsubscribe
   * function. Listeners fire on each successful `reload()`. With
   * `sections: ["agents"]` they also fire when that section changes without
   * one, or is not what they last heard: after `reloadAgentsSection()`,
   * `limitAgentsSection()` or the rollback of a committed reload.
   */
  subscribe(
    listener: ConfigStoreListener,
    options: ConfigStoreSubscribeOptions = {},
  ): () => void {
    this.listeners.add(listener);
    if (options.sections?.includes("agents") === true) {
      this.agentsSectionListeners.add(listener);
    }
    return () => {
      this.listeners.delete(listener);
      this.agentsSectionListeners.delete(listener);
    };
  }

  /** Number of active subscribers (test introspection). */
  subscriberCount(): number {
    return this.listeners.size;
  }
}
