/**
 * @tetsuo-ai/agenc-sdk — typed embedding SDK for the AgenC daemon protocol.
 *
 * See `docs/sdk.md` at the repository root for usage.
 */

export * from "./protocol.js";
export * from "./events.js";
export * from "./client.js";
export {
  connect,
  resolveAgencHome,
  resolveDaemonSocketPath,
  resolveDaemonCookiePath,
  AgencSocketTransport,
  type AgencConnectOptions,
  type AgencSocketTransportOptions,
  type AgencSpawnFn,
} from "./socket.js";
export {
  promptViaSubprocess,
  type AgencSubprocessOptions,
  type AgencSubprocessRun,
  type AgencSubprocessChild,
  type AgencSubprocessSpawnFn,
} from "./subprocess.js";
