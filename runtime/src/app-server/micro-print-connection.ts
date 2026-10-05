/** Resident-only discovery and both canonical proofs on one raw generation. */
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { readBoundedRegularFile } from "../utils/bounded-regular-file.js";
import { isRecord } from "../utils/record.js";
import { resolveAgenCDaemonHome, resolveAgenCDaemonSocketPath, resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath, readAgenCDaemonPid } from "./daemon-discovery.js";
import { withAgenCDaemonLifecycleLock } from "./daemon-lifecycle-lock.js";
import { captureResidentProcessIdentity, proveRecordedResidentInstance } from "./daemon-resident-proof.js";
import { isAgenCDaemonInstanceIdentity, sameAgenCDaemonInstanceIdentity, type AgenCDaemonInstanceIdentity } from "./daemon-instance-identity.js";
import { readDistVersion, resolveAgenCDaemonRuntimeInfoPath } from "./daemon-runtime-info.js";
import { resolveAgenCDaemonRequestTimeoutMs } from "./daemon-request-policy.js";
import { MicroPrintTransport, microTransportError } from "./micro-print-transport.js";

export const MICRO_PRINT_PROTOCOL_VERSION = "1.30.0";
interface Endpoint {
  readonly socket: string; readonly cookie: string; readonly cookieContents: string;
  readonly socketDev: bigint; readonly socketIno: bigint;
  readonly cookieDev: bigint; readonly cookieIno: bigint;
}
async function readEndpoint(env: NodeJS.ProcessEnv, userHome: string): Promise<Endpoint> {
  const socket = resolveAgenCDaemonSocketPath(env, userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(env, userHome);
  const before = await lstat(cookiePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw microTransportError();
  const cookieContents = await readBoundedRegularFile(cookiePath, 4096);
  const after = await lstat(cookiePath, { bigint: true });
  const socketStat = await lstat(socket, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !socketStat.isSocket()) throw microTransportError();
  const cookie = cookieContents.trim();
  if (cookie.length === 0) throw microTransportError();
  return { socket, cookie, cookieContents, socketDev: socketStat.dev, socketIno: socketStat.ino,
    cookieDev: after.dev, cookieIno: after.ino };
}
function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.socket === b.socket && a.cookieContents === b.cookieContents && a.socketDev === b.socketDev &&
    a.socketIno === b.socketIno && a.cookieDev === b.cookieDev && a.cookieIno === b.cookieIno;
}
export interface ResidentPrintConnection {
  readonly transport: MicroPrintTransport;
  readonly timeoutMs: number;
  /** No reconnect: the initialized connection remains pinned through admission. */
  proveAgain(): Promise<void>;
  assertLive(): void;
}
interface ProofHooks {
  readonly userHome?: string;
  readonly publicationBarrier?: () => Promise<void>;
  readonly isPidRunning?: (pid: number) => boolean;
  readonly readProcessIdentity?: (pid: number) => Promise<string | null> | string | null;
}
export async function openResidentPrintConnection(
  env: NodeJS.ProcessEnv, runtimeRoot: string,
  /** @internal canonical proof race fixtures only. */ hooks: ProofHooks = {},
): Promise<ResidentPrintConnection | null> {
  if (process.platform !== "linux") return null;
  let transport: MicroPrintTransport | undefined;
  try {
    const userHome = hooks.userHome ?? homedir();
    const host = { env, userHome };
    const infoPath = resolveAgenCDaemonRuntimeInfoPath(resolveAgenCDaemonHome(env, userHome));
    const pidPath = resolveAgenCDaemonPidPath(env, userHome);
    // A missing publication selects the canonical path without creating a HOME.
    if (await readAgenCDaemonPid(pidPath) === null) return null;
    const build = readDistVersion(runtimeRoot);
    if (build === null) return null;
    const timeoutMs = resolveAgenCDaemonRequestTimeoutMs(env, 2000);
    const barrier = hooks.publicationBarrier ?? (() => withAgenCDaemonLifecycleLock(host, async () => {}));
    const processHost = {
      isPidRunning: hooks.isPidRunning ?? ((pid: number): boolean => {
        try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
      }),
      readProcessIdentity: hooks.readProcessIdentity,
    };
    let endpoint: Endpoint | undefined;
    let identity: AgenCDaemonInstanceIdentity | undefined;
    const assertLive = (): void => { if (transport === undefined) throw microTransportError(); transport.assertLive(); };
    const prove = async (initial: boolean): Promise<void> => {
      await barrier();
      const pid = await readAgenCDaemonPid(pidPath);
      if (pid === null) throw microTransportError();
      const result = await proveRecordedResidentInstance({ expectedPid: pid, runtimeInfoPath: infoPath, platform: process.platform,
        captureProcess: target => captureResidentProcessIdentity(target, processHost, microTransportError),
        proofError: microTransportError,
        requestIdentity: async () => {
          const before = await readEndpoint(env, userHome);
          if (initial) {
            endpoint = before;
            transport = await MicroPrintTransport.connect(before.socket, timeoutMs);
            const response = await transport.request("initialize", {
              protocolVersion: MICRO_PRINT_PROTOCOL_VERSION, protocol: { version: MICRO_PRINT_PROTOCOL_VERSION },
              clientName: "agenc-print-micro", authCookie: before.cookie, capabilities: { "print.invoke.v1": true },
            }, timeoutMs);
            if (!isRecord(response) || !isRecord(response.capabilities) || response.capabilities["print.invoke.v1"] !== true ||
                !isAgenCDaemonInstanceIdentity(response.daemonIdentity) || response.protocolVersion !== MICRO_PRINT_PROTOCOL_VERSION) throw microTransportError();
            const value = response.daemonIdentity;
            identity = Object.freeze({ pid: value.pid, processStart: value.processStart, instanceId: value.instanceId,
              runtimeVersion: value.runtimeVersion, commit: value.commit, buildTime: value.buildTime });
          } else {
            assertLive();
            if (endpoint === undefined || !sameEndpoint(endpoint, before)) throw microTransportError();
            const response = await transport!.request("health.ping", {}, timeoutMs);
            if (!isRecord(response) || response.ok !== true || typeof response.now !== "string" || !response.now) throw microTransportError();
          }
          const after = await readEndpoint(env, userHome);
          assertLive();
          if (endpoint === undefined || !sameEndpoint(endpoint, after) || identity === undefined) throw microTransportError();
          return identity;
        },
      });
      assertLive();
      if (result === null || identity === undefined || !sameAgenCDaemonInstanceIdentity(result.identity, identity) ||
          result.identity.runtimeVersion !== build.runtimeVersion || result.identity.commit !== build.commit || result.identity.buildTime !== build.buildTime) throw microTransportError();
    };
    await prove(true);
    return { transport: transport!, timeoutMs, assertLive, proveAgain: () => prove(false) };
  } catch {
    transport?.close();
    // In particular, an older minor must reach canonical control1.0 recovery.
    return null;
  }
}
