/**
 * Final process-execution boundary for commands that do not naturally pass
 * through the model-tool router (hooks, MCP stdio, and direct interactive
 * shell input).
 *
 * Restricted modes have exactly two outcomes: return a platform-sandboxed
 * command or throw a stable, actionable error. Only explicit
 * `danger_full_access` and `external_sandbox` modes may return the host command
 * unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { probeLandlock, resolveLandlockRun } from "./landlock-run.js";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path, { basename, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canWritePathWithCwd,
  SandboxManager,
  type AdditionalPermissionProfile,
  type PermissionProfile,
  type SandboxType,
  type WindowsSandboxLevel,
} from "./engine/index.js";
import { effectivePermissionProfile } from "./engine/policy-transforms.js";
import { planLandlockConfinement } from "./linux-launcher/landlock-exec.js";
import {
  findSystemBubblewrapInPath,
  probeSystemBubblewrapNamespaces,
  systemBubblewrapSupportsBindFd,
} from "./linux-launcher/launcher.js";
import { resolveRuntimePackageRootFromUrl } from "../app-server/daemon-runtime-info.js";
import type { UnifiedExecRuntimeSandbox } from "../unified-exec/types.js";
import { UnifiedExecError } from "../unified-exec/types.js";
import type { SandboxMode } from "../tools/orchestrator.js";
import {
  permissionProfileForSandboxMode,
  sandboxModeRequiresPlatformIsolation,
} from "../tools/runtimes/sandboxing.js";
import {
  APPARMOR_USERNS_REMEDIATION,
  isAppArmorUserNamespaceDenial,
} from "./apparmor.js";
import { sanitizeSandboxLauncherEnvironment } from "./launcher-environment.js";
import {
  SandboxExecutionLeaseCleanupError,
  registerSandboxPreparedSpawn,
  type SandboxPreparedSpawn,
} from "./execution-prepared-spawn.js";
import { resolveSessionTempRoot } from "../session/runtime-options.js";

export {
  SandboxExecutionLeaseCleanupError,
  isSandboxPreparedSpawn,
  type SandboxPreparedSpawn,
} from "./execution-prepared-spawn.js";

export type SandboxExecutionSurface =
  | "startup"
  | "interactive"
  | "print"
  | "background"
  | "job"
  | "hook"
  | "cron"
  | "mcp_stdio"
  | "lsp"
  | "browser"
  | "provider"
  | "powershell_parser"
  | "pane_agent"
  | "child_agent"
  | "command_exec"
  | "tool";

export type SandboxExecutionErrorCode =
  | "sandbox_required_unavailable"
  | "sandbox_probe_failed"
  | "sandbox_transform_failed"
  | "sandbox_surface_uncovered"
  | "sandbox_policy_unexpressible";

export type SandboxExecutionStatusKind =
  | "ready"
  | "unavailable"
  | "not_required"
  | "external";

export interface SandboxExecutionStatus {
  readonly kind: SandboxExecutionStatusKind;
  readonly mode: SandboxMode | "unknown";
  readonly platform: NodeJS.Platform;
  readonly reason?: string;
  readonly remediation?: string;
  readonly helperPath?: string;
  readonly isolationProgram?: string;
  /**
   * Functional Landlock enforcement on this host (Linux only), from the
   * vendored launcher's `--probe`. The execution helper applies the same
   * bubblewrap namespace probe and selects this fallback rung when needed.
   */
  readonly landlock?: "full" | "partial" | "unusable";
  /**
   * Present when this ready-status was reached through the Landlock
   * fallback because bubblewrap is unusable. Carries the bubblewrap
   * failure cause and its cause-correct remediation (AppArmor profile vs
   * install/upgrade bubblewrap vs enable user namespaces) so consumers
   * (doctor warning, per-policy pre-flight errors) never have to
   * recompute or string-sniff it.
   */
  readonly landlockFallback?: {
    readonly reason: string;
    readonly remediation: string;
  };
}

export interface SandboxSpawnCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly argv0?: string;
  /** Keep cwd attached to the caller's open directory and expose it read-only. */
  readonly cwdBinding?: "inherited_readonly";
  /** Narrow, surface-owned grants required by the child process. */
  readonly additionalPermissions?: AdditionalPermissionProfile;
  /** Require the executable itself to be outside every sandbox-writable root. */
  readonly trustedExecutable?: boolean;
  /**
   * Replace the mode-derived permission profile for this spawn. Honored only
   * under workspace-write (a surface may TIGHTEN its own boundary — e.g.
   * plugin MCP servers confined to their data dir — never widen a stricter
   * global mode). `additionalPermissions` still merge additively on top.
   */
  readonly permissionProfileOverride?: UnifiedExecRuntimeSandbox["permissionProfile"];
}

export interface SandboxPrepareSpawnOptions {
  /**
   * Name of the already-registered lifecycle participant that will own this
   * long-lived process. Omit for ordinary one-shot execution.
   */
  readonly lifecycleParticipant?: string;
}

export type SandboxExecutionManager = Pick<
  SandboxManager,
  "selectInitial" | "transform"
>;

export interface SandboxExecutionBrokerLike {
  readonly mode: SandboxMode;
  readonly required: boolean;
  readonly cwd: string;
  readonly sessionTempRoot: string;
  /** Zero for a root session; increments for each isolated child authority. */
  readonly forkDepth?: number;
  /** Permanent authority poison set after a lifecycle rollback cannot recover. */
  isClosedAfterLifecycleAuthorityFailure?(): boolean;
  /** Fork an independent boundary for a child session or worktree. */
  forkForCwd(cwd: string): SandboxExecutionBrokerLike;
  status(): SandboxExecutionStatus;
  assertReady(surface: SandboxExecutionSurface): SandboxExecutionStatus;
  runtimeSandbox(
    surface: SandboxExecutionSurface,
  ): UnifiedExecRuntimeSandbox | undefined;
  prepareSpawn(
    surface: SandboxExecutionSurface,
    command: SandboxSpawnCommand,
    options?: SandboxPrepareSpawnOptions,
  ): SandboxPreparedSpawn;
}

export class SandboxExecutionError extends Error {
  readonly code: SandboxExecutionErrorCode;
  readonly surface: SandboxExecutionSurface;
  readonly status: SandboxExecutionStatus;

