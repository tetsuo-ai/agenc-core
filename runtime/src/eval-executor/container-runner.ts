import { spawn } from "node:child_process";
import process from "node:process";
import { EvalExecutorError } from "./source-lock.js";
import {
  EVAL_EXECUTOR_MAXIMUM_CAPTURED_OUTPUT_BYTES,
  type ContainerEnvironment,
  type ContainerExecRequest,
  type ContainerExecResult,
  type ContainerHandle,
  type ContainerRunner,
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
    const capture = (existing: Buffer, chunk: Buffer): Buffer => {
      const remaining = EVAL_EXECUTOR_MAXIMUM_CAPTURED_OUTPUT_BYTES - existing.byteLength;
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

  async createTaskContainer(imageReference: string): Promise<ContainerHandle> {
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
    const dockerReference = isLocalImageId
      ? imageReference.slice("sha256:".length)
      : imageReference;
    const created = await spawnBounded(
      "docker",
      [
        "create",
        "--network",
        "none",
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
    const inspected = await spawnBounded(
      "docker",
      ["image", "inspect", "--format", "{{.Config.WorkingDir}}", dockerReference],
      { timeoutMs: DOCKER_COMMAND_TIMEOUT_MS },
    );
    const workdir = inspected.exitCode === 0 && inspected.stdout.trim().length > 0
      ? inspected.stdout.trim()
      : DEFAULT_TASK_WORKDIR;
    return {
      id,
      imageDigest: isLocalImageId ? imageReference : imageReference.slice(digestIndex + 1),
      workdir,
    };
  }

  async exec(handle: ContainerHandle, request: ContainerExecRequest): Promise<ContainerExecResult> {
    return spawnBounded(
      "docker",
      ["exec", "-w", handle.workdir, handle.id, "bash", "-c", request.script],
      { timeoutMs: request.timeoutMs },
    );
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
