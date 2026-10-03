/** Isolated exploratory coordinator. Uses the canonical mutation and proof. */
import {
  cancelDirectSpawnFailure, createNodeDaemonCliHost, resolveAgenCDaemonPidPath,
  startAgenCDaemon, type AgenCDaemonCliHost, type AgenCDaemonCliIo,
} from "./daemon-control.js";
import { ensureAgenCDaemonAutostart, resolveAgenCDaemonAutostartEnabled } from "./daemon-autostart.js";

export interface ProvisionalDaemonStart {
  cancel(): Promise<void>;
  finish(io: AgenCDaemonCliIo, onReadinessWaitStarted?: () => void): Promise<void>;
}

export async function tryPrepareProvisionalDaemon(
  host: AgenCDaemonCliHost = createNodeDaemonCliHost(),
  signal: AbortSignal = new AbortController().signal,
): Promise<ProvisionalDaemonStart | null> {
  // Speculative diagnostics cannot outrank the canonical trust/config error.
  try {
    if (!await resolveAgenCDaemonAutostartEnabled(host.env, host.userHome, () => {})) return null;
  } catch { return null; }
  if (signal.aborted) return null;
  let pid: number | null = null;
  const startingHost: AgenCDaemonCliHost = {
    ...host,
    spawnDetachedDaemon: (env) => {
      const child = host.spawnDetachedDaemon(env);
      pid = child;
      return child;
    },
  };
  const quiet = { write: () => true };
  try {
    const code = await startAgenCDaemon(startingHost, { stdout: quiet, stderr: quiet }, {
      provisionalStart: { signal }, deferDaemonReadyWaitToCaller: true,
    });
    if (code !== 0 || pid === null) return null;
  } catch (error) {
    // Canonical start settles and cleans any spawned child before rejecting.
    // A cleanup failure remains visible; never hide an unverified child.
    if (pid !== null && error instanceof AggregateError) throw error;
    return null;
  }
  const childPid: number = pid;
  let settled = false;
  const cancel = async (): Promise<void> => {
    if (settled) return;
    await cancelDirectSpawnFailure(host, childPid, resolveAgenCDaemonPidPath(host.env, host.userHome));
    settled = true;
  };
  return {
    cancel,
    finish: async (io, onReadinessWaitStarted) => {
      if (settled) throw new Error("provisional daemon already settled");
      const admitted = await host.admitProvisionalDaemon?.(childPid);
      if (admitted !== true) {
        // A lease expiry is an internal failed speculation. Join it before
        // the normal, post-trust autostart transaction can take ownership.
        await cancel();
        await ensureAgenCDaemonAutostart({ host, io, onReadinessWaitStarted });
        return;
      }
      io.stderr.write("agenc: starting daemon (no daemon pid recorded)\n");
      // Full canonical readiness, instance/authentication/build proof owns
      // both success and exact-child cleanup after this handoff.
      settled = true;
      await ensureAgenCDaemonAutostart({ host, io, onReadinessWaitStarted, provisionalOwnedPid: childPid });
    },
  };
}