  constructor(options: {
    readonly code: SandboxExecutionErrorCode;
    readonly surface: SandboxExecutionSurface;
    readonly status: SandboxExecutionStatus;
    readonly cause?: unknown;
    /** Full pre-formatted message; overrides the blocked-surface template. */
    readonly message?: string;
  }) {
    const reason = options.status.reason ?? "platform isolation is unavailable";
    const remediation = options.status.remediation ??
      "Run `agenc doctor`; select danger-full-access explicitly only when host execution is intended.";
    super(
      options.message ??
        `[${options.code}] required sandbox blocked ${options.surface}: ${reason}. ${remediation}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SandboxExecutionError";
    this.code = options.code;
    this.surface = options.surface;
    this.status = options.status;
  }
}

export function missingSandboxExecutionBoundary(
  surface: SandboxExecutionSurface,
): SandboxExecutionError {
  return new SandboxExecutionError({
    code: "sandbox_surface_uncovered",
    surface,
    status: {
      kind: "unavailable",
      mode: "unknown",
      platform: process.platform,
      reason: "no authenticated runtime policy or sandbox broker was supplied",
      remediation:
        "Start execution through an AgenC session or select danger-full-access explicitly through the trusted operator interface.",
    },
  });
}

export function requiredSandboxExecutionError(
  surface: SandboxExecutionSurface,
  status: SandboxExecutionStatus,
): SandboxExecutionError {
  return new SandboxExecutionError({
    code: status.reason?.startsWith("probe:")
      ? "sandbox_probe_failed"
      : "sandbox_required_unavailable",
    surface,
    status,
  });
}

export interface SandboxExecutionBrokerOptions {
  readonly mode: SandboxMode;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionTempRoot?: string;
  readonly agencLinuxSandboxExe?: string;
  readonly windowsSandboxLevel?: UnifiedExecRuntimeSandbox["windowsSandboxLevel"];
  readonly windowsSandboxPrivateDesktop?: boolean;
  readonly allowGpu?: boolean;
  readonly permissionProfile?: PermissionProfile;
  readonly platform?: NodeJS.Platform;
  readonly sandboxManager?: SandboxExecutionManager;
  /** Internal lineage marker propagated by forkForCwd. */
  readonly forkDepth?: number;
  /** Injectable only for deterministic lifecycle lease-drain tests. */
  readonly lifecycleLeaseDrainTimeoutMs?: number;
  /** Injectable only for deterministic platform/fault tests. */
  readonly probe?: (options: {
    readonly mode: SandboxMode;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly agencLinuxSandboxExe?: string;
  }) => SandboxExecutionStatus;
  /** Injectable Landlock plan seam for deterministic pre-flight tests. */
  readonly planLandlockPolicy?: typeof planLandlockConfinement;
}

export interface SandboxExecutionBrokerAuthority {
  readonly mode: SandboxMode;
  readonly permissionProfile?: PermissionProfile;
  readonly windowsSandboxLevel: WindowsSandboxLevel;
  readonly allowGpu: boolean;
}

const defaultSandboxManager = new SandboxManager();

function immutablePermissionProfile(
  profile: PermissionProfile | undefined,
): PermissionProfile | undefined {
  if (profile === undefined) return undefined;
  const entries = profile.fileSystem.entries.map((entry) => {
    const fileSystemPath = (() => {
      switch (entry.path.kind) {
        case "path":
        case "glob":
          return Object.freeze({ ...entry.path });
        case "special":
          return Object.freeze({
            ...entry.path,
            value: Object.freeze({ ...entry.path.value }),
          });
      }
    })();
    return Object.freeze({ ...entry, path: fileSystemPath });
  });
  return Object.freeze({
    ...profile,
    fileSystem: Object.freeze({
      ...profile.fileSystem,
      entries: Object.freeze(entries),
    }),
  });
}

const DEFAULT_LIFECYCLE_LEASE_DRAIN_TIMEOUT_MS = 5_000;

interface SandboxExecutionLifecyclePermit {
  readonly broker: SandboxExecutionBroker;
  readonly epoch: number;
  readonly participantName: string;
  active: boolean;
}

const sandboxExecutionLifecyclePermit =
  new AsyncLocalStorage<SandboxExecutionLifecyclePermit>();

declare const sandboxExecutionLifecycleFenceBrand: unique symbol;
declare const sandboxExecutionLifecycleMutationPermitBrand: unique symbol;

/** Opaque broker-owned token used only by the lifecycle coordinator. */
export interface SandboxExecutionLifecycleFence {
  readonly [sandboxExecutionLifecycleFenceBrand]: never;
}

/** Opaque proof that one-shot and registered participant drains completed. */
export interface SandboxExecutionLifecycleMutationPermit {
  readonly [sandboxExecutionLifecycleMutationPermitBrand]: never;
}

type OneShotLeaseState = "prepared" | "running" | "complete";

interface OneShotLeaseRecord {
  readonly surface: SandboxExecutionSurface;
  readonly authorityEpoch: number;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  resolveCompletion(): void;
  rejectCompletion(error: unknown): void;
  state: OneShotLeaseState;
  invalidated: boolean;
}

interface LifecycleFenceState {
  readonly handle: SandboxExecutionLifecycleFence;
  readonly epoch: number;
  oneShotDrainProven: boolean;
  mutationPermit?: SandboxExecutionLifecycleMutationPermit;
}

class SandboxPreparedSpawnImpl implements SandboxPreparedSpawn {
  readonly #broker: SandboxExecutionBroker;
  readonly #surface: SandboxExecutionSurface;
  readonly #command: SandboxSpawnCommand;
  readonly #authorityEpoch: number;
  readonly #participantName: string | undefined;
  readonly #requiresLifecyclePermit: boolean;
  readonly #oneShotLease: OneShotLeaseRecord | undefined;
  #consumed = false;

  constructor(options: {
    readonly broker: SandboxExecutionBroker;
    readonly surface: SandboxExecutionSurface;
    readonly command: SandboxSpawnCommand;
    readonly authorityEpoch: number;
    readonly participantName?: string;
    readonly requiresLifecyclePermit?: boolean;
    readonly oneShotLease?: OneShotLeaseRecord;
  }) {
    this.#broker = options.broker;
    this.#surface = options.surface;
    this.#command = options.command;
    this.#authorityEpoch = options.authorityEpoch;
    this.#participantName = options.participantName;
    this.#requiresLifecyclePermit = options.requiresLifecyclePermit ?? false;
    this.#oneShotLease = options.oneShotLease;
    registerSandboxPreparedSpawn(this);
  }

  async run<T>(
    operation: (
      command: SandboxSpawnCommand,
      lifecycleSignal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.#participantName !== undefined) {
      throw new Error(
        `sandbox spawn for lifecycle participant ${this.#participantName} must be transferred explicitly`,
      );
    }
    const lease = this.#beginOneShot();
    try {
      const result = await operation(this.#command, lease.controller.signal);
      this.#broker.completeOneShotSpawnLease(lease);
      return result;
    } catch (error) {
      this.#broker.completeOneShotSpawnLease(
        lease,
        error instanceof SandboxExecutionLeaseCleanupError
          ? error
          : undefined,
      );
      throw error;
    }
  }

  start<T>(
    operation: (
      command: SandboxSpawnCommand,
      lifecycleSignal: AbortSignal,
    ) => { readonly value: T; readonly completion: Promise<void> },
  ): T {
    if (this.#participantName !== undefined) {
      throw new Error(
        `sandbox spawn for lifecycle participant ${this.#participantName} must be transferred explicitly`,
      );
    }
    const lease = this.#beginOneShot();
    let started: { readonly value: T; readonly completion: Promise<void> };
    try {
      started = operation(this.#command, lease.controller.signal);
    } catch (error) {
      this.#broker.completeOneShotSpawnLease(lease);
      throw error;
    }
    void started.completion.then(
      () => this.#broker.completeOneShotSpawnLease(lease),
      (error: unknown) =>
        this.#broker.completeOneShotSpawnLease(
          lease,
          error instanceof SandboxExecutionLeaseCleanupError
            ? error
            : undefined,
        ),
    );
    return started.value;
  }

