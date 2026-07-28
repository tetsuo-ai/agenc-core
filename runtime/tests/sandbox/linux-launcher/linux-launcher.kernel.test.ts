import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { SandboxExecutionBroker } from "../../../src/sandbox/execution-broker.js";
import { findSystemBubblewrapInPath } from "../../../src/sandbox/linux-launcher/launcher.js";

const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
const launcherEntry = join(runtimeRoot, "bin", "agenc-linux-sandbox");
const builtLauncher = join(
  runtimeRoot,
  "dist",
  "sandbox",
  "linux-launcher",
  "main.js",
);

test(
  "enforces the production Linux sandbox boundary with the real kernel",
  { timeout: 30_000 },
  async () => {
    expect(process.platform).toBe("linux");
    expect(typeof process.getuid).toBe("function");
    expect(process.getuid!()).toBeGreaterThan(0);
    expect(effectiveCapabilities()).toBe(0n);
    expect(existsSync(launcherEntry), launcherEntry).toBe(true);
    expect(existsSync(builtLauncher), builtLauncher).toBe(true);

    const bubblewrap = findSystemBubblewrapInPath(process.env.PATH, process.cwd());
    expect(bubblewrap).toBe("/usr/bin/bwrap");
    const version = spawnSync(bubblewrap!, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(
      version.status,
      `bubblewrap version probe failed\nstdout=${version.stdout}\nstderr=${version.stderr}`,
    ).toBe(0);
    expect(version.stdout.trim()).toMatch(/^bubblewrap \d+\.\d+\.\d+$/u);

    const token = `agenc-kernel-e2e-${randomUUID()}`;
    const root = mkdtempSync(join("/var/tmp", "agenc-kernel-e2e-"));
    const workspace = join(root, "workspace");
    const hostReadOnlyDirectory = join(root, "host-read-only");
    const hostSentinel = join(hostReadOnlyDirectory, "sentinel.txt");
    const hostCreate = join(hostReadOnlyDirectory, "created.txt");
    const allowedWrite = join(workspace, "allowed.txt");
    const evidencePath = join(workspace, "evidence.json");
    const descendantReadyMarker = join(workspace, "descendant-ready.txt");
    const descendantLeakMarker = join(workspace, "descendant-leak.txt");
    const launcherSentinel = join(runtimeRoot, "dist", `.${token}.sentinel`);
    const launcherCreate = join(runtimeRoot, "dist", `.${token}.created`);
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(hostReadOnlyDirectory, { mode: 0o700 });
    writeFileSync(hostSentinel, "host-read-only", { mode: 0o600 });
    writeFileSync(launcherSentinel, "launcher-read-only", { mode: 0o600 });

    const server = createServer();
    let hostConnections = 0;
    let hostPayloads: string[] = [];
    server.on("connection", (socket) => {
      hostConnections += 1;
      socket.setTimeout(2_000, () => socket.destroy());
      socket.once("data", (chunk) => {
        hostPayloads.push(chunk.toString("utf8"));
        socket.end("host-network-visible");
      });
    });

    let launcher: ChildProcessWithoutNullStreams | undefined;
    try {
      await listen(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("kernel capability server did not bind a TCP port");
      }

      const baselineToken = `baseline-${token}`;
      await expect(tcpRoundTrip(address.port, baselineToken)).resolves.toBe(
        "host-network-visible",
      );
      expect(hostConnections).toBe(1);
      expect(hostPayloads).toEqual([baselineToken]);
      hostConnections = 0;
      hostPayloads = [];

      const childEnv = stringEnvironment(process.env);
      delete childEnv.NODE_OPTIONS;
      delete childEnv.AGENC_TEST_NETWORK_ATTEMPT_LEDGER;
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: workspace,
        env: childEnv,
        agencLinuxSandboxExe: launcherEntry,
      });
      const status = broker.status();
      expect(status, JSON.stringify(status, null, 2)).toMatchObject({
        kind: "ready",
        mode: "workspace_write",
        platform: "linux",
        helperPath: realpathSync(launcherEntry),
        isolationProgram: "/usr/bin/bwrap",
      });
      expect(
        readFileSync("/proc/self/attr/current", "utf8").trim(),
      ).toBe("agenc-native-userns (unconfined)");

      const payload = Buffer.from(
        JSON.stringify({
          allowedWrite,
          descendantLeakMarker,
          descendantReadyMarker,
          descendantScript: Buffer.from(
            descendantProbeScript(),
            "utf8",
          ).toString("base64"),
          evidencePath,
          host: "127.0.0.1",
          hostCreate,
          hostSentinel,
          launcherCreate,
          launcherSentinel,
          port: address.port,
          token,
        }),
        "utf8",
      ).toString("base64");
      const prepared = broker.prepareSpawn("tool", {
        program: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          kernelProbeScript(),
          payload,
        ],
        cwd: workspace,
        env: childEnv,
      });
      expect(prepared.program).toBe(realpathSync(process.execPath));
      expect(prepared.args[0]).toBe(realpathSync(launcherEntry));
      expect(prepared.args).toContain("--permission-profile");
      expect(prepared.args).toContain("--");

      launcher = spawn(prepared.program, [...prepared.args], {
        cwd: prepared.cwd,
        env: prepared.env,
        argv0: prepared.argv0,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = await waitForProcess(launcher, 20_000);
      const diagnostics = [
        `bubblewrap=${bubblewrap}`,
        `version=${version.stdout.trim()}`,
        `broker=${JSON.stringify(status)}`,
        `prepared=${JSON.stringify({
          program: prepared.program,
          args: prepared.args,
          cwd: prepared.cwd,
          argv0: prepared.argv0,
        })}`,
        `status=${String(result.code)}`,
        `signal=${String(result.signal)}`,
        `timedOut=${String(result.timedOut)}`,
        `stdout=${JSON.stringify(result.stdout)}`,
        `stderr=${JSON.stringify(result.stderr)}`,
      ].join("\n");

      expect(result.timedOut, diagnostics).toBe(false);
      expect(result.signal, diagnostics).toBeNull();
      expect(result.code, diagnostics).toBe(0);
      expect(existsSync(evidencePath), diagnostics).toBe(true);

      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        readonly allowedWrite: boolean;
        readonly appArmorProfile: string;
        readonly descendant: {
          readonly ready: boolean;
          readonly visibleInProc: boolean;
        };
        readonly hostReadOnly: {
          readonly content: string | null;
          readonly createError: string | null;
          readonly visible: boolean;
          readonly writeError: string | null;
        };
        readonly launcherRoot: {
          readonly content: string | null;
          readonly createError: string | null;
          readonly writeError: string | null;
        };
        readonly network: {
          readonly blocked: boolean;
          readonly error: string | null;
        };
        readonly namespaces: {
          readonly mnt: string;
          readonly net: string;
          readonly pid: string;
          readonly user: string;
        };
      };
      expect(evidence.allowedWrite).toBe(true);
      expect(evidence.appArmorProfile).toBe(
        "agenc-native-userns (unconfined)",
      );
      expect(readFileSync(allowedWrite, "utf8")).toBe("workspace-write-ok");
      expect(evidence.hostReadOnly).toEqual({
        content: "host-read-only",
        createError: "EROFS",
        visible: true,
        writeError: "EROFS",
      });
      expect(readFileSync(hostSentinel, "utf8")).toBe("host-read-only");
      expect(existsSync(hostCreate)).toBe(false);
      expect(evidence.launcherRoot).toEqual({
        content: "launcher-read-only",
        createError: "EROFS",
        writeError: "EROFS",
      });
      expect(readFileSync(launcherSentinel, "utf8")).toBe("launcher-read-only");
      expect(existsSync(launcherCreate)).toBe(false);
      expect(evidence.network).toEqual({ blocked: true, error: "EPERM" });
      expect(evidence.namespaces.mnt).not.toBe(readlinkSync("/proc/self/ns/mnt"));
      expect(evidence.namespaces.net).not.toBe(readlinkSync("/proc/self/ns/net"));
      expect(evidence.namespaces.pid).not.toBe(readlinkSync("/proc/self/ns/pid"));
      expect(evidence.namespaces.user).not.toBe(readlinkSync("/proc/self/ns/user"));
      expect(evidence.descendant).toEqual({
        ready: true,
        visibleInProc: true,
      });
      expect(readFileSync(descendantReadyMarker, "utf8")).toBe(token);

      await new Promise((resolve) => setImmediate(resolve));
      expect(hostConnections).toBe(0);
      expect(hostPayloads).toEqual([]);
      await waitForNoProcessToken(token, 2_000);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(existsSync(descendantLeakMarker)).toBe(false);
      expect(processesContaining(token)).toEqual([]);
      expect(hostConnections).toBe(0);
      expect(hostPayloads).toEqual([]);
    } finally {
      await terminateProcess(launcher);
      killProcessesContaining(token);
      await waitUntilNoProcessToken(token, 2_000);
      await closeServer(server);
      rmSync(root, { force: true, recursive: true });
      rmSync(launcherSentinel, { force: true });
      rmSync(launcherCreate, { force: true });
    }
  },
);

