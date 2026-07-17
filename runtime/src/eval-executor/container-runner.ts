import { spawn } from "node:child_process";
import process from "node:process";
import {
  buildAgentEgressCreateArgs,
  buildEgressNetworkPlan,
  buildSidecarCreateArgs,
  parseEgressProbeReport,
  type EgressLane,
  type EgressLaneRequest,
} from "./egress.js";
import { OVERLAY_NODE, OVERLAY_PROBE_ENTRY } from "./overlay-paths.js";
import { EvalExecutorError } from "./source-lock.js";
import {
  EVAL_EXECUTOR_MAXIMUM_CAPTURED_OUTPUT_BYTES,
  type ContainerEnvironment,
  type ContainerExecRequest,
  type ContainerExecResult,
  type ContainerHandle,
  type ContainerRunner,
  type CreateTaskContainerOptions,
} from "./types.js";

interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

interface SpawnBoundedOptions {
  readonly timeoutMs: number;
  readonly stdin?: Uint8Array;
  readonly maxOutputBytes?: number;
}

function spawnBounded(
  command: string,
  args: readonly string[],
  options: SpawnBoundedOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const maxOutputBytes = options.maxOutputBytes ?? EVAL_EXECUTOR_MAXIMUM_CAPTURED_OUTPUT_BYTES;
    const capture = (existing: Buffer, chunk: Buffer): Buffer => {
      const remaining = maxOutputBytes - existing.byteLength;
      if (remaining <= 0) {
        truncated = true;
        return existing;
      }
      if (chunk.byteLength > remaining) {
        truncated = true;
        return Buffer.concat([existing, chunk.subarray(0, remaining)]);
      }
      return Buffer.concat([existing, chunk]);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new EvalExecutorError([`failed to spawn ${command}: ${error.message}`]));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
    if (options.stdin) {
      child.stdin?.on("error", () => {
        // A dead child surfaces through the close handler; stdin EPIPE is
        // expected in that case and must not crash the process.
      });
      child.stdin?.end(Buffer.from(options.stdin));
    }
  });
}

const DOCKER_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_TASK_WORKDIR = "/testbed";
const PROXY_READY_MARKER = "AGENC_PROXY_READY";
const PROXY_READY_TIMEOUT_MS = 30_000;
const PROXY_READY_POLL_MS = 250;
const EGRESS_PROBE_EXEC_TIMEOUT_MS = 90_000;

export interface DockerContainerRunnerOptions {
  /**
   * Accept a bare local image ID (`sha256:<64 hex>`) instead of a
   * registry-digest-pinned reference. Locally built images have no manifest
   * digest, so the live e2e fixture cannot satisfy the `@sha256` pin; real
   * pilot execution must never set this.
   */
  readonly allowLocalImageId?: boolean;
}

const LOCAL_IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/**
 * Docker-CLI-backed runner for pinned evaluation task images. Every task
 * container is created with `--network none`: preflight and verification are
 * offline by contract, and a rebuild step that needs egress must fail loudly
 * as QA signal instead of being quietly granted network.
 */
export class DockerContainerRunner implements ContainerRunner {
  constructor(private readonly options: DockerContainerRunnerOptions = {}) {}

  async environment(): Promise<ContainerEnvironment> {
    const version = await spawnBounded(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
    );
    if (version.exitCode !== 0) {
      throw new EvalExecutorError([
        `docker daemon is not usable: ${version.stderr.trim() || "no daemon"}`,
      ]);
    }
    return {
      engine: "docker",
      serverVersion: version.stdout.trim(),
      platform: process.platform,
      arch: process.arch,
    };
  }

