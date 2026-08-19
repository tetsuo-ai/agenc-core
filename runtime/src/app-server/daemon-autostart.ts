/**
 * AgenC daemon autostart orchestration.
 *
 * F-04a owns the thin-client startup contract: check for the daemon, start it
 * if needed, wait until it is ready, then hand control to a connector hook.
 */

import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createNodeDaemonCliHost,
  readAgenCDaemonPid,
  readAgenCDaemonSpawnStderrTail,
  removeAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonReadyTimeoutMs,
  requestAgenCDaemonInstanceIdentity,
  requestAgenCDaemonShutdown,
  resolveAgenCDaemonSocketPath,
  runAgenCDaemonCli,
  resolveAgenCDaemonHome,
  withAgenCDaemonLifecycleLock,
  writeAgenCDaemonPid,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
} from "./daemon-cli.js";
import {
  daemonInstanceIdentityFromRuntimeInfo,
  readDaemonRuntimeInfo,
  readDistVersion,
  removeDaemonRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
  resolveRuntimePackageRootFromUrl,
} from "./daemon-runtime-info.js";
import {
  findLinuxAgenCDaemonProcesses,
  inspectLinuxAgenCDaemonProcess,
  readAgenCDaemonProcessStart,
  sameAgenCDaemonInstanceIdentity,
  type AgenCDaemonInstanceIdentity,
  type AgenCDaemonProcessIdentity,
} from "./daemon-instance-identity.js";
import { loadConfig } from "../config/loader.js";
import {
  resolveMcpServeDefaults,
  type ResolvedMcpServeDefaults,
} from "../mcp/server/start.js";
import {
  canConnectToUnixSocket,
  isAgenCWindowsNamedPipePath,
} from "./transport/unix-socket.js";

export type AgenCDaemonAutostartStatus = "already-running" | "started";

/**
 * Default cold-start readiness budget for the agent autostart path. Derived
 * from the shared {@link resolveAgenCDaemonReadyTimeoutMs} default (45s, raised
 * from 15s — see that helper for the cold-hydration rationale) so the autostart
 * and bare-control (`start`/`restart`/`reload`) budgets stay in sync from one
 * source. The actual wait honors the `AGENC_DAEMON_READY_TIMEOUT_MS` env
 * override via {@link resolveAgenCDaemonReadyTimeoutMs}; this constant is the
 * resolved fallback used when no per-call override is supplied.
 */
export const AGENC_DAEMON_AUTOSTART_READY_TIMEOUT_MS =
  resolveAgenCDaemonReadyTimeoutMs({});

const AGENC_DAEMON_BUILD_SKEW_STOP_TIMEOUT_MS = 5_000;
const AGENC_DAEMON_ORPHAN_STOP_TIMEOUT_MS = 1_000;
const AGENC_DAEMON_FORCE_STOP_GRACE_MS = 2_000;
const AGENC_DAEMON_STOP_POLL_MS = 50;

export interface AgenCDaemonConnectionTarget {
  readonly pid: number;
  readonly pidPath: string;
}

/**
 * Autostart-specific process identity seam. The token must remain stable for
 * one process lifetime and change when the operating system reuses a PID.
 */
interface AgenCDaemonAutostartHost extends AgenCDaemonCliHost {
  /** Test seam for cross-platform forced-signal policy. */
  readonly platform?: NodeJS.Platform;
  readonly requestDaemonInstanceIdentity?: (
    target: AgenCDaemonConnectionTarget,
  ) => Promise<AgenCDaemonInstanceIdentity> | AgenCDaemonInstanceIdentity;
  readonly requestDaemonShutdown?: (
    expected: AgenCDaemonInstanceIdentity,
  ) => Promise<void> | void;
  /** @internal Full argv/home/start proof seam for lifecycle race tests. */
  readonly inspectLegacyDaemonProcess?: (
    pid: number,
  ) =>
    | Promise<AgenCDaemonProcessIdentity | null>
    | AgenCDaemonProcessIdentity
    | null;
}

interface BoundAgenCDaemonInstance {
  readonly identity: AgenCDaemonInstanceIdentity;
  readonly process: AgenCDaemonProcessIdentity;
}

export interface AgenCDaemonAutostartResult extends AgenCDaemonConnectionTarget {
  readonly status: AgenCDaemonAutostartStatus;
  readonly ready: true;
  readonly connected: boolean;
}

export interface AgenCDaemonAutostartConfig {
  readonly daemonEnabled: boolean;
  readonly mcpServer: ResolvedMcpServeDefaults;
}

export interface AgenCDaemonAutostartOptions {
  readonly host?: AgenCDaemonAutostartHost;
  readonly io?: AgenCDaemonCliIo;
  readonly waitTimeoutMs?: number;
  readonly pollMs?: number;
  readonly isReady?: (
    target: AgenCDaemonConnectionTarget,
  ) => boolean | Promise<boolean>;
  readonly connect?: (
    target: AgenCDaemonConnectionTarget,
  ) => Promise<void> | void;
  /** Isolated contract-test seam for the post-socket identity barrier. */
  readonly identityPublicationBarrier?: (
    host: AgenCDaemonCliHost,
  ) => Promise<void> | void;
  /** Isolated race seam while verified metadata removal holds its lock. */
  readonly afterVerifiedExitBeforeMetadataRemoval?: () => Promise<void> | void;
  readonly findOrphanDaemonPids?: (
    targetHome: string,
  ) => Promise<readonly number[]> | readonly number[];
  /**
   * Daemons serving this home from any install, used to reap the ones the pid
   * file cannot track. Defaults to a /proc scan; when `findOrphanDaemonPids`
   * is stubbed without this, reaping is skipped so orphan-path tests keep
   * their exact kill expectations.
   */
  readonly findSupersededDaemonPids?: (
    targetHome: string,
  ) => Promise<readonly number[]> | readonly number[];
  readonly terminateOrphanDaemonPid?: (pid: number) => Promise<void> | void;
  readonly inspectLegacyDaemonProcess?: (
    pid: number,
  ) =>
    | Promise<AgenCDaemonProcessIdentity | null>
    | AgenCDaemonProcessIdentity
    | null;
  /** Test seam for the authenticated initialize identity round-trip. */
  readonly requestDaemonInstanceIdentity?: (
    target: AgenCDaemonConnectionTarget,
  ) => Promise<AgenCDaemonInstanceIdentity> | AgenCDaemonInstanceIdentity;
  /** Test seam for the authenticated daemon self-shutdown RPC. */
  readonly requestDaemonShutdown?: (
    expected: AgenCDaemonInstanceIdentity,
  ) => Promise<void> | void;
}

export class AgenCDaemonAutostartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgenCDaemonAutostartError";
  }
}