  runSync<T>(operation: (command: SandboxSpawnCommand) => T): T {
    if (this.#participantName !== undefined) {
      throw new Error(
        `sandbox spawn for lifecycle participant ${this.#participantName} must be transferred explicitly`,
      );
    }
    const lease = this.#beginOneShot();
    try {
      return operation(this.#command);
    } finally {
      this.#broker.completeOneShotSpawnLease(lease);
    }
  }

  spawnLifecycleParticipant<T>(
    participantName: string,
    operation: (command: SandboxSpawnCommand) => T,
  ): T {
    if (this.#consumed) {
      throw new Error("sandbox prepared spawn was already consumed");
    }
    if (
      this.#participantName === undefined ||
      participantName !== this.#participantName
    ) {
      throw new Error(
        `sandbox prepared spawn is not owned by lifecycle participant ${participantName}`,
      );
    }
    this.#broker.assertLifecycleParticipantSpawnAuthorized(
      participantName,
      this.#surface,
      this.#authorityEpoch,
      this.#requiresLifecyclePermit,
    );
    this.#consumed = true;
    const result = operation(this.#command);
    if (
      typeof result === "object" &&
      result !== null &&
      "then" in result &&
      typeof (result as { readonly then?: unknown }).then === "function"
    ) {
      throw new Error(
        "lifecycle participant spawn callback must start the process synchronously",
      );
    }
    return result;
  }

  #beginOneShot(): OneShotLeaseRecord {
    if (this.#consumed) {
      throw new Error("sandbox prepared spawn was already consumed");
    }
    this.#consumed = true;
    const lease = this.#oneShotLease;
    if (lease === undefined) {
      throw new Error("sandbox one-shot spawn is missing its lifecycle lease");
    }
    this.#broker.beginOneShotSpawnLease(lease, this.#authorityEpoch);
    return lease;
  }
}

export class SandboxExecutionBroker implements SandboxExecutionBrokerLike {
  readonly forkDepth: number;
  #mode: SandboxMode;
  #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #sandboxManager: SandboxExecutionManager;
  readonly #explicitLinuxHelper: string | undefined;
  readonly #sessionTempRoot: string;
  #windowsSandboxLevel: NonNullable<
    UnifiedExecRuntimeSandbox["windowsSandboxLevel"]
  >;
  readonly #windowsSandboxPrivateDesktop: boolean;
  #allowGpu: boolean;
  #permissionProfile: PermissionProfile | undefined;
  readonly #probe: NonNullable<SandboxExecutionBrokerOptions["probe"]>;
  readonly #planLandlockPolicy: typeof planLandlockConfinement;
  #status: SandboxExecutionStatus | undefined;
  #lifecycleAuthorityFailure: string | undefined;
  readonly #lifecycleLeaseDrainTimeoutMs: number;
  #authorityEpoch = 0;
  #lifecycleFence: LifecycleFenceState | undefined;
  readonly #oneShotLeases = new Set<OneShotLeaseRecord>();
  readonly #lifecycleParticipantSurfaces = new Map<
    string,
    Map<SandboxExecutionSurface, number>
  >();

  constructor(options: SandboxExecutionBrokerOptions) {
    this.#mode = options.mode;
    this.forkDepth = Number.isFinite(options.forkDepth)
      ? Math.max(0, Math.floor(options.forkDepth ?? 0))
      : 0;
    this.#cwd = path.resolve(options.cwd);
    this.#env = { ...(options.env ?? process.env) };
    this.#platform = options.platform ?? process.platform;
    this.#sandboxManager = options.sandboxManager ?? defaultSandboxManager;
    this.#explicitLinuxHelper = options.agencLinuxSandboxExe;
    const sessionTempRoot = options.sessionTempRoot ?? resolveSessionTempRoot();
    if (!path.isAbsolute(sessionTempRoot)) {
      throw new Error("sandbox session temp root must be an absolute path");
    }
    this.#sessionTempRoot = path.normalize(sessionTempRoot);
    this.#windowsSandboxLevel = options.windowsSandboxLevel ?? "disabled";
    this.#windowsSandboxPrivateDesktop =
      options.windowsSandboxPrivateDesktop ?? false;
    this.#allowGpu = options.allowGpu ?? false;
    this.#permissionProfile = immutablePermissionProfile(
      options.permissionProfile,
    );
    this.#probe = options.probe ?? probeSandboxExecutionStatus;
    this.#planLandlockPolicy =
      options.planLandlockPolicy ?? planLandlockConfinement;
    this.#lifecycleLeaseDrainTimeoutMs =
      options.lifecycleLeaseDrainTimeoutMs ??
      DEFAULT_LIFECYCLE_LEASE_DRAIN_TIMEOUT_MS;
    if (
      !Number.isFinite(this.#lifecycleLeaseDrainTimeoutMs) ||
      this.#lifecycleLeaseDrainTimeoutMs <= 0
    ) {
      throw new Error(
        "sandbox lifecycle lease drain timeout must be finite and positive",
      );
    }
  }

  get cwd(): string {
    return this.#cwd;
  }

  get sessionTempRoot(): string {
    return this.#sessionTempRoot;
  }

  get mode(): SandboxMode {
    return this.#mode;
  }