function kernelProbeScript(): string {
  return `
    import { spawn } from "node:child_process";
    import {
      existsSync,
      readFileSync,
      readdirSync,
      readlinkSync,
      writeFileSync,
    } from "node:fs";
    import { connect } from "node:net";
    import { join } from "node:path";

    const payload = JSON.parse(
      Buffer.from(process.argv[1], "base64").toString("utf8"),
    );

    function errorCode(error) {
      return typeof error?.code === "string" ? error.code : String(error);
    }

    function attemptWrite(path, value) {
      try {
        writeFileSync(path, value);
        return null;
      } catch (error) {
        return errorCode(error);
      }
    }

    function networkProbe() {
      return new Promise((resolve) => {
        let settled = false;
        const socket = connect({ host: payload.host, port: payload.port });
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(result);
        };
        const timer = setTimeout(
          () => finish({ blocked: false, error: "timeout" }),
          1500,
        );
        socket.once("connect", () => {
          socket.write(payload.token);
          finish({ blocked: false, error: null });
        });
        socket.once("error", (error) => {
          const code = errorCode(error);
          finish({ blocked: code === "EPERM", error: code });
        });
      });
    }

    async function waitForFile(path, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(path) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return existsSync(path);
    }

    function processTokenVisible(token) {
      for (const entry of readdirSync("/proc", { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\\d+$/.test(entry.name)) continue;
        try {
          const command = readFileSync(
            join("/proc", entry.name, "cmdline"),
            "utf8",
          ).split("\\0").filter(Boolean);
          if (command.includes(token)) return true;
        } catch {
          // A process can exit during procfs enumeration.
        }
      }
      return false;
    }

    writeFileSync(payload.allowedWrite, "workspace-write-ok");
    const hostReadOnly = {
      visible: existsSync(payload.hostSentinel),
      content: existsSync(payload.hostSentinel)
        ? readFileSync(payload.hostSentinel, "utf8")
        : null,
      writeError: attemptWrite(payload.hostSentinel, "sandbox-overwrite"),
      createError: attemptWrite(payload.hostCreate, "sandbox-create"),
    };
    const launcherRoot = {
      content: readFileSync(payload.launcherSentinel, "utf8"),
      writeError: attemptWrite(payload.launcherSentinel, "sandbox-overwrite"),
      createError: attemptWrite(payload.launcherCreate, "sandbox-create"),
    };
    const network = await networkProbe();
    const survivor = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        Buffer.from(payload.descendantScript, "base64").toString("utf8"),
        payload.descendantReadyMarker,
        payload.descendantLeakMarker,
        payload.token,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    survivor.unref();
    const descendantReady = await waitForFile(
      payload.descendantReadyMarker,
      2000,
    );
    const descendantVisible = processTokenVisible(payload.token);

    const evidence = {
      allowedWrite: true,
      appArmorProfile: readFileSync(
        "/proc/self/attr/current",
        "utf8",
      ).trim(),
      descendant: {
        ready: descendantReady,
        visibleInProc: descendantVisible,
      },
      hostReadOnly,
      launcherRoot,
      network,
      namespaces: {
        mnt: readlinkSync("/proc/self/ns/mnt"),
        net: readlinkSync("/proc/self/ns/net"),
        pid: readlinkSync("/proc/self/ns/pid"),
        user: readlinkSync("/proc/self/ns/user"),
      },
    };
    writeFileSync(payload.evidencePath, JSON.stringify(evidence));
    const passed =
      hostReadOnly.visible === true &&
      hostReadOnly.content === "host-read-only" &&
      hostReadOnly.writeError === "EROFS" &&
      hostReadOnly.createError === "EROFS" &&
      launcherRoot.content === "launcher-read-only" &&
      launcherRoot.writeError === "EROFS" &&
      launcherRoot.createError === "EROFS" &&
      evidence.appArmorProfile === "agenc-native-userns (unconfined)" &&
      network.blocked === true &&
      network.error === "EPERM" &&
      descendantReady === true &&
      descendantVisible === true;
    process.exit(passed ? 0 : 23);
  `;
}