export function shouldAutostartAgenCDaemon(
  env: NodeJS.ProcessEnv = process.env,
  configAutostart = true,
): boolean {
  const raw = env.AGENC_DAEMON_AUTOSTART?.trim().toLowerCase();
  if (raw !== undefined && raw.length > 0) {
    return raw !== "0" && raw !== "false" && raw !== "off";
  }
  return configAutostart;
}

export async function resolveAgenCDaemonAutostartEnabled(
  env: NodeJS.ProcessEnv = process.env,
  userHome?: string,
): Promise<boolean> {
  return (await resolveAgenCDaemonAutostartConfig(env, userHome)).daemonEnabled;
}

export async function resolveAgenCDaemonAutostartConfig(
  env: NodeJS.ProcessEnv = process.env,
  userHome?: string,
): Promise<AgenCDaemonAutostartConfig> {
  const home = resolveAgenCDaemonHome(env, userHome);
  const loaded = await loadConfig({ home });
  const configAutostart = loaded.config.daemon?.autostart ?? true;
  return {
    daemonEnabled: shouldAutostartAgenCDaemon(env, configAutostart),
    mcpServer: resolveMcpServeDefaults(loaded.config.mcp?.server),
  };
}

export async function ensureAgenCDaemonAutostart(
  options: AgenCDaemonAutostartOptions = {},
): Promise<AgenCDaemonAutostartResult> {
  const host: AgenCDaemonAutostartHost =
    options.host ?? createNodeDaemonCliHost();
  const io = options.io ?? silentIo();
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
  let status: AgenCDaemonAutostartStatus = "already-running";
  let pid = await readAgenCDaemonPid(pidPath);
  let spawnedPid: number | null = null;
  let spawnedProcess: AgenCDaemonProcessIdentity | null = null;
  let postSpawnPhase = false;
  let spawnedControlReleased = false;

  try {
    // A stale pid file may name a live but unrelated reused PID while the real
    // daemon has already published a fresh sidecar. Never probe or signal that
    // numeric PID as the daemon: bind the sidecar to the authenticated socket
    // and stable process identity, then repair the pid file while the lifecycle
    // transaction excludes a concurrent publisher.
    await withAgenCDaemonLifecycleLock(host, async () => {
      pid = await readAgenCDaemonPid(pidPath);
      const sidecarIdentity = daemonInstanceIdentityFromRuntimeInfo(
        readDaemonRuntimeInfo(runtimeInfoPath),
      );
      if (
        pid !== null &&
        host.isPidRunning(pid) &&
        sidecarIdentity !== null &&
        sidecarIdentity.pid !== pid
      ) {
        const stalePid = pid;
        const rebound = await proveRecordedAgenCDaemonInstance({
          expectedPid: sidecarIdentity.pid,
          pidPath,
          runtimeInfoPath,
          host,
          options,
        });
        const sidecarNow = daemonInstanceIdentityFromRuntimeInfo(
          readDaemonRuntimeInfo(runtimeInfoPath),
        );
        if (
          rebound !== null &&
          (await readAgenCDaemonPid(pidPath)) === stalePid &&
          sidecarNow !== null &&
          sameAgenCDaemonInstanceIdentity(rebound.identity, sidecarNow)
        ) {
          await writeAgenCDaemonPid(pidPath, rebound.identity.pid);
          pid = rebound.identity.pid;
        } else {
          pid = await readAgenCDaemonPid(pidPath);
        }
      }
    });

    let respawnReason: string | null = null;
    if (pid !== null && !host.isPidRunning(pid)) {
      respawnReason = `daemon pid ${pid} not running — stale pid file`;
    } else if (pid === null) {
      respawnReason = "no daemon pid recorded";
    }

    if (pid === null || !host.isPidRunning(pid)) {
      const recoveredPid = await recoverPidlessAgenCDaemon({
        daemonHome,
        pidPath,
        host,
        options,
      });
      if (recoveredPid !== null) {
        pid = recoveredPid;
        respawnReason = null;
      }
    }

    if (pid === null || !host.isPidRunning(pid)) {
      // On Linux, a replacement must not begin startup recovery while a daemon
      // from a superseded install still owns rollout locks for this home. Reap
      // every discoverable untracked same-home daemon before spawning; the
      // post-spawn pass below remains as a bounded race check for a concurrent
      // external launch. Other platforms retain their existing pid/socket
      // lifecycle because this module has no safe arbitrary-process ownership
      // proof for them.
      await reapSupersededAgenCDaemons({
        daemonHome,
        keepPid: null,
        host,
        options,
        io,
      });
      // Round-2 M-NEW3: previously the autostart respawned silently
      // because `io` defaulted to `silentIo`. Surface the start event
      // on stderr so the user sees that a daemon respawn happened
      // (without bypassing the silent default for tests that pass
      // their own io). Reason is set above based on which branch
      // triggered the respawn.
      if (respawnReason !== null) {
        io.stderr.write(`agenc: starting daemon (${respawnReason})\n`);
      }
      const startingHost: AgenCDaemonAutostartHost = {
        ...host,
        spawnDetachedDaemon: (env) => {
          const childPid = host.spawnDetachedDaemon(env);
          spawnedPid = childPid;
          return childPid;
        },
      };
      const startExit = await runAgenCDaemonCli(
        { kind: "command", action: "start" },
        {
          host: startingHost,
          io,
          // Autostart owns the richer ready/exited/timeout diagnosis below and
          // the post-ready authenticated instance proof. The CLI start helper
          // still serializes its mutation and publishes the provisional pid.
          deferDaemonReadyWaitToCaller: true,
          inspectLegacyDaemonProcess: options.inspectLegacyDaemonProcess,
          requestDaemonInstanceIdentity: async (readyHost) => {
            const readyPid = await readAgenCDaemonPid(pidPath);
            if (readyPid === null) {
              throw new Error("daemon pid disappeared during start");
            }
            const requestIdentity =
              options.requestDaemonInstanceIdentity ??
              startingHost.requestDaemonInstanceIdentity;
            return requestIdentity === undefined
              ? requestAgenCDaemonInstanceIdentity(readyHost)
              : requestIdentity({ pid: readyPid, pidPath });
          },
        },
      );
      if (startExit !== 0) {
        throw new AgenCDaemonAutostartError("AgenC daemon start failed");
      }
      postSpawnPhase = spawnedPid !== null;
      pid = await readAgenCDaemonPid(pidPath);
      if (spawnedPid !== null) {
        spawnedProcess = await captureAgenCDaemonProcessIdentity(
          spawnedPid,
          host,
        );
        status = "started";
      }
    }

    if (pid === null) {
      throw new AgenCDaemonAutostartError(
        "AgenC daemon pid file was not written",
      );
    }

    const target = { pid, pidPath };
    const ready = await waitForAgenCDaemonReady(target, host, options);
    if (ready === "exited") {
      // The daemon process died before becoming ready. Waiting longer cannot
      // help, and calling this a timeout sends the operator debugging the
      // wrong thing — surface the captured early-crash stderr instead.
      const stderrTail = readAgenCDaemonSpawnStderrTail(
        host.env,
        host.userHome,
      );
      const error = new AgenCDaemonAutostartError(
        `AgenC daemon exited before becoming ready (pid ${pid})` +
          (stderrTail.length > 0 ? `: ${stderrTail}` : ""),
      );
      if (status === "started") {
        throw error;
      }
      await removeExitedAgenCDaemonMetadata({
        pid,
        pidPath,
        runtimeInfoPath,
        host,
      });
      throw error;
    }
    if (ready !== "ready") {
      const error = new AgenCDaemonAutostartError(
        `AgenC daemon did not become ready before timeout (pid ${pid})`,
      );
      if (status === "started") {
        throw error;
      }
      throw error;
    }

    // The foreground child binds its socket before committing the identity
    // sidecar and final pid. Crossing the same lifecycle transaction here turns
    // socket readiness into a causal publication barrier: proof below can never
    // mistake a healthy, still-publishing replacement for an unbound process.
    if (options.identityPublicationBarrier === undefined) {
      await withAgenCDaemonLifecycleLock(host, async () => {});
    } else {
      await Promise.resolve(options.identityPublicationBarrier(host));
    }

    const runtimeInfoBeforeProof = readDaemonRuntimeInfo(runtimeInfoPath);
    if (
      runtimeInfoBeforeProof === null ||
      (runtimeInfoBeforeProof.pid === pid &&
        daemonInstanceIdentityFromRuntimeInfo(runtimeInfoBeforeProof) === null)
    ) {
      const legacyPid = pid;
      if (hostPlatform(host) !== "linux") {
        throw instanceProofFailed(
          legacyPid,
          "legacy daemon has no portable instance binding; stop it with the OS service/process manager after verifying its command and home, then retry",
        );
      }
      const legacyProcess = await withAgenCDaemonLifecycleLock(
        host,
        async (): Promise<AgenCDaemonProcessIdentity> => {
          if (
            (await readAgenCDaemonPid(pidPath)) !== legacyPid ||
            JSON.stringify(readDaemonRuntimeInfo(runtimeInfoPath)) !==
              JSON.stringify(runtimeInfoBeforeProof)
          ) {
            throw instanceProofFailed(
              legacyPid,
              "legacy daemon metadata changed",
            );
          }
          const inspectLegacy =
            options.inspectLegacyDaemonProcess ??
            host.inspectLegacyDaemonProcess ??
            ((targetPid: number) =>
              inspectLinuxAgenCDaemonProcess(
                targetPid,
                host,
                daemonHome,
                "any-install",
              ));
          const inspected = await Promise.resolve(inspectLegacy(legacyPid));
          if (inspected === null) {
            throw instanceProofFailed(
              legacyPid,
              "legacy daemon could not be proven as a same-home Linux daemon",
            );
          }
          return inspected;
        },
      );
      await terminateAgenCDaemonPid(
        legacyProcess,
        daemonHome,
        host,
        options,
        AGENC_DAEMON_BUILD_SKEW_STOP_TIMEOUT_MS,
      );
      await withAgenCDaemonLifecycleLock(host, async () => {
        if (
          (await readAgenCDaemonPid(pidPath)) !== legacyPid ||
          host.isPidRunning(legacyPid)
        ) {
          return;
        }
        await removeAgenCDaemonPid(pidPath, legacyPid);
        if (
          runtimeInfoBeforeProof !== null &&
          JSON.stringify(readDaemonRuntimeInfo(runtimeInfoPath)) ===
            JSON.stringify(runtimeInfoBeforeProof)
        ) {
          removeDaemonRuntimeInfo(runtimeInfoPath);
        }
      });
      return ensureAgenCDaemonAutostart(options);
    }

    let verifiedInstance: BoundAgenCDaemonInstance | null;
    try {
      verifiedInstance = await proveRecordedAgenCDaemonInstance({
        expectedPid: pid,
        pidPath,
        runtimeInfoPath,
        host,
        options,
      });
    } catch (error) {
      throw error;
    }
    if (verifiedInstance === null) {
      const error = instanceProofFailed(pid, "identity sidecar is unavailable");
      if (status === "started") {
        throw error;
      }
      throw error;
    }
    // Compare builds only after the complete identity proof. A PID and mutable
    // sidecar alone are never authority to stop a process.
    const runtimeRoot = resolveRuntimePackageRootFromUrl(import.meta.url);
    const currentVersion = host.readCurrentRuntimeBuild
      ? host.readCurrentRuntimeBuild()
      : runtimeRoot !== null
        ? readDistVersion(runtimeRoot)
        : null;
    if (
      currentVersion !== null &&
      (verifiedInstance.identity.runtimeVersion !==
        currentVersion.runtimeVersion ||
        verifiedInstance.identity.commit !== currentVersion.commit ||
        verifiedInstance.identity.buildTime !== currentVersion.buildTime)
    ) {
      io.stderr.write(
        `agenc: starting daemon (daemon build identity differs from on-disk runtime)\n`,
      );
      try {
        await terminateRecordedAgenCDaemonInstance({
          expected: verifiedInstance,
          daemonHome,
          pidPath,
          runtimeInfoPath,
          host,
          options,
          gracefulTimeoutMs: AGENC_DAEMON_BUILD_SKEW_STOP_TIMEOUT_MS,
        });
        await removeVerifiedAgenCDaemonMetadata({
          expected: verifiedInstance,
          pidPath,
          runtimeInfoPath,
          host,
          options,
        });
      } catch (error) {
        throw error;
      }
      return ensureAgenCDaemonAutostart(options);
    }
    try {
      await reapSupersededAgenCDaemons({
        daemonHome,
        keepPid: pid,
        host,
        options,
        io,
      });
    } catch (error) {
      throw error;
    }

    try {
      await Promise.resolve(options.connect?.(target));
    } catch (error) {
      throw error;
    }
    if (status === "started" && spawnedPid !== null) {
      host.releaseSpawnedDaemonControl?.(spawnedPid);
      spawnedControlReleased = true;
    }
    return {
      ...target,
      status,
      ready: true,
      connected: options.connect !== undefined,
    };
  } catch (error) {
    if (postSpawnPhase && spawnedPid !== null && !spawnedControlReleased) {
      return failStartedAgenCDaemonReplacement({
        error,
        spawnedPid,
        spawnedProcess,
        daemonHome,
        pidPath,
        runtimeInfoPath,
        host,
        options,
      });
    }
    throw error;
  }
}