  async createTaskContainer(
    imageReference: string,
    options: CreateTaskContainerOptions = {},
  ): Promise<ContainerHandle> {
    const { dockerReference, imageDigest } = this.resolveImageRef(imageReference);
    const mountArguments: string[] = [];
    for (const mount of options.readOnlyMounts ?? []) {
      if (!mount.hostPath.startsWith("/") || !mount.containerPath.startsWith("/") ||
          mount.hostPath.includes(",") || mount.containerPath.includes(",") ||
          mount.hostPath.includes(":") || mount.containerPath.includes(":")) {
        throw new EvalExecutorError([
          `invalid mount ${mount.hostPath} -> ${mount.containerPath}`,
        ]);
      }
      mountArguments.push("-v", `${mount.hostPath}:${mount.containerPath}:ro`);
    }
    const created = await spawnBounded(
      "docker",
      [
        "create",
        // Task containers are always network-isolated. A real-model agent
        // lane would need deliberate egress control (a proxy sidecar), never
        // a raw bridge switch here.
        "--network",
        "none",
        ...mountArguments,
        "--entrypoint",
        "sleep",
        dockerReference,
        "infinity",
      ],
      { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
    );
    if (created.exitCode !== 0 || created.stdout.trim().length === 0) {
      throw new EvalExecutorError([
        `docker create failed for ${imageReference}: ${created.stderr.trim()}`,
      ]);
    }
    const id = created.stdout.trim();
    const started = await spawnBounded("docker", ["start", id], {
      timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
    });
    if (started.exitCode !== 0) {
      await spawnBounded("docker", ["rm", "-f", id], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS });
      throw new EvalExecutorError([
        `docker start failed for ${imageReference}: ${started.stderr.trim()}`,
      ]);
    }
    const workdir = await this.inspectWorkdir(dockerReference);
    return { id, imageDigest, workdir };
  }

  private resolveImageRef(imageReference: string): {
    readonly dockerReference: string;
    readonly imageDigest: string;
  } {
    const isLocalImageId = LOCAL_IMAGE_ID_PATTERN.test(imageReference);
    const digestIndex = imageReference.lastIndexOf("@sha256:");
    if (isLocalImageId && this.options.allowLocalImageId !== true) {
      throw new EvalExecutorError([
        `refusing to run local image ID ${imageReference}: task images must be pinned by @sha256 digest`,
      ]);
    }
    if (!isLocalImageId && digestIndex < 0) {
      throw new EvalExecutorError([
        `refusing to run ${imageReference}: task images must be pinned by @sha256 digest`,
      ]);
    }
    return {
      dockerReference: isLocalImageId ? imageReference.slice("sha256:".length) : imageReference,
      imageDigest: isLocalImageId ? imageReference : imageReference.slice(digestIndex + 1),
    };
  }

