// Pure building blocks for the real-model (phase 2b) egress lane. Everything
// here is offline-testable: docker argv builders, the containment-probe
// parser, the containment decision, and the patch key-scan. The docker
// lifecycle that runs these lives in container-runner.ts; the lane wiring in
// agent-run.ts. See docs/design/eval-pilot-executor-phase2b-egress.md.
import {
  OVERLAY_CONTAINER_PATH,
  OVERLAY_NODE,
  OVERLAY_NODE_COMPAT_LIB,
  OVERLAY_PROXY_ENTRY,
} from "./overlay-paths.js";
import type { ContainerHandle, EgressContainmentProbes } from "./types.js";

export const DEFAULT_PROXY_LISTEN_PORT = 8080;

/**
 * Hardened sidecar flags: read-only fs, no caps, no privilege escalation,
 * pid/memory limits. The `--user` is set separately to the executor's own
 * uid:gid so the sidecar can read the operator-staged overlay it is given
 * (a dedicated nobody uid cannot traverse a private scratch dir).
 */
export const SIDECAR_SECURITY_ARGS: readonly string[] = [
  "--read-only",
  "--tmpfs",
  "/tmp",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "128",
  "--memory",
  "128m",
];

export interface EgressNetworkPlan {
  readonly egressNetName: string;
  readonly upstreamNetName: string;
  readonly proxyIp: string;
  /** The bridge gateway on the egress net; the probe asserts it is unreachable. */
  readonly gatewayIp: string;
  readonly egressCreateArgs: readonly string[];
  readonly upstreamCreateArgs: readonly string[];
}

/**
 * The agent joins the `--internal` egress net (no route off the box); only
 * the sidecar is also on the NAT/upstream net. A /29 gives just enough
 * addresses for the two containers.
 */
export function buildEgressNetworkPlan(runId: string, subnetOctet: number): EgressNetworkPlan {
  if (!/^[a-z0-9-]{1,40}$/u.test(runId)) {
    throw new Error(`invalid egress runId ${runId}`);
  }
  if (!Number.isInteger(subnetOctet) || subnetOctet < 1 || subnetOctet > 254) {
    throw new Error(`invalid egress subnet octet ${subnetOctet}`);
  }
  const egressNetName = `agenc-eval-egress-${runId}`;
  const upstreamNetName = `agenc-eval-upstream-${runId}`;
  return {
    egressNetName,
    upstreamNetName,
    proxyIp: `10.88.${subnetOctet}.2`,
    gatewayIp: `10.88.${subnetOctet}.1`,
    egressCreateArgs: [
      "network", "create", "--internal", "--subnet", `10.88.${subnetOctet}.0/29`, egressNetName,
    ],
    upstreamCreateArgs: ["network", "create", upstreamNetName],
  };
}

export interface SidecarPlan {
  readonly name: string;
  readonly dockerImageRef: string;
  readonly overlayHostDir: string;
  readonly egressNetName: string;
  readonly proxyIp: string;
  readonly listenPort: number;
  readonly allowHost: string;
  readonly allowPort: number;
  readonly pinIps: readonly string[];
  /** uid:gid the sidecar runs as (the executor's own, to read the overlay). */
  readonly runAsUser: string;
}

export function buildSidecarCreateArgs(plan: SidecarPlan): readonly string[] {
  return [
    "create",
    "--name", plan.name,
    "--network", plan.egressNetName,
    "--ip", plan.proxyIp,
    ...SIDECAR_SECURITY_ARGS,
    "--user", plan.runAsUser,
    // Non-secret proxy config. The provider API KEY is never given to the
    // sidecar in the opaque-tunnel form — it travels end-to-end from the
    // agent to the provider inside the TLS the sidecar only forwards.
    "-e", `AGENC_PROXY_ALLOW_HOST=${plan.allowHost}`,
    "-e", `AGENC_PROXY_ALLOW_PORT=${plan.allowPort}`,
    "-e", `AGENC_PROXY_PIN_IPS=${plan.pinIps.join(",")}`,
    "-e", `AGENC_PROXY_LISTEN_PORT=${plan.listenPort}`,
    // Some task images lack libatomic.so.1, which the portable Node dist
    // needs; the overlay ships a shim dir the loader checks first.
    "-e", `LD_LIBRARY_PATH=${OVERLAY_NODE_COMPAT_LIB}`,
    "-v", `${plan.overlayHostDir}:${OVERLAY_CONTAINER_PATH}:ro`,
    "--entrypoint", OVERLAY_NODE,
    plan.dockerImageRef,
    OVERLAY_PROXY_ENTRY,
  ];
}