async function recoverPidlessAgenCDaemon(params: {
  readonly daemonHome: string;
  readonly pidPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
}): Promise<number | null> {
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(
    dirname(params.pidPath),
  );
  const recoveredPid = await withAgenCDaemonLifecycleLock(
    params.host,
    async () => {
      const pidSnapshot = await readAgenCDaemonPid(params.pidPath);
      const recorded = await proveRecordedAgenCDaemonInstance({
        pidPath: params.pidPath,
        runtimeInfoPath,
        host: params.host,
        options: params.options,
      });
      if (recorded === null) {
        // A concurrent detached start may have published its provisional pid
        // before the foreground child publishes the authenticated sidecar.
        // Preserve that generation and let the normal readiness/publication
        // barrier below prove it instead of spawning an overlap.
        return pidSnapshot !== null && params.host.isPidRunning(pidSnapshot)
          ? pidSnapshot
          : null;
      }

      const sidecarNow = daemonInstanceIdentityFromRuntimeInfo(
        readDaemonRuntimeInfo(runtimeInfoPath),
      );
      if (
        (await readAgenCDaemonPid(params.pidPath)) !== pidSnapshot ||
        sidecarNow === null ||
        !sameAgenCDaemonInstanceIdentity(recorded.identity, sidecarNow)
      ) {
        throw instanceProofFailed(
          recorded.identity.pid,
          "daemon metadata changed while repairing the missing pid file",
        );
      }
      if (pidSnapshot !== recorded.identity.pid) {
        await writeAgenCDaemonPid(params.pidPath, recorded.identity.pid);
      }
      const sidecarAfter = daemonInstanceIdentityFromRuntimeInfo(
        readDaemonRuntimeInfo(runtimeInfoPath),
      );
      if (
        (await readAgenCDaemonPid(params.pidPath)) !== recorded.identity.pid ||
        sidecarAfter === null ||
        !sameAgenCDaemonInstanceIdentity(recorded.identity, sidecarAfter)
      ) {
        throw instanceProofFailed(
          recorded.identity.pid,
          "daemon metadata changed while publishing the repaired pid file",
        );
      }
      return recorded.identity.pid;
    },
  );
  if (recoveredPid !== null) return recoveredPid;

  const orphanProcesses =
    params.options.findOrphanDaemonPids === undefined
      ? await findPidlessAgenCDaemonProcesses(params.host, params.daemonHome)
      : await captureInjectedAgenCDaemonProcesses(
          await Promise.resolve(
            params.options.findOrphanDaemonPids(params.daemonHome),
          ),
          params.host,
        );
  const socketPath = resolveAgenCDaemonSocketPath(
    params.host.env,
    params.host.userHome,
  );
  const socketAccepting =
    (await isAgenCDaemonSocketPresent(socketPath)) &&
    (await canConnectToUnixSocket(socketPath));
  if (orphanProcesses.length === 0) {
    if (socketAccepting) {
      throw new AgenCDaemonAutostartError(
        "AgenC daemon socket is active but its instance identity is unbound",
      );
    }
    return null;
  }

  // A discoverable process without a matching sidecar + authenticated RPC is
  // never adopted. Linux same-home discovery (or an explicit test seam) may
  // safely terminate it; portable adoption requires the full tuple proof.
  await Promise.all(
    orphanProcesses.map((processIdentity) =>
      terminatePidlessAgenCDaemonPid(
        processIdentity,
        params.daemonHome,
        params.host,
        params.options,
      ),
    ),
  );
  return null;
}