  get required(): boolean {
    return sandboxModeRequiresPlatformIsolation(this.#mode);
  }

  /** Permanently close execution after a runtime-authority rollback fails. */
  closeAfterLifecycleAuthorityFailure(reason: string): void {
    if (this.#lifecycleAuthorityFailure !== undefined) return;
    this.#mode = "read_only";
    this.#status = undefined;
    this.#lifecycleAuthorityFailure = reason;
    this.#authorityEpoch += 1;
    for (const lease of this.#oneShotLeases) {
      if (lease.state === "prepared") {
        lease.invalidated = true;
        this.completeOneShotSpawnLease(lease);
      } else if (lease.state === "running") {
        lease.controller.abort(
          new Error("sandbox execution authority was permanently closed"),
        );
      }
    }
  }

  /** True only after an irreversible lifecycle-authority rollback failure. */
  isClosedAfterLifecycleAuthorityFailure(): boolean {
    return this.#lifecycleAuthorityFailure !== undefined;
  }

  /** @internal Register the long-lived surfaces owned by one participant. */
  registerLifecycleParticipantSpawnSurfaces(
    participantName: string,
    surfaces: readonly SandboxExecutionSurface[],
  ): () => void {
    if (participantName.trim().length === 0) {
      throw new Error("sandbox lifecycle participant name must not be empty");
    }
    if (this.#lifecycleFence !== undefined) {
      throw new Error(
        `cannot register ${participantName} while a sandbox execution broker lifecycle transition is active`,
      );
    }
    if (this.#lifecycleParticipantSurfaces.has(participantName)) {
      throw new Error(
        `sandbox lifecycle participant name is already registered: ${participantName}`,
      );
    }
    const owned = new Map<SandboxExecutionSurface, number>();
    for (const surface of new Set(surfaces)) {
      owned.set(surface, 1);
    }
    this.#lifecycleParticipantSurfaces.set(participantName, owned);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.#lifecycleParticipantSurfaces.delete(participantName);
    };
  }

  /** @internal Close external execution ingress for one lifecycle phase. */
  beginLifecycleAuthorityTransition(): SandboxExecutionLifecycleFence {
    if (this.#lifecycleAuthorityFailure !== undefined) {
      throw new Error(
        "sandbox execution broker is closed after an authority failure",
      );
    }
    if (this.#lifecycleFence !== undefined) {
      throw new Error("sandbox execution broker lifecycle transition is active");
    }
    this.#authorityEpoch += 1;
    const handle = Object.freeze({}) as SandboxExecutionLifecycleFence;
    const fence = {
      handle,
      epoch: this.#authorityEpoch,
      oneShotDrainProven: false,
    };
    this.#lifecycleFence = fence;
    for (const lease of [...this.#oneShotLeases]) {
      if (lease.state === "prepared") {
        lease.invalidated = true;
        this.completeOneShotSpawnLease(lease);
        continue;
      }
      if (lease.state === "running") {
        lease.controller.abort(
          new Error("sandbox execution authority transition started"),
        );
      }
    }
    return handle;
  }

  /** @internal Wait until every pre-transition one-shot process is gone. */
  async waitForLifecycleOneShotDrain(
    handle: SandboxExecutionLifecycleFence,
  ): Promise<void> {
    this.#requireLifecycleFence(handle);
    const running = [...this.#oneShotLeases].filter(
      (lease) => lease.state === "running",
    );
    if (running.length === 0) {
      this.#requireLifecycleFence(handle).oneShotDrainProven = true;
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `sandbox execution lease drain exceeded ${this.#lifecycleLeaseDrainTimeoutMs}ms`,
          ),
        );
      }, this.#lifecycleLeaseDrainTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([
        Promise.all(running.map((lease) => lease.completion)).then(() => {}),
        timeout,
      ]);
      this.#requireLifecycleFence(handle).oneShotDrainProven = true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** @internal Mint mutation proof only after the coordinator quiesces owners. */
  proveLifecycleParticipantsQuiesced(
    handle: SandboxExecutionLifecycleFence,
  ): SandboxExecutionLifecycleMutationPermit {
    const fence = this.#requireLifecycleFence(handle);
    if (!fence.oneShotDrainProven) {
      throw new Error(
        "sandbox lifecycle mutation requires a proven one-shot process drain",
      );
    }
    const permit = Object.freeze(
      {},
    ) as SandboxExecutionLifecycleMutationPermit;
    fence.mutationPermit = permit;
    return permit;
  }

  /** @internal Revoke mutation authority before any participant resumes. */
  invalidateLifecycleParticipantsQuiesced(
    handle: SandboxExecutionLifecycleFence,
  ): void {
    this.#requireLifecycleFence(handle).mutationPermit = undefined;
  }

  /** @internal Run one participant resume under a broker+epoch permit. */
  async runWithLifecycleParticipantSpawnPermit<T>(
    handle: SandboxExecutionLifecycleFence,
    participantName: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const fence = this.#requireLifecycleFence(handle);
    if (!this.#lifecycleParticipantSurfaces.has(participantName)) {
      throw new Error(
        `sandbox lifecycle participant ${participantName} has no registered spawn surfaces`,
      );
    }
    const permit: SandboxExecutionLifecyclePermit = {
      broker: this,
      epoch: fence.epoch,
      participantName,
      active: true,
    };
    return sandboxExecutionLifecyclePermit.run(permit, async () => {
      try {
        return await operation();
      } finally {
        permit.active = false;
      }
    });
  }

  /** @internal Prove code is running inside this participant's active resume. */
  assertLifecycleParticipantResumePermit(participantName: string): void {
    const fence = this.#lifecycleFence;
    const permit = sandboxExecutionLifecyclePermit.getStore();
    if (
      fence === undefined ||
      permit?.active !== true ||
      permit.broker !== this ||
      permit.epoch !== fence.epoch ||
      permit.participantName !== participantName
    ) {
      throw new Error(
        `sandbox lifecycle participant ${participantName} has no active resume permit`,
      );
    }
  }

  /** @internal Release a successful or fully rolled-back lifecycle fence. */
  endLifecycleAuthorityTransition(
    handle: SandboxExecutionLifecycleFence,
  ): void {
    this.#requireLifecycleFence(handle);
    this.#lifecycleFence = undefined;
  }

  /** @internal Start an already-prepared one-shot lease. */
  beginOneShotSpawnLease(
    lease: OneShotLeaseRecord,
    authorityEpoch: number,
  ): void {
    if (
      lease.state !== "prepared" ||
      lease.invalidated ||
      authorityEpoch !== this.#authorityEpoch ||
      this.#lifecycleFence !== undefined ||
      this.#lifecycleAuthorityFailure !== undefined
    ) {
      this.completeOneShotSpawnLease(lease);
      throw requiredSandboxExecutionError(
        lease.surface,
        this.#unavailableLifecycleAuthorityStatus(),
      );
    }
    lease.state = "running";
  }

  /** @internal Complete a one-shot lease after its entire process tree stops. */
  completeOneShotSpawnLease(
    lease: OneShotLeaseRecord,
    cleanupError?: unknown,
  ): void {
    if (lease.state === "complete") return;
    lease.state = "complete";
    this.#oneShotLeases.delete(lease);
    if (cleanupError === undefined) {
      lease.resolveCompletion();
      return;
    }
    lease.rejectCompletion(cleanupError);
    this.closeAfterLifecycleAuthorityFailure(
      cleanupError instanceof Error
        ? `sandbox process-tree cleanup was unproven: ${cleanupError.message}`
        : "sandbox process-tree cleanup was unproven",
    );
  }

  /** @internal Revalidate a participant handle immediately before spawn. */
  assertLifecycleParticipantSpawnAuthorized(
    participantName: string,
    surface: SandboxExecutionSurface,
    authorityEpoch: number,
    requireActiveLifecyclePermit = false,
  ): void {
    const owned = this.#lifecycleParticipantSurfaces.get(participantName);
    if ((owned?.get(surface) ?? 0) <= 0) {
      throw new Error(
        `sandbox lifecycle participant ${participantName} does not own ${surface} execution`,
      );
    }
    if (authorityEpoch !== this.#authorityEpoch) {
      throw requiredSandboxExecutionError(
        surface,
        this.#unavailableLifecycleAuthorityStatus(),
      );
    }
    if (requireActiveLifecyclePermit) {
      this.assertLifecycleParticipantResumePermit(participantName);
    }
    this.#assertLifecycleAuthorityOpen(surface, participantName);
  }

  executionAuthority(): SandboxExecutionBrokerAuthority {
    return Object.freeze({
      mode: this.#mode,
      ...(this.#permissionProfile !== undefined
        ? { permissionProfile: this.#permissionProfile }
        : {}),
      windowsSandboxLevel: this.#windowsSandboxLevel,
      allowGpu: this.#allowGpu,
    });
  }

  applyAuthorityAfterLifecycleQuiesce(
    permit: SandboxExecutionLifecycleMutationPermit,
    authority: SandboxExecutionBrokerAuthority,
  ): void {
    this.#requireLifecycleMutationPermit(permit);
    if (this.#lifecycleAuthorityFailure !== undefined) {
      throw new Error(
        "sandbox execution broker is closed after an authority failure",
      );
    }
    this.#mode = authority.mode;
    this.#permissionProfile = immutablePermissionProfile(
      authority.permissionProfile,
    );
    this.#windowsSandboxLevel = authority.windowsSandboxLevel;
    this.#allowGpu = authority.allowGpu;
    this.#status = undefined;
  }

  rebaseAfterLifecycleQuiesce(
    permit: SandboxExecutionLifecycleMutationPermit,
    cwd: string,
  ): void {
    this.#requireLifecycleMutationPermit(permit);
    const resolved = path.resolve(cwd);
    if (resolved === this.#cwd) return;
    if (this.#permissionProfile !== undefined) {
      this.#permissionProfile = immutablePermissionProfile(
        rebasePermissionProfile(
          this.#permissionProfile,
          this.#cwd,
          resolved,
        ),
      );
    }
    this.#cwd = resolved;
    this.#status = undefined;
  }

  forkForCwd(cwd: string): SandboxExecutionBroker {
    this.#assertLifecycleAuthorityOpen("child_agent");
    const resolvedCwd = path.resolve(cwd);
    return new SandboxExecutionBroker({
      mode: this.mode,
      cwd: resolvedCwd,
      env: this.#env,
      sessionTempRoot: this.#sessionTempRoot,
      ...(this.#explicitLinuxHelper !== undefined
        ? { agencLinuxSandboxExe: this.#explicitLinuxHelper }
        : {}),
      windowsSandboxLevel: this.#windowsSandboxLevel,
      windowsSandboxPrivateDesktop: this.#windowsSandboxPrivateDesktop,
      allowGpu: this.#allowGpu,
      ...(this.#permissionProfile !== undefined
        ? {
            permissionProfile: rebasePermissionProfile(
              this.#permissionProfile,
              this.#cwd,
              resolvedCwd,
            ),
          }
        : {}),
      platform: this.#platform,
      sandboxManager: this.#sandboxManager,
      probe: this.#probe,
      planLandlockPolicy: this.#planLandlockPolicy,
      forkDepth: this.forkDepth + 1,
      lifecycleLeaseDrainTimeoutMs: this.#lifecycleLeaseDrainTimeoutMs,
    });
  }

  status(): SandboxExecutionStatus {
    if (this.#lifecycleAuthorityFailure !== undefined) {
      return this.#closedLifecycleAuthorityStatus();
    }
    this.#status ??= this.#probe({
      mode: this.mode,
      cwd: this.#cwd,
      env: this.#env,
      platform: this.#platform,
      ...(this.#explicitLinuxHelper !== undefined
        ? { agencLinuxSandboxExe: this.#explicitLinuxHelper }
        : {}),
    });
    return this.#status;
  }

  assertReady(surface: SandboxExecutionSurface): SandboxExecutionStatus {
    this.#assertLifecycleAuthorityOpen(surface);
    return this.#assertReadyAfterLifecycleAdmission(surface);
  }

  #assertReadyAfterLifecycleAdmission(
    surface: SandboxExecutionSurface,
  ): SandboxExecutionStatus {
    const status = this.status();
    if (!this.required || status.kind === "ready") return status;
    throw requiredSandboxExecutionError(surface, status);
  }

  runtimeSandbox(
    surface: SandboxExecutionSurface,
  ): UnifiedExecRuntimeSandbox | undefined {
    this.#assertLifecycleAuthorityOpen(surface);
    return this.#runtimeSandboxAfterLifecycleAdmission(surface);
  }

  #runtimeSandboxAfterLifecycleAdmission(
    surface: SandboxExecutionSurface,
  ): UnifiedExecRuntimeSandbox | undefined {
    if (!this.required) return undefined;
    const status = this.#assertReadyAfterLifecycleAdmission(surface);
    return {
      permissionProfile:
        this.#permissionProfile ??
        permissionProfileForSandboxMode(this.mode, {
          cwd: this.#cwd,
        }),
      sandboxPolicyCwd: this.#cwd,
      sessionTempRoot: this.#sessionTempRoot,
      preference: "require",
      ...(status.helperPath !== undefined
        ? { agencLinuxSandboxExe: status.helperPath }
        : {}),
      windowsSandboxLevel: this.#windowsSandboxLevel,
      windowsSandboxPrivateDesktop: this.#windowsSandboxPrivateDesktop,
      ...(this.#allowGpu ? { allowGpu: true } : {}),
    };
  }

  prepareSpawn(
    surface: SandboxExecutionSurface,
    command: SandboxSpawnCommand,
    options: SandboxPrepareSpawnOptions = {},
  ): SandboxPreparedSpawn {
    try {
      const participantName = options.lifecycleParticipant;
      const requiresLifecyclePermit =
        participantName !== undefined && this.#lifecycleFence !== undefined;
      if (participantName !== undefined) {
        this.assertLifecycleParticipantSpawnAuthorized(
          participantName,
          surface,
          this.#authorityEpoch,
        );
      } else {
        this.#assertLifecycleAuthorityOpen(surface);
      }
      // Establish the required boundary before examining or transforming the
      // command. When the sandbox probe failed, that is the primary failure;
      // no executable resolution or policy projection should mask it.
      const modeSandbox = this.#runtimeSandboxAfterLifecycleAdmission(surface);
      // A surface may TIGHTEN its own boundary (plugin MCP servers confined
      // to their data dir) — never widen a stricter global mode, so the
      // override applies only under workspace_write.
      const runtimeSandbox =
        modeSandbox !== undefined &&
        command.permissionProfileOverride !== undefined &&
        this.mode === "workspace_write"
          ? {
              ...modeSandbox,
              permissionProfile: command.permissionProfileOverride,
            }
          : modeSandbox;
      const resolvedProgram = resolveSpawnExecutable({
        program: command.program,
        cwd: command.cwd,
        env: command.env,
        platform: this.#platform,
      });
      if (
        (command.trustedExecutable === true ||
          command.additionalPermissions !== undefined) &&
        this.required
      ) {
        const baseProfile =
          runtimeSandbox?.permissionProfile ??
          this.#permissionProfile ??
          permissionProfileForSandboxMode(this.mode, {
            cwd: this.#cwd,
          });
        const effectiveProfile = effectivePermissionProfile(
          baseProfile,
          command.additionalPermissions,
        );
        if (
          canWritePathWithCwd(
            effectiveProfile.fileSystem,
            resolvedProgram,
            this.#cwd,
            runtimeSandbox?.sessionTempRoot ?? this.#sessionTempRoot,
          )
        ) {
          throw new UnifiedExecError(
            "create_process",
            `privileged executable is writable by its sandbox policy: ${resolvedProgram}`,
          );
        }
      }
      this.#preflightLandlockPlan(surface, command, runtimeSandbox);
      const resolvedCommand: SandboxSpawnCommand = {
        ...command,
        program: resolvedProgram,
        argv0: command.argv0 ?? basename(command.program),
      };
      const preparedCommand = (() => {
        if (runtimeSandbox === undefined) return resolvedCommand;
        const sandboxWithSurfacePermissions =
          command.additionalPermissions === undefined
            ? runtimeSandbox
            : {
                ...runtimeSandbox,
                additionalPermissions: command.additionalPermissions,
              };
        return transformSandboxedCommand({
          ...resolvedCommand,
          runtimeSandbox: sandboxWithSurfacePermissions,
          sandboxManager: this.#sandboxManager,
        });
      })();
      if (participantName !== undefined) {
        return new SandboxPreparedSpawnImpl({
          broker: this,
          surface,
          command: preparedCommand,
          authorityEpoch: this.#authorityEpoch,
          participantName,
          requiresLifecyclePermit,
        });
      }
      let resolveCompletion!: () => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      // A rejected cleanup proof is consumed by the lifecycle drain. Attach a
      // handler now so a failure outside a transition cannot become an
      // unhandled rejection before the next lifecycle phase observes it.
      void completion.catch(() => {});
      const lease: OneShotLeaseRecord = {
        surface,
        authorityEpoch: this.#authorityEpoch,
        controller: new AbortController(),
        completion,
        resolveCompletion,
        rejectCompletion,
        state: "prepared",
        invalidated: false,
      };
      this.#oneShotLeases.add(lease);
      return new SandboxPreparedSpawnImpl({
        broker: this,
        surface,
        command: preparedCommand,
        authorityEpoch: this.#authorityEpoch,
        oneShotLease: lease,
      });
    } catch (error) {
      if (error instanceof SandboxExecutionError) throw error;
      throw new SandboxExecutionError({
        code: "sandbox_transform_failed",
        surface,
        status: {
          ...this.status(),
          reason: error instanceof Error ? error.message : String(error),
        },
        cause: error,
      });
    }
  }

  #assertLifecycleAuthorityOpen(
    surface: SandboxExecutionSurface,
    participantName?: string,
  ): void {
    if (this.#lifecycleAuthorityFailure !== undefined) {
      throw requiredSandboxExecutionError(
        surface,
        this.#closedLifecycleAuthorityStatus(),
      );
    }
    const fence = this.#lifecycleFence;
    if (fence === undefined) return;
    if (participantName !== undefined) {
      const permit = sandboxExecutionLifecyclePermit.getStore();
      if (
        permit?.active === true &&
        permit.broker === this &&
        permit.epoch === fence.epoch &&
        permit.participantName === participantName
      ) {
        return;
      }
    }
    throw requiredSandboxExecutionError(
      surface,
      this.#unavailableLifecycleAuthorityStatus(),
    );
  }

  #requireLifecycleFence(
    handle: SandboxExecutionLifecycleFence,
  ): LifecycleFenceState {
    const fence = this.#lifecycleFence;
    if (fence === undefined || fence.handle !== handle) {
      throw new Error("sandbox execution lifecycle fence is not active");
    }
    return fence;
  }

  #requireLifecycleMutationPermit(
    permit: SandboxExecutionLifecycleMutationPermit,
  ): void {
    const fence = this.#lifecycleFence;
    if (
      fence === undefined ||
      !fence.oneShotDrainProven ||
      fence.mutationPermit !== permit
    ) {
      throw new Error(
        "sandbox authority mutation requires proven lifecycle quiescence",
      );
    }
  }

  #unavailableLifecycleAuthorityStatus(): SandboxExecutionStatus {
    if (this.#lifecycleAuthorityFailure !== undefined) {
      return this.#closedLifecycleAuthorityStatus();
    }
    return {
      kind: "unavailable",
      mode: this.#mode,
      platform: this.#platform,
      reason: "sandbox runtime authority is changing",
      remediation: "Retry after the runtime settings transition settles.",
    };
  }

  #closedLifecycleAuthorityStatus(): SandboxExecutionStatus {
    return {
      kind: "unavailable",
      mode: this.#mode,
      platform: this.#platform,
      reason: this.#lifecycleAuthorityFailure,
      remediation:
        "Close this session and attach again from a fresh runtime settings snapshot.",
    };
  }

  /**
   * When this host reached readiness only through the Landlock fallback,
   * check whether the fallback can actually express this spawn's policy —
   * the launcher would otherwise refuse at exec time with the reason buried
   * in child stderr and the caller seeing a generic connection/exit failure.
   *
   * Best-effort by design: the launcher re-probes bubblewrap with the
   * child's environment at spawn time, and `tmpdir` specials resolve from
   * the resolving process's env, so verdicts can diverge on exotic
   * environments; the stdio transport's stderr capture remains the backstop.
   * No memoization: carve-out refusals hinge on path existence the launcher
   * rechecks per spawn, so we do too (the plan is cheap and only runs on
   * fallback machines).
   */
  #preflightLandlockPlan(
    surface: SandboxExecutionSurface,
    command: SandboxSpawnCommand,
    runtimeSandbox: UnifiedExecRuntimeSandbox | undefined,
  ): void {
    if (runtimeSandbox === undefined) return;
    if (this.#platform !== "linux") return;
    // Glob/Grep-style spawns replace the profile with an inherited
    // read-only policy in the engine — pre-flighting the workspace profile
    // here would falsely refuse spawns that plan cleanly.
    if (command.cwdBinding === "inherited_readonly") return;
    if (command.env.AGENC_DISABLE_LANDLOCK_FALLBACK === "1") return;
    const fallback = this.status().landlockFallback;
    if (fallback === undefined) return;
    const effectiveProfile = effectivePermissionProfile(
      runtimeSandbox.permissionProfile,
      command.additionalPermissions,
    );
    const plan = this.#planLandlockPolicy({
      fileSystem: effectiveProfile.fileSystem,
      sandboxPolicyCwd: this.#cwd,
      sessionTempRoot: runtimeSandbox.sessionTempRoot,
      allowNetworkForProxy: false,
      inheritedCwd: false,
    });
    if (plan.kind === "refused") {
      throw new SandboxExecutionError({
        code: "sandbox_policy_unexpressible",
        surface,
        status: this.status(),
        message:
          `[sandbox_policy_unexpressible] required sandbox cannot express the ${surface} policy ` +
          `without bubblewrap: ${plan.reason}. ${fallback.remediation}`,
      });
    }
  }
}