export interface AgentEgressPlan {
  readonly dockerImageRef: string;
  readonly overlayHostDir: string;
  readonly egressNetName: string;
  /** Blackhole resolver so a name lookup cannot leak (127.0.0.1 in-container). */
  readonly dns: string;
}

export function buildAgentEgressCreateArgs(plan: AgentEgressPlan): readonly string[] {
  return [
    "create",
    "--network", plan.egressNetName,
    "--dns", plan.dns,
    "-v", `${plan.overlayHostDir}:${OVERLAY_CONTAINER_PATH}:ro`,
    "--entrypoint", "sleep",
    plan.dockerImageRef,
    "infinity",
  ];
}

export const EGRESS_PROBE_SENTINEL = "AGENC_EGRESS_PROBE:";

/** Parse the probe script's sentinel line. Missing/invalid fields → false. */
export function parseEgressProbeReport(stdout: string): EgressContainmentProbes {
  const fields: Array<keyof EgressContainmentProbes> = [
    "noRouteOffNet", "githubBlocked", "dnsBlackholed",
    "ipv6Absent", "ipLiteralRejected", "sniPinned",
  ];
  const empty = Object.fromEntries(fields.map((f) => [f, false])) as unknown as EgressContainmentProbes;
  const line = stdout.split("\n").reverse().find((l) => l.startsWith(EGRESS_PROBE_SENTINEL));
  if (!line) return empty;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(EGRESS_PROBE_SENTINEL.length));
  } catch {
    return empty;
  }
  if (typeof value !== "object" || value === null) return empty;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    fields.map((f) => [f, record[f] === true]),
  ) as unknown as EgressContainmentProbes;
}

export function allContainmentProbesPass(probes: EgressContainmentProbes): boolean {
  return probes.noRouteOffNet &&
    probes.githubBlocked &&
    probes.dnsBlackholed &&
    probes.ipv6Absent &&
    probes.ipLiteralRejected &&
    probes.sniPinned;
}

export function computeOracleContainment(
  probes: EgressContainmentProbes,
  patchKeyScan: "clean" | "key-substring-found" | "not-run",
): "contained" | "unverified" {
  return allContainmentProbesPass(probes) && patchKeyScan === "clean"
    ? "contained"
    : "unverified";
}

/**
 * True if the provider secret appears verbatim in the collected patch — a
 * prompt-injection exfil attempt. Short secrets are not scanned (a real
 * bearer is long; scanning a short string would false-positive constantly).
 */
export function scanPatchForSecret(patchBytes: Uint8Array, secret: string): boolean {
  if (secret.length < 12) return false;
  return Buffer.from(patchBytes).toString("latin1").includes(secret);
}

/** True if the secret appears verbatim in a text artifact (agent stdout/stderr). */
export function stringContainsSecret(text: string, secret: string): boolean {
  return secret.length >= 12 && text.includes(secret);
}

/** Replace every occurrence of the secret so it never lands in a persisted artifact. */
export function redactSecret(text: string, secret: string): string {
  if (secret.length < 12) return text;
  return text.split(secret).join("[REDACTED-PROVIDER-KEY]");
}

export interface EgressLaneRequest {
  readonly runId: string;
  readonly subnetOctet: number;
  readonly taskImage: string;
  readonly overlayHostDir: string;
  readonly allowHost: string;
  readonly allowPort: number;
  readonly pinIps: readonly string[];
  readonly proxyListenPort: number;
}

/**
 * A live egress lane: the agent container on the internal net, the sidecar
 * proxy, and the two networks. `runContainmentProbes` executes the probe
 * script inside the agent container; `teardown` removes everything.
 */
export interface EgressLane {
  readonly agentHandle: ContainerHandle;
  readonly proxyIp: string;
  readonly proxyListenPort: number;
  runContainmentProbes(): Promise<EgressContainmentProbes>;
  teardown(): Promise<void>;
}

export type EgressLaneFactory = (request: EgressLaneRequest) => Promise<EgressLane>;