/**
 * Terminate daemons serving `daemonHome` that are not the tracked `keepPid`.
 *
 * A home has exactly one pid file, so a second live daemon for it is
 * untracked by construction: nothing will ever stop it, and it competes for
 * the same state and the fixed websocket port. Upgrades produced these
 * routinely, because a superseded daemon runs from a version-stamped runtime
 * directory that no longer matches the current entrypoint.
 */
async function reapSupersededAgenCDaemons(params: {
  readonly daemonHome: string;
  readonly keepPid: number | null;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
  readonly io: AgenCDaemonCliIo;
}): Promise<readonly number[]> {
  // Tests that stub orphan discovery drive that path explicitly; don't invent
  // extra kills underneath them unless they opt in.
  if (
    params.options.findSupersededDaemonPids === undefined &&
    params.options.findOrphanDaemonPids !== undefined
  ) {
    return [];
  }
  const discovered =
    params.options.findSupersededDaemonPids === undefined
      ? await findPidlessAgenCDaemonProcesses(
          params.host,
          params.daemonHome,
          "any-install",
        )
      : await captureInjectedAgenCDaemonProcesses(
          await Promise.resolve(
            params.options.findSupersededDaemonPids(params.daemonHome),
          ),
          params.host,
        );
  const superseded = discovered.filter(
    (processIdentity) =>
      params.keepPid === null || processIdentity.pid !== params.keepPid,
  );
  if (superseded.length === 0) return [];

  params.io.stderr.write(
    `agenc: stopping ${superseded.length} superseded daemon(s) for this home ` +
      `(pid ${superseded.map(({ pid }) => pid).join(", ")})\n`,
  );
  await Promise.all(
    superseded.map((processIdentity) =>
      terminatePidlessAgenCDaemonPid(
        processIdentity,
        params.daemonHome,
        params.host,
        params.options,
      ),
    ),
  );
  return superseded.map(({ pid }) => pid);
}

async function terminatePidlessAgenCDaemonPid(
  identity: AgenCDaemonProcessIdentity,
  daemonHome: string,
  host: AgenCDaemonAutostartHost,
  options: AgenCDaemonAutostartOptions,
): Promise<void> {
  if (hostPlatform(host) !== "linux") {
    throw instanceProofFailed(
      identity.pid,
      "an unbound daemon cannot be signalled on this platform",
    );
  }
  if (options.terminateOrphanDaemonPid !== undefined) {
    const signalled = await withAgenCDaemonLifecycleLock(host, async () => {
      if (
        !(await reproveLinuxAgenCDaemonProcess(
          identity,
          daemonHome,
          host,
          options,
        ))
      ) {
        return false;
      }
      await Promise.resolve(options.terminateOrphanDaemonPid?.(identity.pid));
      return true;
    });
    if (!signalled) return;
    if (
      await waitForAgenCDaemonPidExit(
        host,
        identity,
        AGENC_DAEMON_FORCE_STOP_GRACE_MS,
      )
    ) {
      return;
    }
    throw daemonSurvivedTermination(identity.pid);
  }

  await terminateAgenCDaemonPid(
    identity,
    daemonHome,
    host,
    options,
    AGENC_DAEMON_ORPHAN_STOP_TIMEOUT_MS,
  );
}