  private async inspectWorkdir(dockerReference: string): Promise<string> {
    const inspected = await spawnBounded(
      "docker",
      ["image", "inspect", "--format", "{{.Config.WorkingDir}}", dockerReference],
      { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
    );
    return inspected.exitCode === 0 && inspected.stdout.trim().length > 0
      ? inspected.stdout.trim()
      : DEFAULT_TASK_WORKDIR;
  }

  async createAuxiliaryContainer(imageReference: string): Promise<ContainerHandle> {
    const created = await spawnBounded(
      "docker",
      ["create", "--network", "none", "--entrypoint", "sleep", imageReference, "infinity"],
      { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
    );
    if (created.exitCode !== 0 || created.stdout.trim().length === 0) {
      throw new EvalExecutorError([
        `docker create failed for auxiliary image ${imageReference}: ${created.stderr.trim()}`,
      ]);
    }
    const id = created.stdout.trim();
    const started = await spawnBounded("docker", ["start", id], {
      timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
    });
    if (started.exitCode !== 0) {
      await spawnBounded("docker", ["rm", "-f", id], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS });
      throw new EvalExecutorError([
        `docker start failed for auxiliary image ${imageReference}: ${started.stderr.trim()}`,
      ]);
    }
    return { id, imageDigest: imageReference, workdir: "/" };
  }

  /**
   * Stand up the real-model egress lane: two per-run networks, the sidecar
   * proxy, and the agent container on the `--internal` net with a blackholed
   * resolver. Fails closed — any setup error tears everything down and
   * throws, so there is never a half-built or bare-bridge lane. Callers must
   * `teardown()` in a finally.
   */
  async createEgressLane(request: EgressLaneRequest): Promise<EgressLane> {
    const { dockerReference, imageDigest } = this.resolveImageRef(request.taskImage);
    const overlayHostDir = request.overlayHostDir;
    if (!overlayHostDir.startsWith("/") || overlayHostDir.includes(":") || overlayHostDir.includes(",")) {
      throw new EvalExecutorError([`invalid overlay host dir ${overlayHostDir}`]);
    }
    if (!/^[a-z0-9.-]{1,253}$/u.test(request.allowHost)) {
      throw new EvalExecutorError([`invalid allow host ${request.allowHost}`]);
    }
    for (const ip of request.pinIps) {
      if (!/^[0-9a-fA-F.:]{2,45}$/u.test(ip)) {
        throw new EvalExecutorError([`invalid pinned IP ${ip}`]);
      }
    }
    if (request.pinIps.length === 0) {
      throw new EvalExecutorError(["egress lane requires at least one pinned provider IP"]);
    }
    const plan = buildEgressNetworkPlan(request.runId, request.subnetOctet);
    const networks: string[] = [];
    const containers: string[] = [];
    const teardown = async (): Promise<void> => {
      for (const id of containers) {
        await spawnBounded("docker", ["rm", "-f", id], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS });
      }
      for (const name of networks) {
        await spawnBounded("docker", ["network", "rm", name], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS });
      }
    };
    const requireOk = (result: SpawnResult, what: string): SpawnResult => {
      if (result.exitCode !== 0) {
        throw new EvalExecutorError([`${what} failed: ${result.stderr.trim() || "no output"}`]);
      }
      return result;
    };
    try {
      requireOk(
        await spawnBounded("docker", [...plan.egressCreateArgs], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }),
        "egress network create",
      );
      networks.push(plan.egressNetName);
      requireOk(
        await spawnBounded("docker", [...plan.upstreamCreateArgs], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }),
        "upstream network create",
      );
      networks.push(plan.upstreamNetName);

      const sidecarArgs = buildSidecarCreateArgs({
        name: `agenc-eval-proxy-${request.runId}`,
        dockerImageRef: dockerReference,
        overlayHostDir,
        egressNetName: plan.egressNetName,
        proxyIp: plan.proxyIp,
        listenPort: request.proxyListenPort,
        allowHost: request.allowHost,
        allowPort: request.allowPort,
        pinIps: request.pinIps,
        runAsUser: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      });
      const sidecar = requireOk(
        await spawnBounded("docker", [...sidecarArgs], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }),
        "sidecar create",
      );
      const sidecarId = sidecar.stdout.trim();
      if (!sidecarId) throw new EvalExecutorError(["sidecar create returned no id"]);
      containers.push(sidecarId);
      requireOk(
        await spawnBounded(
          "docker", ["network", "connect", plan.upstreamNetName, sidecarId],
          { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
        ),
        "sidecar upstream connect",
      );
      requireOk(
        await spawnBounded("docker", ["start", sidecarId], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }),
        "sidecar start",
      );
      await this.waitForProxyReady(sidecarId);

      const agent = requireOk(
        await spawnBounded(
          "docker",
          [...buildAgentEgressCreateArgs({
            dockerImageRef: dockerReference,
            overlayHostDir,
            egressNetName: plan.egressNetName,
            dns: "127.0.0.1",
          })],
          { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
        ),
        "agent container create",
      );
      const agentId = agent.stdout.trim();
      if (!agentId) throw new EvalExecutorError(["agent create returned no id"]);
      containers.push(agentId);
      requireOk(
        await spawnBounded("docker", ["start", agentId], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }),
        "agent container start",
      );
      const agentHandle: ContainerHandle = {
        id: agentId,
        imageDigest,
        workdir: await this.inspectWorkdir(dockerReference),
      };
      const runner = this;
      const { allowHost, allowPort, proxyListenPort } = request;
      const proxyIp = plan.proxyIp;
      const gatewayIp = plan.gatewayIp;
      return {
        agentHandle,
        proxyIp,
        proxyListenPort,
        async runContainmentProbes() {
          const result = await runner.exec(agentHandle, {
            script:
              `AGENC_PROBE_PROXY=${proxyIp}:${proxyListenPort} AGENC_PROBE_GATEWAY=${gatewayIp} ` +
              `AGENC_PROBE_ALLOW_HOST=${allowHost} AGENC_PROBE_ALLOW_PORT=${allowPort} ` +
              `${OVERLAY_NODE} ${OVERLAY_PROBE_ENTRY}`,
            timeoutMs: EGRESS_PROBE_EXEC_TIMEOUT_MS,
          });
          return parseEgressProbeReport(result.stdout);
        },
        teardown,
      };
    } catch (error) {
      await teardown();
      throw error;
    }
  }

  private async waitForProxyReady(sidecarId: string): Promise<void> {
    const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
    for (;;) {
      const logs = await spawnBounded(
        "docker", ["logs", sidecarId], { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
      );
      if (`${logs.stdout}${logs.stderr}`.includes(PROXY_READY_MARKER)) return;
      const running = await spawnBounded(
        "docker", ["inspect", "--format", "{{.State.Running}}", sidecarId],
        { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
      );
      if (running.stdout.trim() !== "true") {
        throw new EvalExecutorError([`egress sidecar exited before ready: ${logs.stderr.trim()}`]);
      }
      if (Date.now() > deadline) {
        throw new EvalExecutorError(["egress sidecar did not become ready in time"]);
      }
      await new Promise((resolve) => setTimeout(resolve, PROXY_READY_POLL_MS));
    }
  }

  async exec(handle: ContainerHandle, request: ContainerExecRequest): Promise<ContainerExecResult> {
    // `-e NAME` (no `=value`) forwards the value from the executor's own
    // environment: a secret is never on the argv the way `-e NAME=value`
    // would be. Reject a name that could smuggle a literal value.
    const envArgs: string[] = [];
    for (const name of request.envPassthrough ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new EvalExecutorError([`invalid env passthrough name ${name}`]);
      }
      envArgs.push("-e", name);
    }
    return spawnBounded(
      "docker",
      ["exec", ...envArgs, "-w", handle.workdir, handle.id, "bash", "-c", request.script],
      { timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes },
    );
  }

  async copyFile(
    source: ContainerHandle,
    sourcePath: string,
    target: ContainerHandle,
    targetPath: string,
  ): Promise<void> {
    for (const candidate of [sourcePath, targetPath]) {
      if (!candidate.startsWith("/") || candidate.includes("'")) {
        throw new EvalExecutorError([`invalid container path ${candidate}`]);
      }
    }
    const pipeline =
      `set -o pipefail; docker exec ${source.id} cat '${sourcePath}' | ` +
      `docker exec -i ${target.id} bash -c "mkdir -p \\"\\$(dirname '${targetPath}')\\" && cat > '${targetPath}'"`;
    const result = await spawnBounded("bash", ["-c", pipeline], {
      timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      // Do not leave a truncated/empty target behind for fallback readers.
      await spawnBounded(
        "docker",
        ["exec", target.id, "rm", "-f", targetPath],
        { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
      );
      throw new EvalExecutorError([
        `failed to copy ${sourcePath} between containers: ${result.stderr.trim()}`,
      ]);
    }
  }

  async writeFile(handle: ContainerHandle, containerPath: string, bytes: Uint8Array): Promise<void> {
    if (!containerPath.startsWith("/") || containerPath.includes("'")) {
      throw new EvalExecutorError([`invalid container path ${containerPath}`]);
    }
    const result = await spawnBounded(
      "docker",
      [
        "exec",
        "-i",
        handle.id,
        "bash",
        "-c",
        `mkdir -p "$(dirname '${containerPath}')" && cat > '${containerPath}'`,
      ],
      { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS, stdin: bytes },
    );
    if (result.exitCode !== 0) {
      throw new EvalExecutorError([
        `failed to write ${containerPath} into container: ${result.stderr.trim()}`,
      ]);
    }
  }

  async remove(handle: ContainerHandle): Promise<void> {
    await spawnBounded("docker", ["rm", "-f", handle.id], {
      timeoutMs: DOCKER_COMMAND_TIMEOUT_MS,
    });
  }
}