function rebasePermissionProfile(
  profile: PermissionProfile,
  previousCwd: string,
  nextCwd: string,
): PermissionProfile {
  if (profile.fileSystem.kind !== "restricted") return profile;
  const entries = profile.fileSystem.entries.map((entry) => {
    switch (entry.path.kind) {
      case "path":
        return {
          ...entry,
          path: {
            kind: "path" as const,
            path: rebaseWorkspacePath(
              entry.path.path,
              previousCwd,
              nextCwd,
            ),
          },
        };
      case "glob":
        return {
          ...entry,
          path: {
            kind: "glob" as const,
            pattern: rebaseWorkspacePath(
              entry.path.pattern,
              previousCwd,
              nextCwd,
            ),
          },
        };
      case "special":
        if (entry.path.value.kind !== "unknown") return entry;
        return {
          ...entry,
          path: {
            kind: "special" as const,
            value: {
              ...entry.path.value,
              path: rebaseWorkspacePath(
                entry.path.value.path,
                previousCwd,
                nextCwd,
              ),
            },
          },
        };
    }
  });
  return {
    ...profile,
    fileSystem: {
      ...profile.fileSystem,
      entries,
    },
  };
}

function rebaseWorkspacePath(
  candidate: string,
  previousCwd: string,
  nextCwd: string,
): string {
  if (!path.isAbsolute(candidate)) return candidate;
  const relative = path.relative(previousCwd, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return candidate;
  }
  return path.join(nextCwd, relative);
}