async function terminateAgenCDaemonPid(
  identity: AgenCDaemonProcessIdentity,
  daemonHome: string,
  host: AgenCDaemonAutostartHost,
  options: AgenCDaemonAutostartOptions,
  gracefulTimeoutMs: number,
): Promise<void> {
  const termSignalled = await withAgenCDaemonLifecycleLock(host, async () => {
    if (
      !(await reproveLinuxAgenCDaemonProcess(
        identity,
        daemonHome,
        host,
        options,
      ))
    ) {
      return false;
    }
    try {
      host.terminatePid(identity.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    return true;
  });
  if (!termSignalled) return;
  if (await waitForAgenCDaemonPidExit(host, identity, gracefulTimeoutMs))
    return;
  const killSignalled = await withAgenCDaemonLifecycleLock(host, async () => {
    if (
      !(await reproveLinuxAgenCDaemonProcess(
        identity,
        daemonHome,
        host,
        options,
      ))
    ) {
      return false;
    }
    try {
      host.terminatePid(identity.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    return true;
  });
  if (!killSignalled) return;
  if (
    await waitForAgenCDaemonPidExit(
      host,
      identity,
      AGENC_DAEMON_FORCE_STOP_GRACE_MS,
    )
  ) {
    return;
  }
  throw daemonSurvivedTermination(identity.pid);
}

async function reproveLinuxAgenCDaemonProcess(
  expected: AgenCDaemonProcessIdentity,
  daemonHome: string,
  host: AgenCDaemonAutostartHost,
  options: AgenCDaemonAutostartOptions,
): Promise<boolean> {
  const inspect =
    options.inspectLegacyDaemonProcess ??
    host.inspectLegacyDaemonProcess ??
    ((pid: number) =>
      inspectLinuxAgenCDaemonProcess(pid, host, daemonHome, "any-install"));
  const observed = await Promise.resolve(inspect(expected.pid));
  return observed !== null && observed.processStart === expected.processStart;
}

async function waitForAgenCDaemonPidExit(
  host: AgenCDaemonAutostartHost,
  identity: AgenCDaemonProcessIdentity,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!host.isPidRunning(identity.pid)) return true;
    await host.sleep(AGENC_DAEMON_STOP_POLL_MS);
  }
  if (!host.isPidRunning(identity.pid)) return true;
  // Off Linux this wait is used only after an authenticated, instance-bound
  // self-shutdown request. Polling (or even one final poll) through a fresh
  // PowerShell process on Windows is both unboundedly expensive and cannot
  // authorize a numeric signal anyway. A still-live numeric PID therefore
  // remains a survivor; Linux retains its cheap exact-token final check.
  if (hostPlatform(host) !== "linux") return false;
  return !(await isAgenCDaemonProcessIdentityCurrent(identity, host));
}

async function captureInjectedAgenCDaemonProcesses(
  pids: readonly number[],
  host: AgenCDaemonAutostartHost,
): Promise<readonly AgenCDaemonProcessIdentity[]> {
  const identities: AgenCDaemonProcessIdentity[] = [];
  const seen = new Set<number>();
  for (const pid of pids) {
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      pid === host.pid ||
      seen.has(pid)
    ) {
      continue;
    }
    seen.add(pid);
    const identity = await captureAgenCDaemonProcessIdentity(pid, host);
    if (identity !== null) identities.push(identity);
  }
  return identities;
}

async function captureAgenCDaemonProcessIdentity(
  pid: number,
  host: AgenCDaemonAutostartHost,
): Promise<AgenCDaemonProcessIdentity | null> {
  if (!host.isPidRunning(pid)) return null;
  const processStart = await readAgenCDaemonProcessStart(
    pid,
    host.readProcessIdentity,
  );
  if (processStart === null) {
    if (!host.isPidRunning(pid)) return null;
    throw processIdentityUnavailable(pid);
  }
  return { pid, processStart };
}

async function isAgenCDaemonProcessIdentityCurrent(
  expected: AgenCDaemonProcessIdentity,
  host: AgenCDaemonAutostartHost,
): Promise<boolean> {
  if (!host.isPidRunning(expected.pid)) return false;
  const observed = await captureAgenCDaemonProcessIdentity(expected.pid, host);
  return observed !== null && observed.processStart === expected.processStart;
}

async function proveRecordedAgenCDaemonInstance(params: {
  readonly expectedPid?: number;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
}): Promise<BoundAgenCDaemonInstance | null> {
  // Deliberate proof order: immutable sidecar snapshot, stable OS process
  // identity, authenticated RPC, sidecar reread, then OS identity recapture.
  const before = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (before === null) return null;
  if (params.expectedPid !== undefined && before.pid !== params.expectedPid) {
    throw instanceProofFailed(
      params.expectedPid,
      `sidecar records pid ${before.pid}`,
    );
  }
  const processBefore = await captureAgenCDaemonProcessIdentity(
    before.pid,
    params.host,
  );
  if (processBefore === null) return null;
  if (processBefore.processStart !== before.processStart) {
    throw instanceProofFailed(before.pid, "process start identity changed");
  }

  let rpcIdentity: AgenCDaemonInstanceIdentity;
  try {
    const requestIdentity =
      params.options.requestDaemonInstanceIdentity ??
      params.host.requestDaemonInstanceIdentity;
    rpcIdentity = await Promise.resolve(
      requestIdentity?.({
        pid: before.pid,
        pidPath: params.pidPath,
      }) ?? requestAgenCDaemonInstanceIdentity(params.host),
    );
  } catch (error) {
    throw instanceProofFailed(
      before.pid,
      `authenticated identity RPC failed: ${formatProofError(error)}`,
    );
  }
  if (!sameAgenCDaemonInstanceIdentity(before, rpcIdentity)) {
    throw instanceProofFailed(
      before.pid,
      "authenticated identity does not match the sidecar",
    );
  }

  const after = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (after === null || !sameAgenCDaemonInstanceIdentity(before, after)) {
    throw instanceProofFailed(before.pid, "sidecar changed during proof");
  }
  const processAfter =
    hostPlatform(params.host) === "linux"
      ? await captureAgenCDaemonProcessIdentity(before.pid, params.host)
      : processBefore;
  if (
    processAfter === null ||
    processAfter.processStart !== processBefore.processStart ||
    processAfter.processStart !== after.processStart
  ) {
    throw instanceProofFailed(
      before.pid,
      "process identity changed during proof",
    );
  }
  return { identity: after, process: processAfter };
}

async function revalidateRecordedAgenCDaemonInstance(params: {
  readonly expected: BoundAgenCDaemonInstance;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
}): Promise<BoundAgenCDaemonInstance> {
  if (hostPlatform(params.host) === "linux") {
    const current = await proveRecordedAgenCDaemonInstance({
      expectedPid: params.expected.identity.pid,
      pidPath: params.pidPath,
      runtimeInfoPath: params.runtimeInfoPath,
      host: params.host,
      options: params.options,
    });
    if (
      current === null ||
      !sameAgenCDaemonInstanceIdentity(
        current.identity,
        params.expected.identity,
      )
    ) {
      throw instanceProofFailed(
        params.expected.identity.pid,
        "identity changed before authenticated shutdown",
      );
    }
    return current;
  }

  // Off Linux, the initial full proof already captured the stable OS token.
  // Revalidate the sidecar -> authenticated RPC -> sidecar binding without a
  // second expensive creation-time query. A process replacement before or
  // after the RPC cannot accept the subsequent instanceId-bound shutdown, and
  // this path never authorizes a numeric signal.
  const before = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (
    before === null ||
    !sameAgenCDaemonInstanceIdentity(before, params.expected.identity) ||
    !params.host.isPidRunning(params.expected.identity.pid)
  ) {
    throw instanceProofFailed(
      params.expected.identity.pid,
      "identity changed before authenticated shutdown",
    );
  }
  let observed: AgenCDaemonInstanceIdentity;
  try {
    const requestIdentity =
      params.options.requestDaemonInstanceIdentity ??
      params.host.requestDaemonInstanceIdentity;
    observed = await Promise.resolve(
      requestIdentity?.({
        pid: before.pid,
        pidPath: params.pidPath,
      }) ?? requestAgenCDaemonInstanceIdentity(params.host),
    );
  } catch (error) {
    throw instanceProofFailed(
      before.pid,
      `authenticated identity RPC failed: ${formatProofError(error)}`,
    );
  }
  const after = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (
    !sameAgenCDaemonInstanceIdentity(observed, params.expected.identity) ||
    after === null ||
    !sameAgenCDaemonInstanceIdentity(after, params.expected.identity) ||
    !params.host.isPidRunning(params.expected.identity.pid)
  ) {
    throw instanceProofFailed(
      params.expected.identity.pid,
      "identity changed before authenticated shutdown",
    );
  }
  return params.expected;
}

async function terminateRecordedAgenCDaemonInstance(params: {
  readonly expected: BoundAgenCDaemonInstance;
  readonly daemonHome: string;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
  readonly gracefulTimeoutMs: number;
}): Promise<void> {
  await revalidateRecordedAgenCDaemonInstance({
    expected: params.expected,
    pidPath: params.pidPath,
    runtimeInfoPath: params.runtimeInfoPath,
    host: params.host,
    options: params.options,
  });
  let shutdownError: unknown;
  try {
    const requestShutdown =
      params.options.requestDaemonShutdown ?? params.host.requestDaemonShutdown;
    if (requestShutdown !== undefined) {
      await Promise.resolve(requestShutdown(params.expected.identity));
    } else {
      await requestAgenCDaemonShutdown(params.host, params.expected.identity);
    }
  } catch (error) {
    shutdownError = error;
  }
  if (
    shutdownError === undefined &&
    (await waitForAgenCDaemonPidExit(
      params.host,
      params.expected.process,
      params.gracefulTimeoutMs,
    ))
  ) {
    return;
  }
  if (shutdownError !== undefined && hostPlatform(params.host) !== "linux") {
    throw instanceProofFailed(
      params.expected.identity.pid,
      `authenticated self-shutdown failed: ${formatProofError(shutdownError)}`,
    );
  }

  // Numeric signals are a Linux-only fallback. Darwin's native lstart token
  // is second-resolution, and Windows signalling by PID has the same handle
  // rebinding problem, so neither can safely close the post-proof TOCTOU.
  if (hostPlatform(params.host) !== "linux") {
    throw daemonSurvivedTermination(params.expected.identity.pid);
  }

  await withAgenCDaemonLifecycleLock(params.host, async () => {
    await rebindLinuxAgenCDaemonInstanceForSignal({
      expected: params.expected,
      daemonHome: params.daemonHome,
      runtimeInfoPath: params.runtimeInfoPath,
      host: params.host,
      options: params.options,
      signal: "SIGTERM",
    });
    params.host.terminatePid(params.expected.identity.pid, "SIGTERM");
  });
  if (
    await waitForAgenCDaemonPidExit(
      params.host,
      params.expected.process,
      params.gracefulTimeoutMs,
    )
  ) {
    return;
  }

  // Re-read Linux's same-home argv/environment and boot-id + starttime token
  // immediately before the numeric force-stop fallback.
  await withAgenCDaemonLifecycleLock(params.host, async () => {
    await rebindLinuxAgenCDaemonInstanceForSignal({
      expected: params.expected,
      daemonHome: params.daemonHome,
      runtimeInfoPath: params.runtimeInfoPath,
      host: params.host,
      options: params.options,
      signal: "SIGKILL",
    });
    params.host.terminatePid(params.expected.identity.pid, "SIGKILL");
  });
  if (
    await waitForAgenCDaemonPidExit(
      params.host,
      params.expected.process,
      AGENC_DAEMON_FORCE_STOP_GRACE_MS,
    )
  ) {
    return;
  }
  throw daemonSurvivedTermination(params.expected.identity.pid);
}

async function rebindLinuxAgenCDaemonInstanceForSignal(params: {
  readonly expected: BoundAgenCDaemonInstance;
  readonly daemonHome: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
  readonly signal: "SIGKILL" | "SIGTERM";
}): Promise<void> {
  const sidecarBefore = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (
    sidecarBefore === null ||
    !sameAgenCDaemonInstanceIdentity(sidecarBefore, params.expected.identity)
  ) {
    throw instanceProofFailed(
      params.expected.identity.pid,
      `identity sidecar changed before Linux ${params.signal} fallback`,
    );
  }
  const inspect =
    params.options.inspectLegacyDaemonProcess ??
    params.host.inspectLegacyDaemonProcess ??
    ((pid: number) =>
      inspectLinuxAgenCDaemonProcess(
        pid,
        params.host,
        params.daemonHome,
        "any-install",
      ));
  const process = await Promise.resolve(inspect(params.expected.identity.pid));
  const sidecarAfter = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (
    process === null ||
    process.processStart !== params.expected.process.processStart ||
    sidecarAfter === null ||
    !sameAgenCDaemonInstanceIdentity(sidecarAfter, params.expected.identity)
  ) {
    throw instanceProofFailed(
      params.expected.identity.pid,
      `identity could not be rebound before Linux ${params.signal} fallback`,
    );
  }
}

async function cleanupFailedAgenCDaemonReplacement(params: {
  readonly identity: BoundAgenCDaemonInstance;
  readonly daemonHome: string;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
}): Promise<void> {
  await terminateRecordedAgenCDaemonInstance({
    expected: params.identity,
    daemonHome: params.daemonHome,
    pidPath: params.pidPath,
    runtimeInfoPath: params.runtimeInfoPath,
    host: params.host,
    options: params.options,
    gracefulTimeoutMs: AGENC_DAEMON_ORPHAN_STOP_TIMEOUT_MS,
  });

  await removeVerifiedAgenCDaemonMetadata({
    expected: params.identity,
    pidPath: params.pidPath,
    runtimeInfoPath: params.runtimeInfoPath,
    host: params.host,
    options: params.options,
  });
}

async function failStartedAgenCDaemonReplacement(params: {
  readonly error: unknown;
  readonly spawnedPid: number | null;
  readonly spawnedProcess: AgenCDaemonProcessIdentity | null;
  readonly daemonHome: string;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
}): Promise<never> {
  try {
    await cleanupUnverifiedStartedAgenCDaemon(params);
  } catch (cleanupError) {
    throw new AggregateError(
      [params.error, cleanupError],
      `AgenC daemon startup failed and replacement cleanup could not be verified${
        params.spawnedPid === null ? "" : ` (pid ${params.spawnedPid})`
      }`,
    );
  }
  throw params.error;
}

async function cleanupUnverifiedStartedAgenCDaemon(params: {
  readonly spawnedPid: number | null;
  readonly spawnedProcess: AgenCDaemonProcessIdentity | null;
  readonly daemonHome: string;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
}): Promise<void> {
  if (params.spawnedPid === null) return;
  const sidecarSnapshot = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (params.host.cancelSpawnedDaemon !== undefined) {
    await Promise.resolve(params.host.cancelSpawnedDaemon(params.spawnedPid));
    const exited =
      params.spawnedProcess === null
        ? await waitForNumericPidExit(
            params.host,
            params.spawnedPid,
            AGENC_DAEMON_ORPHAN_STOP_TIMEOUT_MS,
          )
        : await waitForAgenCDaemonPidExit(
            params.host,
            params.spawnedProcess,
            AGENC_DAEMON_ORPHAN_STOP_TIMEOUT_MS,
          );
    if (!exited) {
      throw instanceProofFailed(
        params.spawnedPid,
        "spawned replacement acknowledged cleanup but remained alive",
      );
    }
    await removeUnverifiedReplacementMetadata(params, sidecarSnapshot);
    return;
  }
  if (params.spawnedProcess === null) {
    await removeUnverifiedReplacementMetadata(params, sidecarSnapshot);
    return;
  }

  try {
    const bound = await proveRecordedAgenCDaemonInstance({
      expectedPid: params.spawnedPid,
      pidPath: params.pidPath,
      runtimeInfoPath: params.runtimeInfoPath,
      host: params.host,
      options: params.options,
    });
    if (bound !== null) {
      await cleanupFailedAgenCDaemonReplacement({
        identity: bound,
        daemonHome: params.daemonHome,
        pidPath: params.pidPath,
        runtimeInfoPath: params.runtimeInfoPath,
        host: params.host,
        options: params.options,
      });
      return;
    }
  } catch {
    // A raced socket may make authenticated proof impossible. Linux can still
    // safely clean the child we just spawned using its captured start token;
    // other platforms deliberately fail closed rather than signal by PID.
  }

  if (!params.host.isPidRunning(params.spawnedPid)) {
    await removeUnverifiedReplacementMetadata(params, sidecarSnapshot);
    return;
  }
  if (hostPlatform(params.host) !== "linux") {
    throw instanceProofFailed(
      params.spawnedPid,
      "spawned replacement could not be rebound for portable cleanup",
    );
  }
  await terminateAgenCDaemonPid(
    params.spawnedProcess,
    params.daemonHome,
    params.host,
    params.options,
    AGENC_DAEMON_ORPHAN_STOP_TIMEOUT_MS,
  );
  await removeUnverifiedReplacementMetadata(params, sidecarSnapshot);
}

async function removeUnverifiedReplacementMetadata(
  params: {
    readonly spawnedPid: number | null;
    readonly spawnedProcess: AgenCDaemonProcessIdentity | null;
    readonly pidPath: string;
    readonly runtimeInfoPath: string;
    readonly host: AgenCDaemonAutostartHost;
  },
  expectedSidecar: AgenCDaemonInstanceIdentity | null,
): Promise<void> {
  if (params.spawnedPid === null) return;
  const spawnedPid = params.spawnedPid;
  await withAgenCDaemonLifecycleLock(params.host, async () => {
    // A same-numbered replacement published after this child exited belongs
    // to another generation. Preserve both of its metadata files.
    if (
      params.host.isPidRunning(spawnedPid) ||
      (await readAgenCDaemonPid(params.pidPath)) !== spawnedPid
    ) {
      return;
    }
    const recordedBefore = daemonInstanceIdentityFromRuntimeInfo(
      readDaemonRuntimeInfo(params.runtimeInfoPath),
    );
    if (
      recordedBefore !== null &&
      (expectedSidecar === null ||
        !sameAgenCDaemonInstanceIdentity(recordedBefore, expectedSidecar) ||
        recordedBefore.pid !== spawnedPid ||
        (params.spawnedProcess !== null &&
          recordedBefore.processStart !== params.spawnedProcess.processStart))
    ) {
      return;
    }
    if (
      params.host.isPidRunning(spawnedPid) ||
      (await readAgenCDaemonPid(params.pidPath)) !== spawnedPid
    ) {
      return;
    }
    const recordedAfter = daemonInstanceIdentityFromRuntimeInfo(
      readDaemonRuntimeInfo(params.runtimeInfoPath),
    );
    if (
      (recordedBefore === null) !== (recordedAfter === null) ||
      (recordedBefore !== null &&
        recordedAfter !== null &&
        !sameAgenCDaemonInstanceIdentity(recordedBefore, recordedAfter))
    ) {
      return;
    }
    await removeAgenCDaemonPid(params.pidPath, spawnedPid);
    if (recordedAfter !== null) {
      removeDaemonRuntimeInfo(params.runtimeInfoPath, recordedAfter.instanceId);
    }
  });
}

async function waitForNumericPidExit(
  host: AgenCDaemonAutostartHost,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!host.isPidRunning(pid)) return true;
    await host.sleep(AGENC_DAEMON_STOP_POLL_MS);
  }
  return !host.isPidRunning(pid);
}

