import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import {
  AgenCCommandExecService,
  type AgenCCommandExec,
} from "./command-exec.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION, type JsonObject } from "./protocol/index.js";
import type {
  SandboxExecRequest,
  SandboxTransformRequest,
} from "../sandbox/engine/index.js";

const idleScript = "setInterval(() => {}, 1000)";

const readySandboxProbe = (options: {
  readonly mode: "read_only" | "workspace_write";
  readonly platform: NodeJS.Platform;
  readonly agencLinuxSandboxExe?: string;
}) => ({
  kind: "ready" as const,
  mode: options.mode,
  platform: options.platform,
  ...(options.agencLinuxSandboxExe !== undefined
    ? { helperPath: options.agencLinuxSandboxExe }
    : {}),
});

/**
 * These lifecycle/transport tests intentionally execute on the host. Keep that
 * policy explicit so the production service can reject policy-less requests.
 */
class ExplicitDangerCommandExecService extends AgenCCommandExecService {
  override start(
    params: Parameters<AgenCCommandExecService["start"]>[0],
    context: Parameters<AgenCCommandExecService["start"]>[1],
  ): ReturnType<AgenCCommandExecService["start"]> {
    return super.start(
      params.permissionProfile !== undefined || params.sandboxPolicy !== undefined
        ? params
        : { ...params, permissionProfile: ":danger-full-access" },
      context,
    );
  }
}

async function waitForNotification(
  notifications: readonly JsonObject[],
  predicate: (notification: JsonObject) => boolean,
  timeoutMs = 2_000,
): Promise<JsonObject> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = notifications.find(predicate);
    if (match !== undefined) return match;
    await delay(10);
  }
  throw new Error("timed out waiting for command exec notification");
}

function notificationContainsOutput(
  notification: JsonObject,
  text: string,
): boolean {
  const params = notification.params;
  return (
    notification.method === "commandExec.outputDelta" &&
    typeof params === "object" &&
    params !== null &&
    !Array.isArray(params) &&
    params.stream === "stdout" &&
    typeof params.deltaBase64 === "string" &&
    Buffer.from(params.deltaBase64, "base64").toString("utf8").includes(text)
  );
}

function markerPids(marker: string): number[] {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match === null) return [];
        const pid = Number(match[1]);
        const args = match[2] ?? "";
        return pid !== process.pid && args.includes(marker) ? [pid] : [];
      });
  } catch {
    return [];
  }
}

async function waitForMarker(
  marker: string,
  present: boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((markerPids(marker).length > 0) === present) {
      return true;
    }
    await delay(50);
  }
  return false;
}

function killMarker(marker: string): void {
  for (const pid of markerPids(marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best-effort test cleanup.
    }
  }
}