export function resolveSpawnExecutable(options: {
  readonly program: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}): string {
  const program = options.program.trim();
  if (program.length === 0 || /[\0\r\n]/u.test(program)) {
    throw new UnifiedExecError("create_process", "invalid executable name");
  }
  const platform = options.platform ?? process.platform;
  const hasPathSyntax =
    path.isAbsolute(program) || program.includes("/") || program.includes("\\");
  const candidateNames = executableCandidateNames(program, platform, options.env);
  const candidates = hasPathSyntax
    ? candidateNames.map((candidate) =>
        path.isAbsolute(candidate)
          ? candidate
          : path.resolve(options.cwd, candidate)
      )
    : executableSearchDirectories(options.env, options.cwd).flatMap((directory) =>
        candidateNames.map((candidate) => path.join(directory, candidate))
      );
  for (const candidate of candidates) {
    if (!isSpawnExecutable(candidate, platform)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      return path.resolve(candidate);
    }
  }
  throw new UnifiedExecError(
    "create_process",
    `executable not found or not executable: ${program}`,
  );
}

function executableSearchDirectories(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string[] {
  return (env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.length === 0 ? cwd : path.resolve(cwd, entry));
}

function executableCandidateNames(
  program: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform !== "win32") return [program];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((entry) => entry.length > 0);
  const lower = program.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension.toLowerCase()))) {
    return [program];
  }
  return [program, ...extensions.map((extension) => `${program}${extension}`)];
}

function isSpawnExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

