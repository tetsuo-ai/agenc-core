/** Invocation-local transport reuse; canonical readiness remains the authority. */
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  createConnectedAgenCJsonLineDaemonTuiClient, defaultEnsureDaemonReady,
  type AgenCJsonLineDaemonTuiClient, type AgenCJsonLineDaemonClientOptions,
} from "./agent-cli.js";
import { ensureAgenCDaemonAutostart, type AgenCDaemonConnectionTarget } from "./daemon-autostart.js";
import { DEFAULT_DAEMON_REQUEST_TIMEOUT_MS, resolveAgenCDaemonCookiePath, resolveAgenCDaemonSocketPath, requestAgenCDaemonInstanceIdentity } from "./daemon-control.js";
import { resolveAgenCDaemonRequestTimeoutMs } from "./daemon-request-policy.js";
import { isAgenCDaemonInstanceIdentity, type AgenCDaemonInstanceIdentity } from "./daemon-instance-identity.js";
import { isRecord } from "../utils/record.js";

interface Endpoint {
  readonly socketPath: string;
  readonly cookie: string;
  readonly cookieContents: string;
  readonly dev: bigint;
  readonly ino: bigint;
}
interface Retained {
  readonly client: AgenCJsonLineDaemonTuiClient;
  readonly generation: AgenCJsonLineDaemonTuiClient;
  readonly identity: AgenCDaemonInstanceIdentity;
  readonly endpoint: Endpoint;
}
const changed = (): Error => new Error("Daemon startup connection changed before admission");
const sameEndpoint = (a: Endpoint, b: Endpoint): boolean =>
  a.socketPath === b.socketPath && a.cookieContents === b.cookieContents && a.dev === b.dev && a.ino === b.ino;