async function removeVerifiedAgenCDaemonMetadata(params: {
  readonly expected: BoundAgenCDaemonInstance;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
  readonly options: AgenCDaemonAutostartOptions;
}): Promise<void> {
  await withAgenCDaemonLifecycleLock(params.host, async () => {
    if (
      (await readAgenCDaemonPid(params.pidPath)) !==
      params.expected.identity.pid
    ) {
      return;
    }
    const recorded = daemonInstanceIdentityFromRuntimeInfo(
      readDaemonRuntimeInfo(params.runtimeInfoPath),
    );
    if (
      recorded !== null &&
      !sameAgenCDaemonInstanceIdentity(params.expected.identity, recorded)
    ) {
      return;
    }
    // A live numeric PID is either the old daemon surviving shutdown or a
    // same-numbered replacement. Preserve both metadata files in either case;
    // removal is authorized only after the PID is absent while this lifecycle
    // transaction excludes a concurrent provisional publisher.
    if (params.host.isPidRunning(params.expected.identity.pid)) {
      return;
    }
    await Promise.resolve(
      params.options.afterVerifiedExitBeforeMetadataRemoval?.(),
    );
    if (
      params.host.isPidRunning(params.expected.identity.pid) ||
      (await readAgenCDaemonPid(params.pidPath)) !==
        params.expected.identity.pid
    ) {
      return;
    }
    const sidecarAfter = daemonInstanceIdentityFromRuntimeInfo(
      readDaemonRuntimeInfo(params.runtimeInfoPath),
    );
    if (
      sidecarAfter !== null &&
      !sameAgenCDaemonInstanceIdentity(params.expected.identity, sidecarAfter)
    ) {
      return;
    }
    await removeAgenCDaemonPid(params.pidPath, params.expected.identity.pid);
    removeDaemonRuntimeInfo(
      params.runtimeInfoPath,
      params.expected.identity.instanceId,
    );
  });
}