export function probeSandboxExecutionStatus(options: {
  readonly mode: SandboxMode;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly agencLinuxSandboxExe?: string;
}): SandboxExecutionStatus {
  if (options.mode === "danger_full_access") {
    return {
      kind: "not_required",
      mode: options.mode,
      platform: options.platform,
      reason: "danger-full-access was selected explicitly",
    };
  }
  if (options.mode === "external_sandbox") {
    return {
      kind: "external",
      mode: options.mode,
      platform: options.platform,
      reason: "an external sandbox was selected explicitly",
    };
  }
  if (options.platform === "linux") {
    return probeLinuxSandbox(options);
  }
  if (options.platform === "darwin") {
    return probeMacOSSandbox(options);
  }
  return unavailableStatus(
    options,
    options.platform === "win32"
      ? "Windows restricted-token sandbox is not implemented"
      : `platform ${options.platform} has no supported sandbox`,
    options.platform === "win32"
      ? "Use WSL2 with bubblewrap, an explicit external sandbox, or select danger-full-access deliberately."
      : "Use a supported platform or an explicit external sandbox.",
  );
}

const GENERIC_LINUX_NAMESPACE_REMEDIATION =
  "Enable unprivileged user namespaces or use a supported container/WSL2 host, then run `agenc doctor` again.";

export function linuxSandboxProbeRemediation(
  diagnostic: string,
  appArmorRestriction?: string | null,
): string {
  return isAppArmorUserNamespaceDenial(diagnostic, appArmorRestriction)
    ? APPARMOR_USERNS_REMEDIATION
    : GENERIC_LINUX_NAMESPACE_REMEDIATION;
}

function probeLinuxSandbox(options: {
  readonly mode: SandboxMode;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly agencLinuxSandboxExe?: string;
}): SandboxExecutionStatus {
  const helper = resolveTrustedLinuxSandboxExecutable(
    options.agencLinuxSandboxExe ?? resolveDefaultLinuxSandboxExecutable(),
    options.cwd,
  );
  if (helper.error !== undefined) {
    return unavailableStatus(
      options,
      helper.error,
      linuxSandboxHelperRemediation(options.cwd, options.env),
    );
  }
  // When any bubblewrap rung fails, the helper falls back to Landlock at
  // spawn time for the policies an allow-list can express. The probe mirrors
  // that decision so startup readiness matches what commands will actually
  // do; the per-policy refusals stay with the helper, which sees the policy.
  const landlockFallback = (
    bwrapReason: string,
    bwrapRemediation: string,
    isolationProgram?: string,
  ): SandboxExecutionStatus => {
    // Operational kill-switch: with the fallback disabled, the original
    // fail-closed bubblewrap contract holds verbatim.
    const disabled = options.env.AGENC_DISABLE_LANDLOCK_FALLBACK === "1";
    const launcher = disabled ? undefined : resolveLandlockRun();
    if (launcher !== undefined && probeLandlock(launcher) === "full") {
      return {
        kind: "ready",
        mode: options.mode,
        platform: options.platform,
        helperPath: helper.path,
        isolationProgram: launcher,
        reason: `${bwrapReason}; the Landlock fallback is active`,
        landlock: "full",
        landlockFallback: {
          reason: bwrapReason,
          remediation: bwrapRemediation,
        },
      };
    }
    return unavailableStatus(
      options,
      bwrapReason,
      bwrapRemediation,
      helper.path,
      isolationProgram,
    );
  };
  // Pass the session value through even when it is absent. The resolver treats
  // an omitted argument as permission to use process.env.PATH, while this
  // explicit `undefined` preserves a decoded client PATH tombstone.
  const bwrap = findSystemBubblewrapInPath(options.env.PATH, options.cwd);
  if (bwrap === null) {
    return landlockFallback(
      "bubblewrap was not found in a trusted system directory",
      "Install bubblewrap with the OS package manager, then run `agenc doctor` again.",
    );
  }
  if (!systemBubblewrapSupportsBindFd(bwrap, options.env)) {
    return landlockFallback(
      "bubblewrap does not support descriptor-based read-only binds",
      "Upgrade bubblewrap to a version that supports --ro-bind-fd, then run `agenc doctor` again.",
      bwrap,
    );
  }
  const result = probeSystemBubblewrapNamespaces(
    bwrap,
    options.env,
    options.cwd,
  );
  if (!result.ok) {
    const detail = boundedDiagnostic(result.diagnostic);
    return landlockFallback(
      `probe: bubblewrap could not create the required namespaces${detail ? ` (${detail})` : ""}`,
      linuxSandboxProbeRemediation(detail),
      bwrap,
    );
  }
  return {
    kind: "ready",
    mode: options.mode,
    platform: options.platform,
    helperPath: helper.path,
    isolationProgram: bwrap,
  };
}