export function createDaemonPrintConnectionScope(
  env: NodeJS.ProcessEnv = process.env,
  /** @internal Canonical lifecycle fixture seam. */
  ensureAutostart: typeof ensureAgenCDaemonAutostart = ensureAgenCDaemonAutostart,
) {
  let retained: Retained | null = null;
  let opening: Promise<Retained> | null = null;
  let controlOpening: Promise<AgenCDaemonInstanceIdentity> | null = null;
  let fallbackOpening: Promise<AgenCJsonLineDaemonTuiClient> | null = null;
  let proving = false;
  let closed = false;
  let admitted = false;
  let transferred = false;
  let dispatchingCreate = false;
  let createDispatched = false;
  let proofCount = 0;
  let approvedGeneration: AgenCJsonLineDaemonTuiClient | null = null;
  let disabled = false;

  const endpoint = async (): Promise<Endpoint> => {
    const socketPath = resolveAgenCDaemonSocketPath(env);
    const cookiePath = resolveAgenCDaemonCookiePath(env);
    const cookieContents = await readFile(cookiePath, "utf8");
    const cookie = cookieContents.trim();
    if (cookie.length === 0) throw new Error(`daemon cookie is not available at ${cookiePath}`);
    const stat = await lstat(socketPath, { bigint: true });
    if (!stat.isSocket()) throw changed();
    return { socketPath, cookie, cookieContents, dev: stat.dev, ino: stat.ino };
  };
  const assertLive = (entry: Retained): void => {
    if (closed || entry.generation.getConnectionState().status !== "connected" ||
        entry.client.getConnectionState().status !== "connected") throw changed();
  };
  const assertEndpoint = async (entry: Retained): Promise<void> => {
    const now = await endpoint();
    assertLive(entry);
    if (!sameEndpoint(entry.endpoint, now)) throw changed();
  };
  const discard = async (): Promise<void> => {
    approvedGeneration = null;
    const entry = retained;
    retained = null;
    await entry?.client.close();
  };
  const open = async (before: Endpoint): Promise<Retained> => {
    let generation: AgenCJsonLineDaemonTuiClient | undefined;
    let identity: AgenCDaemonInstanceIdentity | undefined;
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({
      env, socketPath: before.socketPath, authCookie: before.cookie,
    }, {
      readinessTimeoutMs: () => admitted ? undefined
        : resolveAgenCDaemonRequestTimeoutMs(env, DEFAULT_DAEMON_REQUEST_TIMEOUT_MS),
      initialized: (inner, result) => {
        if (admitted) return; // Existing streaming reconnect contract after admission.
        if (closed || generation !== undefined) throw changed();
        if (!isAgenCDaemonInstanceIdentity(result.daemonIdentity)) {
          throw new Error("daemon did not return a valid instance identity");
        }
        generation = inner;
        // Never synthesize any field from the sidecar or return a mutable tuple.
        const value = result.daemonIdentity;
        identity = Object.freeze({ pid: value.pid, processStart: value.processStart,
          instanceId: value.instanceId, runtimeVersion: value.runtimeVersion,
          commit: value.commit, buildTime: value.buildTime });
      },
      canReconnect: () => admitted && !closed,
      beforeRequest: (inner, method) => {
        if (admitted) return;
        if (closed || inner !== generation || inner.getConnectionState().status !== "connected") throw changed();
        if (method === "health.ping" && !transferred) return;
        if (method !== "agent.create" || !dispatchingCreate || createDispatched || approvedGeneration !== inner) throw changed();
        createDispatched = true;
      },
      afterRequest: (inner, method) => {
        if (method === "agent.create" && !admitted) {
          if (inner !== approvedGeneration) throw changed();
          admitted = true;
          approvedGeneration = null;
        }
      },
    });
    try {
      if (generation === undefined || identity === undefined) throw changed();
      const entry = { client, generation, identity, endpoint: before };
      await assertEndpoint(entry);
      return entry;
    } catch (error) {
      await client.close();
      throw error;
    }
  };

  const requestRetainedInstanceIdentity = async (
    target: AgenCDaemonConnectionTarget,
  ): Promise<AgenCDaemonInstanceIdentity> => {
    if (closed || transferred || proving) throw changed();
    proving = true;
    approvedGeneration = null;
    try {
      const before = await endpoint();
      if (closed) throw changed();
      if (retained !== null && (!sameEndpoint(retained.endpoint, before) ||
          retained.generation.getConnectionState().status !== "connected" ||
          retained.identity.pid !== target.pid)) await discard();
      let entry = retained;
      if (entry === null) {
        opening = open(before);
        try { entry = await opening; }
        finally { opening = null; }
        if (closed) { await entry.client.close(); throw changed(); }
        retained = entry;
      } else {
        const response = await entry.client.request("health.ping");
        if (!isRecord(response) || response.ok !== true || typeof response.now !== "string" || response.now.length === 0) {
          throw new Error("daemon did not return a valid health ping response");
        }
        await assertEndpoint(entry);
      }
      assertLive(entry);
      if (entry.identity.pid !== target.pid) throw changed();
      proofCount += 1;
      return entry.identity;
    } catch (error) {
      await discard();
      throw error;
    } finally {
      proving = false;
    }
  };

  // The outer proof must authenticate older daemons with control1.0 before
  // canonical autostart compares builds and performs instance-bound recovery.
  // Only the second proof opens a current-protocol session connection.
  const requestDaemonInstanceIdentity = async (
    target: AgenCDaemonConnectionTarget,
  ): Promise<AgenCDaemonInstanceIdentity> => {
    if (closed || transferred || proving) throw changed();
    proving = true;
    approvedGeneration = null;
    try {
      await discard();
      const before = await endpoint();
      if (closed) throw changed();
      controlOpening = requestAgenCDaemonInstanceIdentity({ env, userHome: homedir() });
      const identity = await controlOpening;
      const after = await endpoint();
      if (closed || identity.pid !== target.pid || !sameEndpoint(before, after)) throw changed();
      return identity;
    } finally {
      controlOpening = null;
      proving = false;
    }
  };

  return {
    requestDaemonInstanceIdentity,
    ensureDaemonReady: (sessionEnv: NodeJS.ProcessEnv = env): (() => Promise<void>) => async () => {
      if (sessionEnv !== env || closed || transferred) throw changed();
      approvedGeneration = null;
      const previous = proofCount;
      try {
        await defaultEnsureDaemonReady(env, (options) => ensureAutostart({
          ...options, requestDaemonInstanceIdentity: requestRetainedInstanceIdentity,
        }))();
        if (proofCount === previous) {
          // Autostart was disabled since the outer route. Preserve the normal
          // authenticated client path, without lending any earlier proof.
          await discard();
          disabled = true;
        } else {
          if (retained === null) throw changed();
          assertLive(retained);
          approvedGeneration = retained.generation;
        }
      } catch (error) { await discard(); throw error; }
    },
    createConnectedTuiClient: async (options: AgenCJsonLineDaemonClientOptions = {}): Promise<AgenCJsonLineDaemonTuiClient> => {
      if (closed || transferred || (options.env ?? env) !== env ||
          Object.keys(options).some(key => key !== "env")) throw changed();
      if (disabled) {
        transferred = true;
        fallbackOpening = createConnectedAgenCJsonLineDaemonTuiClient({ env, ...options });
        const client = await fallbackOpening;
        if (closed) { await client.close(); throw changed(); }
        return client;
      }
      const entry = retained;
      try {
        if (entry === null || approvedGeneration !== entry.generation) throw changed();
        await assertEndpoint(entry);
        transferred = true;
        return {
          ...entry.client,
          request: async (method, params = {}, requestOptions = {}) => {
            if (!admitted) {
              if (method !== "agent.create" || dispatchingCreate) throw changed();
              // A final path check cannot authorize ensureConnected's replacement.
              // The synchronous inner guard below also pins the actual dispatch.
              await assertEndpoint(entry);
              if (dispatchingCreate || createDispatched || closed) throw changed();
              dispatchingCreate = true;
              try { return await entry.client.request(method, params, requestOptions); }
              finally { dispatchingCreate = false; }
            }
            return entry.client.request(method, params, requestOptions);
          },
        };
      } catch (error) { await discard(); throw error; }
    },
    close: async (): Promise<void> => {
      closed = true;
      const pending = opening;
      const pendingControl = controlOpening;
      await discard();
      // Join and close even if an allocation passed its final check immediately
      // before close. No late successful socket may escape this owner's cleanup.
      await pendingControl?.catch(() => undefined);
      const late = await pending?.catch(() => undefined);
      await late?.client.close();
      const fallback = await fallbackOpening?.catch(() => undefined);
      await fallback?.close();
    },
  };
}