async function removeExitedAgenCDaemonMetadata(params: {
  readonly pid: number;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
  readonly host: AgenCDaemonAutostartHost;
}): Promise<void> {
  const sidecarSnapshot = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  await withAgenCDaemonLifecycleLock(params.host, async () => {
    if (
      params.host.isPidRunning(params.pid) ||
      (await readAgenCDaemonPid(params.pidPath)) !== params.pid
    ) {
      return;
    }
    const sidecarNow = daemonInstanceIdentityFromRuntimeInfo(
      readDaemonRuntimeInfo(params.runtimeInfoPath),
    );
    if (
      (sidecarSnapshot === null) !== (sidecarNow === null) ||
      (sidecarSnapshot !== null &&
        sidecarNow !== null &&
        !sameAgenCDaemonInstanceIdentity(sidecarSnapshot, sidecarNow)) ||
      (sidecarNow !== null && sidecarNow.pid !== params.pid)
    ) {
      return;
    }
    await removeAgenCDaemonPid(params.pidPath, params.pid);
    if (sidecarNow !== null) {
      removeDaemonRuntimeInfo(params.runtimeInfoPath, sidecarNow.instanceId);
    }
  });
}

function instanceProofFailed(
  pid: number,
  reason: string,
): AgenCDaemonAutostartError {
  return new AgenCDaemonAutostartError(
    `AgenC daemon instance identity could not be verified (pid ${pid}): ${reason}`,
  );
}