function probeMacOSSandbox(options: {
  readonly mode: SandboxMode;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): SandboxExecutionStatus {
  const program = "/usr/bin/sandbox-exec";
  const executable = executableFile(program);
  if (!executable.ok) {
    return unavailableStatus(
      options,
      executable.reason,
      "Restore the system sandbox-exec binary or select an explicit external sandbox.",
    );
  }
  const result = spawnSync(
    program,
    [
      "-p",
      "(version 1) (deny default) (allow process-exec) (allow file-read*)",
      "/usr/bin/true",
    ],
    {
      cwd: options.cwd,
      env: sanitizeSandboxLauncherEnvironment(options.env),
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = boundedDiagnostic(
      result.error?.message ?? result.stderr ?? `exit status ${String(result.status)}`,
    );
    return unavailableStatus(
      options,
      `probe: sandbox-exec failed its restricted-process check${detail ? ` (${detail})` : ""}`,
      "Repair the macOS sandbox facility or select an explicit external sandbox.",
      undefined,
      program,
    );
  }
  return {
    kind: "ready",
    mode: options.mode,
    platform: options.platform,
    isolationProgram: program,
  };
}

function unavailableStatus(
  options: {
    readonly mode: SandboxMode;
    readonly platform: NodeJS.Platform;
  },
  reason: string,
  remediation: string,
  helperPath?: string,
  isolationProgram?: string,
): SandboxExecutionStatus {
  return {
    kind: "unavailable",
    mode: options.mode,
    platform: options.platform,
    reason,
    remediation,
    ...(helperPath !== undefined ? { helperPath } : {}),
    ...(isolationProgram !== undefined ? { isolationProgram } : {}),
  };
}

export const LINUX_SANDBOX_HELPER_REINSTALL_REMEDIATION =
  "Install AgenC with its executable sandbox helper outside the workspace, then run `agenc doctor` again.";

export const LINUX_SANDBOX_HOME_WORKSPACE_REMEDIATION =
  "This workspace contains your home directory, where AgenC installs its runtime, " +
  "so the helper can never sit outside it. Open AgenC in a project directory instead, " +
  "then run `agenc doctor` again.";

/**
 * A userland install puts the helper under ~/.agenc, so a workspace that
 * contains the user's home can never satisfy the containment rule -- and a
 * bare `agenc` in a fresh terminal opens exactly that workspace. Sending that
 * user to reinstall the helper "outside the workspace" points at the wrong
 * thing; the actionable fix is to open a project directory. The refusal itself
 * is unchanged: a jailed process that can rewrite its own jailer is not jailed.
 */
export function linuxSandboxHelperRemediation(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  const configured = env.HOME;
  const home = configured !== undefined && path.isAbsolute(configured)
    ? configured
    : homedir();
  if (home.length === 0) return LINUX_SANDBOX_HELPER_REINSTALL_REMEDIATION;
  return isPathUnder(safeRealpath(home), safeRealpath(workspaceRoot))
    ? LINUX_SANDBOX_HOME_WORKSPACE_REMEDIATION
    : LINUX_SANDBOX_HELPER_REINSTALL_REMEDIATION;
}

export function resolveTrustedLinuxSandboxExecutable(
  candidate: string,
  workspaceRoot: string,
): { readonly path: string; readonly error?: undefined } | {
  readonly path?: undefined;
  readonly error: string;
} {
  const resolved = path.resolve(candidate);
  const executable = executableFile(resolved);
  if (!executable.ok) return { error: executable.reason };
  const helperReal = safeRealpath(resolved);
  const workspaceReal = safeRealpath(workspaceRoot);
  if (isPathUnder(helperReal, workspaceReal)) {
    return { error: "Linux sandbox helper must be outside the writable workspace" };
  }
  return { path: helperReal };
}

function executableFile(
  target: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  try {
    const stat = statSync(target);
    if (!stat.isFile()) {
      return { ok: false, reason: `sandbox executable is not a file: ${target}` };
    }
    if ((stat.mode & 0o111) === 0) {
      return { ok: false, reason: `sandbox executable is not executable: ${target}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `sandbox executable does not exist: ${target}` };
  }
}

export function resolveDefaultLinuxSandboxExecutable(
  moduleUrl = import.meta.url,
): string {
  // Dev checkouts live inside the writable workspace, which trips the
  // "helper must be outside the workspace" trust invariant enforced by
  // resolveTrustedLinuxSandboxExecutable. AGENC_LINUX_SANDBOX_EXE points at a
  // helper installed outside the workspace; packaged installs never need it.
  const override = process.env.AGENC_LINUX_SANDBOX_EXE;
  if (override !== undefined && override.trim() !== "") {
    return override;
  }
  const runtimeRoot = resolveRuntimePackageRootFromUrl(moduleUrl);
  return runtimeRoot === null
    ? fileURLToPath(new URL("../../bin/agenc-linux-sandbox", moduleUrl))
    : path.join(runtimeRoot, "bin", "agenc-linux-sandbox");
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundedDiagnostic(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 300);
}

export function transformSandboxedCommand(params: SandboxSpawnCommand & {
  readonly runtimeSandbox: UnifiedExecRuntimeSandbox;
  readonly sandboxManager?: SandboxExecutionManager;
}): SandboxSpawnCommand {
  const sandboxManager = params.sandboxManager ?? defaultSandboxManager;
  const permissions = params.runtimeSandbox.permissionProfile;
  const windowsSandboxLevel =
    params.runtimeSandbox.windowsSandboxLevel ?? "disabled";
  let sandbox: SandboxType = "none";
  try {
    sandbox = sandboxManager.selectInitial({
      fileSystemPolicy: permissions.fileSystem,
      networkPolicy: permissions.network,
      preference: params.runtimeSandbox.preference ?? "require",
      windowsSandboxLevel,
      hasManagedNetworkRequirements:
        params.runtimeSandbox.enforceManagedNetwork === true ||
        params.runtimeSandbox.network !== undefined,
    });
    if (
      sandbox === "none" &&
      (params.runtimeSandbox.preference ?? "require") === "require"
    ) {
      throw new UnifiedExecError(
        "create_process",
        "sandbox isolation was required but no platform sandbox is available",
      );
    }
    const transformed = sandboxManager.transform({
      command: {
        program: params.program,
        args: params.args,
        cwd: params.cwd,
        env: params.env,
        ...(params.cwdBinding !== undefined
          ? { cwdBinding: params.cwdBinding }
          : {}),
        ...(params.runtimeSandbox.additionalPermissions !== undefined
          ? { additionalPermissions: params.runtimeSandbox.additionalPermissions }
          : {}),
      },
      permissions,
      sandbox,
      enforceManagedNetwork:
        params.runtimeSandbox.enforceManagedNetwork ?? false,
      ...(params.runtimeSandbox.network !== undefined
        ? { network: params.runtimeSandbox.network }
        : {}),
      ...(params.runtimeSandbox.networkPolicyDecider !== undefined
        ? { networkPolicyDecider: params.runtimeSandbox.networkPolicyDecider }
        : {}),
      ...(params.runtimeSandbox.blockedRequestObserver !== undefined
        ? { blockedRequestObserver: params.runtimeSandbox.blockedRequestObserver }
        : {}),
      sandboxPolicyCwd: params.runtimeSandbox.sandboxPolicyCwd,
      sessionTempRoot: params.runtimeSandbox.sessionTempRoot,
      ...(params.runtimeSandbox.agencLinuxSandboxExe !== undefined
        ? { agencLinuxSandboxExe: params.runtimeSandbox.agencLinuxSandboxExe }
        : {}),
      windowsSandboxLevel,
      windowsSandboxPrivateDesktop:
        params.runtimeSandbox.windowsSandboxPrivateDesktop ?? false,
      ...(params.runtimeSandbox.allowGpu === true ? { allowGpu: true } : {}),
    });
    const [program, ...args] = transformed.command;
    if (program === undefined) {
      throw new UnifiedExecError(
        "create_process",
        "sandbox transform returned an empty command",
      );
    }
    return {
      program,
      args,
      cwd: transformed.cwd,
      env: { ...transformed.env },
      argv0: transformed.arg0 ?? basename(program),
    };
  } catch (error) {
    if (error instanceof UnifiedExecError) throw error;
    throw new UnifiedExecError(
      "create_process",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const BROKER_MARKER = Symbol("agenc.sandboxExecutionBroker");
const BROKER_ARG = "__sandboxExecutionBroker";
const SURFACE_ARG = "__sandboxExecutionSurface";
const EXECUTION_SURFACES = new Set<SandboxExecutionSurface>([
  "startup",
  "interactive",
  "print",
  "background",
  "job",
  "hook",
  "cron",
  "mcp_stdio",
  "lsp",
  "browser",
  "provider",
  "powershell_parser",
  "pane_agent",
  "child_agent",
  "command_exec",
  "tool",
]);

export function attachSandboxExecutionBroker(
  args: Record<string, unknown>,
  broker: SandboxExecutionBrokerLike,
  surface?: SandboxExecutionSurface,
): void {
  if ((broker as { [BROKER_MARKER]?: unknown })[BROKER_MARKER] !== true) {
    Object.defineProperty(broker, BROKER_MARKER, {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  Object.defineProperty(args, BROKER_ARG, {
    value: broker,
    enumerable: false,
    configurable: true,
  });
  if (surface !== undefined) {
    Object.defineProperty(args, SURFACE_ARG, {
      value: surface,
      enumerable: false,
      configurable: true,
    });
  }
}

export function readSandboxExecutionBroker(
  args: Record<string, unknown>,
): SandboxExecutionBrokerLike | undefined {
  const value = args[BROKER_ARG];
  if (typeof value !== "object" || value === null) return undefined;
  if ((value as { [BROKER_MARKER]?: unknown })[BROKER_MARKER] !== true) {
    return undefined;
  }
  const candidate = value as Partial<SandboxExecutionBrokerLike>;
  return typeof candidate.prepareSpawn === "function" &&
    typeof candidate.runtimeSandbox === "function" &&
    typeof candidate.assertReady === "function" &&
    typeof candidate.cwd === "string" &&
    typeof candidate.forkForCwd === "function"
    ? (value as SandboxExecutionBrokerLike)
    : undefined;
}

export function readSandboxExecutionSurface(
  args: Record<string, unknown>,
): SandboxExecutionSurface | undefined {
  if (readSandboxExecutionBroker(args) === undefined) return undefined;
  const value = args[SURFACE_ARG];
  return typeof value === "string" &&
      EXECUTION_SURFACES.has(value as SandboxExecutionSurface)
    ? value as SandboxExecutionSurface
    : undefined;
}