function descendantProbeScript(): string {
  return `
    import { writeFileSync } from "node:fs";

    const [readyMarker, leakMarker, token] = process.argv.slice(1);
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      process.on(signal, () => {});
    }
    writeFileSync(readyMarker, token);
    setTimeout(() => writeFileSync(leakMarker, token), 2000);
    setInterval(() => {}, 1000);
  `;
}

function effectiveCapabilities(): bigint {
  const status = readFileSync("/proc/self/status", "utf8");
  const value = /^CapEff:\s*([0-9a-f]+)$/imu.exec(status)?.[1];
  if (value === undefined) {
    throw new Error("/proc/self/status did not report CapEff");
  }
  return BigInt(`0x${value}`);
}

function stringEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function waitForProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout, timedOut });
    });
  });
}

async function terminateProcess(
  child: ChildProcessWithoutNullStreams | undefined,
): Promise<void> {
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("sandbox launcher did not terminate")),
      5_000,
    );
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill("SIGKILL");
  await closed;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function tcpRoundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("host loopback positive control timed out"));
    }, 2_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

async function waitForNoProcessToken(
  token: string,
  timeoutMs: number,
): Promise<void> {
  await waitUntilNoProcessToken(token, timeoutMs);
  expect(processesContaining(token)).toEqual([]);
}

async function waitUntilNoProcessToken(
  token: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processesContaining(token).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function killProcessesContaining(token: string): void {
  for (const match of processesContaining(token)) {
    try {
      process.kill(match.pid, "SIGKILL");
    } catch {
      // A matched descendant can exit between enumeration and signal delivery.
    }
  }
}

function processesContaining(
  token: string,
): Array<{ readonly command: string; readonly pid: number }> {
  const matches: Array<{ command: string; pid: number }> = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const command = readFileSync(join("/proc", entry.name, "cmdline"), "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
      if (command.includes(token)) {
        matches.push({ command, pid: Number.parseInt(entry.name, 10) });
      }
    } catch {
      // Processes can exit between directory enumeration and cmdline open.
    }
  }
  return matches.sort((left, right) => left.pid - right.pid);
}
