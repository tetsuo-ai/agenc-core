import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgenCDaemonHome } from "./daemon-discovery.js";
import { readAgenCDaemonHeartbeat, resolveAgenCDaemonHeartbeatPath } from "./daemon-heartbeat.js";

/** Last recorded facts, not a claim that a disconnected socket proves death. */
export function readDaemonDisconnectEvidence(env: NodeJS.ProcessEnv = process.env) {
  const home = resolveAgenCDaemonHome(env, homedir());
  const heartbeat = readAgenCDaemonHeartbeat(resolveAgenCDaemonHeartbeatPath(home));
  let exit: { pid: number; at: string; code: number | null; signal: string | null } | undefined;
  try {
    const value = JSON.parse(readFileSync(join(home, "daemon-exit.json"), "utf8"));
    if (Number.isSafeInteger(value.pid) && value.pid > 0 &&
        typeof value.at === "string" && Number.isFinite(Date.parse(value.at)) &&
        (value.code === null || (Number.isInteger(value.code) && value.code >= 0 && value.code <= 255)) &&
        (value.signal === null || /^SIG[A-Z0-9]{1,12}$/.test(value.signal)) &&
        (heartbeat === null || heartbeat.pid === value.pid)) {
      exit = { pid: value.pid, at: new Date(value.at).toISOString(), code: value.code, signal: value.signal };
    }
  } catch { /* an unrelated process cannot recover a missing wait status */ }
  return { ...(heartbeat ? { heartbeat } : {}), ...(exit ? { exit } : {}) };
}