function formatProofError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostPlatform(host: AgenCDaemonAutostartHost): NodeJS.Platform {
  return host.platform ?? process.platform;
}

function processIdentityUnavailable(pid: number): AgenCDaemonAutostartError {
  return new AgenCDaemonAutostartError(
    `AgenC daemon process identity could not be verified (pid ${pid})`,
  );
}

function daemonSurvivedTermination(pid: number): AgenCDaemonAutostartError {
  return new AgenCDaemonAutostartError(
    `AgenC daemon survived forced termination (pid ${pid})`,
  );
}

async function isAgenCDaemonSocketPresent(
  socketPath: string,
): Promise<boolean> {
  try {
    return (await lstat(socketPath)).isSocket();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Find Linux daemon processes serving `daemonHome` that the pid file does not
 * track. No equally strong arbitrary-process ownership proof exists in this
 * module for Darwin or Windows, so callers deliberately receive no candidates
 * there rather than pretending the same-home guarantee is portable.
 *
 * `entrypointMatch: "exact"` restricts the result to daemons running this very
 * runtime build — the only ones safe to ADOPT, since adopting a daemon from
 * another build reintroduces the missing-chunk hang that runtime-info skew
 * detection exists to prevent.
 *
 * `entrypointMatch: "any-install"` also returns daemons from other installs or
 * versions of agenc. Those are only ever TERMINATED: a home has exactly one
 * pid file, so a second daemon serving it is untracked by construction, and
 * before this it survived every upgrade and accumulated indefinitely.
 */
async function findPidlessAgenCDaemonProcesses(
  host: AgenCDaemonAutostartHost,
  daemonHome: string,
  entrypointMatch: "exact" | "any-install" = "exact",
): Promise<readonly AgenCDaemonProcessIdentity[]> {
  try {
    return await findLinuxAgenCDaemonProcesses(
      host,
      daemonHome,
      entrypointMatch,
    );
  } catch (error) {
    throw new AgenCDaemonAutostartError(
      `AgenC daemon discovery could not inspect the Linux process table: ${String(error)}`,
    );
  }
}

type DaemonReadyWaitOutcome = "ready" | "exited" | "timeout";

async function waitForAgenCDaemonReady(
  target: AgenCDaemonConnectionTarget,
  host: AgenCDaemonCliHost,
  options: AgenCDaemonAutostartOptions,
): Promise<DaemonReadyWaitOutcome> {
  const timeoutMs =
    options.waitTimeoutMs ?? resolveAgenCDaemonReadyTimeoutMs(host.env);
  const pollMs = options.pollMs ?? 25;
  const startedAt = Date.now();
  const isReady =
    options.isReady ??
    ((readyTarget: AgenCDaemonConnectionTarget) =>
      isAgenCDaemonPidAndCookieReady(readyTarget, host));

  while (Date.now() - startedAt < timeoutMs) {
    if (await Promise.resolve(isReady(target))) return "ready";
    // A dead daemon can never become ready — bail out with the accurate
    // diagnosis instead of burning the whole timeout on a foregone result.
    // (Checked after isReady so a custom isReady that ignores the pid still
    // gets one evaluation per poll.)
    if (!host.isPidRunning(target.pid)) return "exited";
    await host.sleep(pollMs);
  }
  if (await Promise.resolve(isReady(target))) return "ready";
  return host.isPidRunning(target.pid) ? "timeout" : "exited";
}

async function isAgenCDaemonPidAndCookieReady(
  target: AgenCDaemonConnectionTarget,
  host: AgenCDaemonCliHost,
): Promise<boolean> {
  if (!host.isPidRunning(target.pid)) return false;
  const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  try {
    if ((await readFile(cookiePath, "utf8")).trim().length === 0) {
      return false;
    }
    if (isAgenCWindowsNamedPipePath(socketPath)) {
      return canConnectToUnixSocket(socketPath);
    }
    return (await lstat(socketPath)).isSocket();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

function silentIo(): AgenCDaemonCliIo {
  const sink = {
    write: () => true,
  } as Pick<NodeJS.WriteStream, "write">;
  return {
    stdout: sink,
    stderr: sink,
  };
}
