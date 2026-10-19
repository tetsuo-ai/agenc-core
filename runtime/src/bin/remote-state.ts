// Local pairing state only. No connector, relay, credential read or network import.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readDaemonRuntimeInfo, resolveAgenCDaemonRuntimeInfoPath } from "../app-server/daemon-runtime-info.js";
import type { RemoteAuthSessionReadContext } from "../auth/session-state.js";
import type { EnvSnapshot } from "../config/env.js";
import { captureSecureStorageIngress } from "../utils/secureStorage/home.js";
const DEFAULT_BACKEND = "https://id.agenc.ag";
export interface PairFile {
  pairingId: string;
  hostSecret: string;
  machineName: string;
  relayUrl: string;
  backendUrl: string;
  createdAt: string;
}

export type RemoteCliRuntimeContext = RemoteAuthSessionReadContext;

/** Capture one-shot CLI environment/home authority before asynchronous work. */
export function captureRemoteCliRuntimeContext(
  environment: EnvSnapshot,
): RemoteCliRuntimeContext {
  const ingress = captureSecureStorageIngress(environment);
  return Object.freeze({
    home: ingress.home,
    environment: ingress.environment,
  });
}
export function remoteDir(context: RemoteCliRuntimeContext): string {
  return join(context.home.path, "remote");
}
export function pairPath(context: RemoteCliRuntimeContext): string {
  return join(remoteDir(context), "pair.json");
}
export const activeLegacyBridges = new Map<string, () => void>();
export function stopMarker(context: RemoteCliRuntimeContext): string {
  try { return readFileSync(join(remoteDir(context), "stopped"), "utf8"); } catch { return ""; }
}
export function stopLegacyRemote(context: RemoteCliRuntimeContext): void {
  mkdirSync(remoteDir(context), { recursive: true, mode: 0o700 });
  writeFileSync(join(remoteDir(context), "stopped"), randomUUID(), { mode: 0o600 });
  activeLegacyBridges.get(context.home.path)?.();
  rmSync(pairPath(context), { force: true });
}
export function cookiePath(context: RemoteCliRuntimeContext): string {
  return join(context.home.path, "daemon.cookie");
}
export function backendUrl(context: RemoteCliRuntimeContext): string {
  const env = context.environment.AGENC_BACKEND_URL;
  return env && env.trim() ? env.trim().replace(/\/$/, "") : DEFAULT_BACKEND;
}
export function daemonUrl(context: RemoteCliRuntimeContext): string {
  const env = context.environment.AGENC_DAEMON_URL;
  if (env && env.trim()) return env.trim();
  // The running daemon records the port it actually bound, which is not the
  // default when that port was already taken and the listener fell back.
  // Falling back to the fixed default keeps older daemons reachable.
  const recorded = readDaemonRuntimeInfo(
    resolveAgenCDaemonRuntimeInfoPath(context.home.path),
  )?.webSocketUrl;
  return recorded !== undefined && recorded.length > 0
    ? recorded
    : "ws://127.0.0.1:7766";
}

export function readPairFile(context: RemoteCliRuntimeContext): PairFile | null {
  try {
    const raw = readFileSync(pairPath(context), "utf8");
    const obj = JSON.parse(raw) as Partial<PairFile>;
    if (obj.pairingId && obj.hostSecret && obj.relayUrl) return obj as PairFile;
  } catch {
    /* absent or malformed */
  }
  return null;
}
export function writePairFile(context: RemoteCliRuntimeContext, p: PairFile): void {
  mkdirSync(remoteDir(context), { recursive: true, mode: 0o700 });
  writeFileSync(pairPath(context), JSON.stringify(p, null, 2), { mode: 0o600 });
  try {
    chmodSync(pairPath(context), 0o600);
  } catch {
    /* best effort */
  }
}
export function readCookie(context: RemoteCliRuntimeContext): string {
  try {
    return readFileSync(cookiePath(context), "utf8").trim();
  } catch {
    return "";
  }
}