describe("AgenC daemon command exec", () => {
  it("dispatches commandExec methods through initialized JSON-RPC connections", async () => {
    const commandExec: AgenCCommandExec = {
      start: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
      write: vi.fn(async () => ({})),
      resize: vi.fn(async () => ({})),
      terminate: vi.fn(async () => ({})),
      closeConnection: vi.fn(async () => {}),
    };
    const notifications: JsonObject[] = [];
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      commandExec,
    });
    const connection = dispatcher.createConnection({
      sendNotification: (notification) => notifications.push(notification),
    });
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "start",
        method: "commandExec.start",
        params: {
          command: [process.execPath, "-e", "process.stdout.write('ok')"],
          processId: "proc-1",
          streamStdoutStderr: true,
          timeoutMs: 1000,
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      result: { exitCode: 0, stdout: "ok", stderr: "" },
    });
    expect(commandExec.start).toHaveBeenCalledWith(
      {
        command: [process.execPath, "-e", "process.stdout.write('ok')"],
        processId: "proc-1",
        streamStdoutStderr: true,
        timeoutMs: 1000,
      },
      expect.objectContaining({
        connectionId: expect.stringMatching(/^connection_/),
        sendNotification: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "write",
      method: "commandExec.write",
      params: { processId: "proc-1", deltaBase64: "cGluZw==" },
    });
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "resize",
      method: "commandExec.resize",
      params: { processId: "proc-1", size: { rows: 30, cols: 100 } },
    });
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "terminate",
      method: "commandExec.terminate",
      params: { processId: "proc-1" },
    });
    await connection.close();

    expect(commandExec.write).toHaveBeenCalledWith(
      { processId: "proc-1", deltaBase64: "cGluZw==" },
      expect.objectContaining({ connectionId: expect.stringMatching(/^connection_/) }),
    );
    expect(commandExec.resize).toHaveBeenCalledWith(
      { processId: "proc-1", size: { rows: 30, cols: 100 } },
      expect.objectContaining({ connectionId: expect.stringMatching(/^connection_/) }),
    );
    expect(commandExec.terminate).toHaveBeenCalledWith(
      { processId: "proc-1" },
      expect.objectContaining({ connectionId: expect.stringMatching(/^connection_/) }),
    );
    expect(commandExec.closeConnection).toHaveBeenCalledWith(
      expect.stringMatching(/^connection_/),
    );
    expect(notifications).toEqual([]);
  });

  it("rejects streaming commandExec starts when the connection cannot receive notifications", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "start",
        method: "commandExec.start",
        params: {
          command: [process.execPath, "-e", "process.stdout.write('lost')"],
          processId: "no-notifications",
          streamStdoutStderr: true,
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      error: {
        code: -32602,
        message:
          "commandExec.start streaming requires daemon connection notifications",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
  });

  it("returns buffered stdout and stderr for non-streaming commands", async () => {
    const service = new ExplicitDangerCommandExecService();

    await expect(
      service.start(
        {
          command: [
            process.execPath,
            "-e",
            "process.stdout.write(process.env.AGENC_TEST_VALUE); process.stderr.write('warn')",
          ],
          env: { AGENC_TEST_VALUE: "hello" },
          timeoutMs: 2000,
        },
        { connectionId: "buffered" },
      ),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "hello",
      stderr: "warn",
    });
  });

  it("preserves empty and whitespace argv entries after the executable", async () => {
    const service = new ExplicitDangerCommandExecService();

    await expect(
      service.start(
        {
          command: [
            process.execPath,
            "-e",
            "const args = process.argv.slice(1); process.stdout.write(JSON.stringify(args)); process.exit(args[0] === '' && args[1] === ' ' ? 0 : 1);",
            "",
            " ",
          ],
          timeoutMs: 2000,
        },
        { connectionId: "argv" },
      ),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: JSON.stringify(["", " "]),
      stderr: "",
    });
  });

  it("routes legacy sandboxPolicy commands through the sandbox transform before spawning", async () => {
    const sandboxManager = {
      selectInitial: vi.fn(() => "linux_seccomp" as const),
      transform: vi.fn((request: SandboxTransformRequest): SandboxExecRequest => ({
        command: [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify({marker: process.env.AGENC_SANDBOX_MARKER, argv: process.argv.slice(1)}))",
          request.command.program,
          ...request.command.args,
        ],
        cwd: request.command.cwd,
        env: {
          ...request.command.env,
          AGENC_SANDBOX_MARKER: `${request.permissions.fileSystem.kind}:${request.permissions.network}`,
        },
        sandbox: request.sandbox,
        windowsSandboxLevel: request.windowsSandboxLevel,
        windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
        permissionProfile: request.permissions,
        fileSystemSandboxPolicy: request.permissions.fileSystem,
        networkSandboxPolicy: request.permissions.network,
      })),
    };
    const service = new ExplicitDangerCommandExecService({
      sandboxManager,
      agencLinuxSandboxExe: process.execPath,
      sandboxProbe: readySandboxProbe,
    });

    const result = await service.start(
      {
        command: [process.execPath, "-e", "process.stdout.write('inner')"],
        sandboxPolicy: { type: "readOnly", networkAccess: true },
        timeoutMs: 2000,
      },
      { connectionId: "sandbox-policy" },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      marker: "restricted:enabled",
      argv: [process.execPath, "-e", "process.stdout.write('inner')"],
    });
    expect(sandboxManager.selectInitial).toHaveBeenCalledWith(
      expect.objectContaining({
        networkPolicy: "enabled",
        preference: "require",
      }),
    );
    expect(sandboxManager.transform).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: "linux_seccomp",
        sandboxPolicyCwd: process.cwd(),
        permissions: expect.objectContaining({
          fileSystem: expect.objectContaining({ kind: "restricted" }),
          network: "enabled",
        }),
      }),
    );
  });

  it("fails before transform/spawn when required sandbox readiness fails", async () => {
    const sandboxManager = {
      selectInitial: vi.fn(() => "linux_seccomp" as const),
      transform: vi.fn(),
    };
    const service = new ExplicitDangerCommandExecService({
      sandboxManager,
      agencLinuxSandboxExe: process.execPath,
      sandboxProbe: (options) => ({
        kind: "unavailable",
        mode: options.mode,
        platform: options.platform,
        reason: "probe: user namespaces disabled by test",
        remediation: "enable user namespaces",
      }),
    });

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.exit(99)"],
          sandboxPolicy: { type: "readOnly" },
          timeoutMs: 2_000,
        },
        { connectionId: "sandbox-readiness" },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "command_exec",
    });
    expect(sandboxManager.transform).not.toHaveBeenCalled();
  });

  it("accepts built-in permissionProfile ids as command-scoped sandbox profiles", async () => {
    const sandboxManager = {
      selectInitial: vi.fn(() => "linux_seccomp" as const),
      transform: vi.fn((request: SandboxTransformRequest): SandboxExecRequest => ({
        command: [request.command.program, ...request.command.args],
        cwd: request.command.cwd,
        env: request.command.env,
        sandbox: request.sandbox,
        windowsSandboxLevel: request.windowsSandboxLevel,
        windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
        permissionProfile: request.permissions,
        fileSystemSandboxPolicy: request.permissions.fileSystem,
        networkSandboxPolicy: request.permissions.network,
      })),
    };
    const service = new ExplicitDangerCommandExecService({
      sandboxManager,
      agencLinuxSandboxExe: process.execPath,
      sandboxProbe: readySandboxProbe,
    });

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.stdout.write('profile')"],
          cwd: ".",
          permissionProfile: ":workspace",
          timeoutMs: 2000,
        },
        { connectionId: "permission-profile" },
      ),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "profile",
      stderr: "",
    });

    expect(sandboxManager.transform).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxPolicyCwd: expect.stringMatching(/runtime$/u),
        permissions: expect.objectContaining({
          fileSystem: expect.objectContaining({
            kind: "restricted",
            entries: expect.arrayContaining([
              expect.objectContaining({ access: "write" }),
            ]),
          }),
          network: "restricted",
        }),
      }),
    );
  });

  it("honors external sandboxPolicy without adding another managed sandbox", async () => {
    const service = new ExplicitDangerCommandExecService();

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.stdout.write('external')"],
          sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
          timeoutMs: 2000,
        },
        { connectionId: "external-sandbox" },
      ),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "external",
      stderr: "",
    });
  });

  it("streams stdout and stderr as base64 notifications", async () => {
    const service = new ExplicitDangerCommandExecService();
    const notifications: JsonObject[] = [];

    const result = await service.start(
      {
        command: [
          process.execPath,
          "-e",
          "process.stdout.write('out'); process.stderr.write('err')",
        ],
        processId: "stream-1",
        streamStdoutStderr: true,
        timeoutMs: 2000,
      },
      {
        connectionId: "streaming",
        sendNotification: (message) => notifications.push(message),
      },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(notifications).toEqual(
      expect.arrayContaining([
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "commandExec.outputDelta",
          params: {
            processId: "stream-1",
            stream: "stdout",
            deltaBase64: Buffer.from("out").toString("base64"),
            capReached: false,
          },
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "commandExec.outputDelta",
          params: {
            processId: "stream-1",
            stream: "stderr",
            deltaBase64: Buffer.from("err").toString("base64"),
            capReached: false,
          },
        },
      ]),
    );
  });

  it("writes stdin and closes it for pipe-backed sessions", async () => {
    const service = new ExplicitDangerCommandExecService();
    const context = { connectionId: "stdin" };
    const started = service.start(
      {
        command: [
          process.execPath,
          "-e",
          "process.stdin.on('data', (d) => process.stdout.write(d)); process.stdin.on('end', () => process.exit(0))",
        ],
        processId: "stdin-1",
        streamStdin: true,
        disableTimeout: true,
      },
      context,
    );

    await service.write(
      {
        processId: "stdin-1",
        deltaBase64: Buffer.from("ping").toString("base64"),
        closeStdin: true,
      },
      context,
    );

    await expect(started).resolves.toEqual({
      exitCode: 0,
      stdout: "ping",
      stderr: "",
    });
  });

  it("runs a byte-preserving PTY-backed session and resizes it", async () => {
    const service = new ExplicitDangerCommandExecService();
    const notifications: JsonObject[] = [];
    const context = {
      connectionId: "pty",
      sendNotification: (message: JsonObject) => notifications.push(message),
    };
    const started = service.start(
      {
        command: [
          process.execPath,
          "-e",
          "process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdout.write(Buffer.from([0xff, 0xfe, 0x41])); process.stdout.write('ready\\n'); process.stdin.on('data', (d) => { if (Buffer.from(d).includes(255)) process.exit(0); });",
        ],
        processId: "pty-1",
        tty: true,
        size: { rows: 24, cols: 80 },
        disableTimeout: true,
      },
      context,
    );

    await waitForNotification(notifications, (notification) => {
      const params = notification.params;
      return (
        notification.method === "commandExec.outputDelta" &&
        typeof params === "object" &&
        params !== null &&
        !Array.isArray(params) &&
        params.stream === "stdout" &&
        typeof params.deltaBase64 === "string" &&
        Buffer.from(params.deltaBase64, "base64").toString("utf8").includes(
          "ready",
        )
      );
    });

    await expect(
      service.resize({ processId: "pty-1", size: { rows: 30, cols: 100 } }, context),
    ).resolves.toEqual({});
    await expect(
      service.write(
        {
          processId: "pty-1",
          deltaBase64: Buffer.from([0xff]).toString("base64"),
        },
        context,
      ),
    ).resolves.toEqual({});

    await expect(started).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const stdoutBytes = Buffer.concat(
      notifications
        .map((notification) => notification.params)
        .filter(
          (params): params is JsonObject =>
            typeof params === "object" &&
            params !== null &&
            !Array.isArray(params) &&
            params.stream === "stdout" &&
            typeof params.deltaBase64 === "string",
        )
        .map((params) => Buffer.from(params.deltaBase64 as string, "base64")),
    );
    expect(stdoutBytes.includes(Buffer.from([0xff, 0xfe, 0x41]))).toBe(true);
  });

  it(
    "drives a live PTY command through JSON-RPC while start is pending",
    async () => {
      const notifications: JsonObject[] = [];
      const dispatcher = new AgenCDaemonJsonRpcDispatcher({
        agentManager: new AgenCDaemonAgentManager(),
      });
      const connection = dispatcher.createConnection({
        sendNotification: (message) => notifications.push(message),
      });
      await connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "init",
        method: "initialize",
        params: { protocolVersion: "1.0.0", clientName: "contract-test" },
      });
      const startResponse = connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "start",
        method: "commandExec.start",
        params: {
          command: [
            process.execPath,
            "-e",
            "process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdout.write('ready\\n'); process.stdin.on('data', (d) => process.stdout.write('got:' + Buffer.from(d).toString('hex') + '\\n')); setInterval(() => {}, 1000);",
          ],
          processId: "rpc-pty-1",
          permissionProfile: ":danger-full-access",
          tty: true,
          size: { rows: 24, cols: 80 },
          disableTimeout: true,
        },
      });

      await waitForNotification(notifications, (notification) =>
        notificationContainsOutput(notification, "ready"),
      );
      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: "resize",
          method: "commandExec.resize",
          params: {
            processId: "rpc-pty-1",
            size: { rows: 30, cols: 100 },
          },
        }),
      ).resolves.toMatchObject({ result: {} });
      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: "write",
          method: "commandExec.write",
          params: {
            processId: "rpc-pty-1",
            deltaBase64: Buffer.from("x").toString("base64"),
          },
        }),
      ).resolves.toMatchObject({ result: {} });
      await waitForNotification(notifications, (notification) =>
        notificationContainsOutput(notification, "got:78"),
      );
      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: "terminate",
          method: "commandExec.terminate",
          params: { processId: "rpc-pty-1" },
        }),
      ).resolves.toMatchObject({ result: {} });

      const response = await startResponse;
      expect(response).toMatchObject({
        jsonrpc: JSON_RPC_VERSION,
        id: "start",
        result: { stdout: "", stderr: "" },
      });
      expect(
        typeof (response as { result?: { exitCode?: number } }).result?.exitCode,
      ).toBe("number");
    },
  );

  it.skipIf(process.platform === "win32")(
    "request.cancel terminates a PTY foreground child process",
    async () => {
      const marker = `agenc-daemon-pty-abort-${process.pid}-${Date.now()}`;
      const notifications: JsonObject[] = [];
      const dispatcher = new AgenCDaemonJsonRpcDispatcher({
        agentManager: new AgenCDaemonAgentManager(),
      });
      const connection = dispatcher.createConnection({
        sendNotification: (message) => notifications.push(message),
      });
      try {
        await connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: "init",
          method: "initialize",
          params: { protocolVersion: "1.0.0", clientName: "contract-test" },
        });
        const startResponse = connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: "cancel-pty-start",
          method: "commandExec.start",
          params: {
            command: ["bash", "-i"],
            processId: "cancel-pty-1",
            permissionProfile: ":danger-full-access",
            tty: true,
            size: { rows: 24, cols: 80 },
            disableTimeout: true,
          },
        });

        await expect(
          connection.dispatch({
            jsonrpc: JSON_RPC_VERSION,
            id: "write-child",
            method: "commandExec.write",
            params: {
              processId: "cancel-pty-1",
              deltaBase64: Buffer.from(
                `bash -lc 'exec -a ${marker} sleep 30'\n`,
              ).toString("base64"),
            },
          }),
        ).resolves.toMatchObject({ result: {} });
        expect(await waitForMarker(marker, true)).toBe(true);

        await expect(
          connection.dispatch({
            jsonrpc: JSON_RPC_VERSION,
            id: "cancel-pty-request",
            method: "request.cancel",
            params: {
              requestId: "cancel-pty-start",
              reason: "test cancellation",
            },
          }),
        ).resolves.toMatchObject({
          result: {
            requestId: "cancel-pty-start",
            cancelled: true,
          },
        });
        await expect(startResponse).resolves.toMatchObject({
          jsonrpc: JSON_RPC_VERSION,
          id: "cancel-pty-start",
          error: {
            code: -32000,
            data: {
              code: "REQUEST_CANCELLED",
              requestId: "cancel-pty-start",
            },
          },
        });
        expect(await waitForMarker(marker, false)).toBe(true);
      } finally {
        await connection.close();
        killMarker(marker);
      }
    },
    10_000,
  );

  it("rejects duplicate process ids and terminates active sessions", async () => {
    const service = new ExplicitDangerCommandExecService();
    const context = { connectionId: "terminate" };
    const started = service.start(
      {
        command: [process.execPath, "-e", idleScript],
        processId: "term-1",
        disableTimeout: true,
      },
      context,
    );

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", idleScript],
          processId: "term-1",
          disableTimeout: true,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: 'duplicate active commandExec process id: "term-1"',
    });

    await expect(
      service.terminate({ processId: "term-1" }, context),
    ).resolves.toEqual({});
    await expect(started).resolves.toMatchObject({ stdout: "", stderr: "" });
    const result = await started;
    expect(result.exitCode).not.toBe(0);
  });

  it("terminates even when a detached descendant keeps stdio open", async () => {
    const service = new ExplicitDangerCommandExecService();
    const context = { connectionId: "leaked-stdio" };
    const started = service.start(
      {
        command: [
          process.execPath,
          "-e",
          "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 4000)'], { detached: true, stdio: 'inherit' }); child.unref(); setInterval(() => {}, 1000);",
        ],
        processId: "leaked-stdio-1",
        disableTimeout: true,
      },
      context,
    );
    await delay(100);

    const terminatedAt = Date.now();
    await expect(
      service.terminate({ processId: "leaked-stdio-1" }, context),
    ).resolves.toEqual({});
    const result = await started;

    expect(Date.now() - terminatedAt).toBeLessThan(3_500);
    expect(result.exitCode).not.toBe(0);
  });

  it("rejects unsafe or malformed commandExec requests", async () => {
    const service = new ExplicitDangerCommandExecService();

    await expect(
      service.start(
        {
          command: ["", "-e", "process.stdout.write('out')"],
        },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message:
        "commandExec.start param 'command[0]' must be a non-empty string",
    });

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.stdout.write('out')"],
          processId: null,
          tty: true,
        },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message:
        "commandExec.start tty or streaming requires a client-supplied processId",
    });

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.stdout.write('out')"],
          processId: null,
          streamStdin: true,
        },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message:
        "commandExec.start tty or streaming requires a client-supplied processId",
    });

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.stdout.write('out')"],
          processId: null,
          streamStdoutStderr: true,
        },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message:
        "commandExec.start tty or streaming requires a client-supplied processId",
    });

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.stdout.write('out')"],
          streamStdoutStderr: true,
        },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message:
        "commandExec.start tty or streaming requires a client-supplied processId",
    });

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.stdout.write('out')"],
          env: [] as never,
        },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "commandExec.start param 'env' must be an object or null",
    });

    await expect(
      service.start(
        {
          command: [process.execPath, "-e", "process.stdout.write('out')"],
          outputBytesCap: 1,
          disableOutputCap: true,
        },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message:
        "commandExec.start cannot combine outputBytesCap with disableOutputCap",
    });

    await expect(
      service.write(
        { processId: "missing", deltaBase64: "not base64" },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "invalid deltaBase64",
    });

    const closeOnly = service.start(
      {
        command: [
          process.execPath,
          "-e",
          "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))",
        ],
        processId: "close-only",
        streamStdin: true,
        disableTimeout: true,
      },
      { connectionId: "invalid" },
    );
    await expect(
      service.write(
        { processId: "close-only", deltaBase64: null },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "commandExec.write requires deltaBase64 or closeStdin",
    });
    await service.write(
      { processId: "close-only", deltaBase64: null, closeStdin: true },
      { connectionId: "invalid" },
    );
    await expect(closeOnly).resolves.toMatchObject({ exitCode: 0 });

    await expect(
      service.resize(
        { processId: "missing", size: [] as never },
        { connectionId: "invalid" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "commandExec.resize param 'size' must be an object",
    });
  });

  it("terminates all sessions for a closed connection", async () => {
    const service = new ExplicitDangerCommandExecService();
    const context = { connectionId: "closed" };
    const started = service.start(
      {
        command: [process.execPath, "-e", idleScript],
        processId: "closed-1",
        disableTimeout: true,
      },
      context,
    );

    await service.closeConnection("closed");

    await expect(started).resolves.toMatchObject({ stdout: "", stderr: "" });
    const result = await started;
    expect(result.exitCode).not.toBe(0);
    await expect(
      service.terminate({ processId: "closed-1" }, context),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: 'no active commandExec session for process id "closed-1"',
    });
  });

  it("terminates every live child process during daemon cleanup", async () => {
    const service = new ExplicitDangerCommandExecService();
    const first = service.start(
      {
        command: [process.execPath, "-e", idleScript],
        processId: "daemon-1",
        disableTimeout: true,
      },
      { connectionId: "one" },
    );
    const second = service.start(
      {
        command: [process.execPath, "-e", idleScript],
        processId: "daemon-2",
        disableTimeout: true,
      },
      { connectionId: "two" },
    );

    await service.closeAll("daemon_shutdown");

    await expect(first).resolves.toMatchObject({ stdout: "", stderr: "" });
    await expect(second).resolves.toMatchObject({ stdout: "", stderr: "" });
    expect((await first).exitCode).not.toBe(0);
    expect((await second).exitCode).not.toBe(0);
    await expect(
      service.terminate(
        { processId: "daemon-1" },
        { connectionId: "one" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: 'no active commandExec session for process id "daemon-1"',
    });
  });
});
