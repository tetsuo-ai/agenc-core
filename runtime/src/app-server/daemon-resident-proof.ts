/** The canonical sidecar/process/RPC/sidecar/process proof, shared by clients. */
import { daemonInstanceIdentityFromRuntimeInfo, readDaemonRuntimeInfo } from "./daemon-runtime-info.js";
import { readAgenCDaemonProcessStart, sameAgenCDaemonInstanceIdentity,
  type AgenCDaemonInstanceIdentity, type AgenCDaemonProcessIdentity } from "./daemon-instance-identity.js";

export interface BoundAgenCDaemonInstance {
  readonly identity: AgenCDaemonInstanceIdentity;
  readonly process: AgenCDaemonProcessIdentity;
}
export async function captureResidentProcessIdentity(
  pid: number,
  host: { isPidRunning(pid: number): boolean; readonly readProcessIdentity?: (pid: number) => Promise<string | null> | string | null },
  unavailable: (pid: number) => Error,
): Promise<AgenCDaemonProcessIdentity | null> {
  if (!host.isPidRunning(pid)) return null;
  const processStart = await readAgenCDaemonProcessStart(pid, host.readProcessIdentity);
  if (processStart === null) {
    if (!host.isPidRunning(pid)) return null;
    throw unavailable(pid);
  }
  return { pid, processStart };
}

export async function proveRecordedResidentInstance(params: {
  readonly expectedPid?: number;
  readonly runtimeInfoPath: string;
  readonly platform: NodeJS.Platform;
  readonly captureProcess: (pid: number) => Promise<AgenCDaemonProcessIdentity | null>;
  readonly requestIdentity: (pid: number) => Promise<AgenCDaemonInstanceIdentity>;
  readonly proofError: (pid: number, reason: string) => Error;
}): Promise<BoundAgenCDaemonInstance | null> {
  // Deliberate proof order: immutable sidecar snapshot, stable OS process
  // identity, authenticated RPC, sidecar reread, then OS identity recapture.
  const before = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (before === null) return null;
  if (params.expectedPid !== undefined && before.pid !== params.expectedPid) {
    throw params.proofError(
      params.expectedPid,
      `sidecar records pid ${before.pid}`,
    );
  }
  const processBefore = await params.captureProcess(before.pid);
  if (processBefore === null) return null;
  if (processBefore.processStart !== before.processStart) {
    throw params.proofError(before.pid, "process start identity changed");
  }

  let rpcIdentity: AgenCDaemonInstanceIdentity;
  try {
    rpcIdentity = await params.requestIdentity(before.pid);
  } catch (error) {
    throw params.proofError(
      before.pid,
      `authenticated identity RPC failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!sameAgenCDaemonInstanceIdentity(before, rpcIdentity)) {
    throw params.proofError(
      before.pid,
      "authenticated identity does not match the sidecar",
    );
  }

  const after = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  if (after === null || !sameAgenCDaemonInstanceIdentity(before, after)) {
    throw params.proofError(before.pid, "sidecar changed during proof");
  }
  const processAfter =
    params.platform === "linux"
      ? await params.captureProcess(before.pid)
      : processBefore;
  if (
    processAfter === null ||
    processAfter.processStart !== processBefore.processStart ||
    processAfter.processStart !== after.processStart
  ) {
    throw params.proofError(
      before.pid,
      "process identity changed during proof",
    );
  }
  return { identity: after, process: processAfter };
}
