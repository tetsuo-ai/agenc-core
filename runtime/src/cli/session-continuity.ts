import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isProcessAlive, readPidFile } from "../gateway/daemon.js";
import type {
  CliRuntimeContext,
  CliStatusCode,
  SessionContinuityForkOptions,
  SessionContinuityHistoryOptions,
  SessionContinuityInspectOptions,
  SessionContinuityListOptions,
} from "./types.js";

const CONTROL_PLANE_TIMEOUT_MS = 3_000;

interface WsLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
}

interface ShellState {
  ownerToken?: string;
}

function loadShellState(): ShellState {
  try {
    const raw = readFileSync(resolve(homedir(), ".agenc", "shell-state.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ownerToken:
        typeof parsed.ownerToken === "string" && parsed.ownerToken.trim().length > 0
          ? parsed.ownerToken.trim()
          : undefined,
    };
  } catch {
    return {};
  }
}

async function queryControlPlane(
  port: number,
  type: string,
  payload?: unknown,
  options?: {
    expectType?: string;
  },
): Promise<{ payload?: unknown; error?: string }> {
  let WsConstructor: new (url: string) => WsLike;
  try {
    const wsModule = (await import("ws")) as {
      default: new (url: string) => WsLike;
    };
    WsConstructor = wsModule.default;
  } catch {
    throw new Error("ws module not available");
  }

  return new Promise<{ payload?: unknown; error?: string }>(
    (resolvePromise, rejectPromise) => {
      const ws = new WsConstructor(`ws://127.0.0.1:${port}`);
      const requestId = `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const expectedType = options?.expectType ?? type;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        rejectPromise(new Error("Control plane connection timeout"));
      }, CONTROL_PLANE_TIMEOUT_MS);

      const resolveResult = (value: { payload?: unknown; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      };

      const rejectResult = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      };

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            id: requestId,
            type,
            ...(payload !== undefined ? { payload } : {}),
          }),
        );
      });

      ws.on("message", (data: unknown) => {
        try {
          const parsed = JSON.parse(String(data)) as {
            type?: unknown;
            id?: unknown;
            payload?: unknown;
            error?: string;
          };
          if (
            typeof parsed.id !== "string" ||
            parsed.id !== requestId ||
            typeof parsed.type !== "string" ||
            parsed.type !== expectedType
          ) {
            return;
          }
          ws.close();
          resolveResult(parsed);
        } catch {
          ws.close();
          resolveResult({ error: "Invalid response" });
        }
      });

      ws.on("close", () => {
        resolveResult({ error: "Connection closed" });
      });

      ws.on("error", () => {
        rejectResult(new Error("Control plane connection failed"));
      });
    },
  );
}

async function resolveDaemonPort(
  pidPath: string,
  overridePort?: number,
): Promise<{ port: number } | { error: string }> {
  const info = await readPidFile(pidPath);
  if (info === null) {
    return { error: "Daemon is not running (no PID file found)" };
  }
  if (!isProcessAlive(info.pid)) {
    return { error: `Daemon is not running (stale PID ${info.pid})` };
  }
  return { port: overridePort ?? info.port };
}

async function runContinuityQuery(
  context: CliRuntimeContext,
  command: string,
  portOptions: {
    pidPath: string;
    controlPlanePort?: number;
  },
  query: {
    type:
      | "chat.session.list"
      | "chat.session.inspect"
      | "chat.history"
      | "chat.session.fork";
    payload: Record<string, unknown>;
  },
): Promise<{ payload?: unknown; code: CliStatusCode }> {
  const portResult = await resolveDaemonPort(
    portOptions.pidPath,
    portOptions.controlPlanePort,
  );
  if ("error" in portResult) {
    context.error({
      status: "error",
      command,
      message: portResult.error,
    });
    return { code: 1 };
  }

  const ownerToken = loadShellState().ownerToken;
  let response: { payload?: unknown; error?: string };
  try {
    response = await queryControlPlane(portResult.port, query.type, {
      ...query.payload,
      ...(ownerToken ? { ownerToken } : {}),
    }, {
      expectType: query.type,
    });
  } catch (error) {
    context.error({
      status: "error",
      command,
      message: `Failed to query control plane: ${(error as Error).message}`,
    });
    return { code: 1 };
  }

  if (response.error) {
    context.error({
      status: "error",
      command,
      message: response.error,
    });
    return { code: 1 };
  }

  return { payload: response.payload, code: 0 };
}

export async function runSessionContinuityListCommand(
  context: CliRuntimeContext,
  options: SessionContinuityListOptions,
): Promise<CliStatusCode> {
  const { payload, code } = await runContinuityQuery(
    context,
    "session.list",
    options,
    {
      type: "chat.session.list",
      payload: {
        continuity: true,
        ...(options.activeOnly ? { activeOnly: true } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
        ...(options.profile ? { profile: options.profile } : {}),
      },
    },
  );
  if (code !== 0) return code;
  const sessions = Array.isArray(payload) ? payload : [];
  context.output({
    status: "ok",
    command: "session.list",
    sessions,
    count: sessions.length,
  });
  return 0;
}

export async function runSessionContinuityInspectCommand(
  context: CliRuntimeContext,
  options: SessionContinuityInspectOptions,
): Promise<CliStatusCode> {
  const { payload, code } = await runContinuityQuery(
    context,
    "session.inspect",
    options,
    {
      type: "chat.session.inspect",
      payload: { sessionId: options.sessionId },
    },
  );
  if (code !== 0) return code;
  context.output({
    status: "ok",
    command: "session.inspect",
    sessionId: options.sessionId,
    detail: payload ?? null,
  });
  return 0;
}

export async function runSessionContinuityHistoryCommand(
  context: CliRuntimeContext,
  options: SessionContinuityHistoryOptions,
): Promise<CliStatusCode> {
  const { payload, code } = await runContinuityQuery(
    context,
    "session.history",
    options,
    {
      type: "chat.history",
      payload: {
        sessionId: options.sessionId,
        ...(options.limit ? { limit: options.limit } : {}),
        ...(options.includeTools ? { includeTools: true } : {}),
      },
    },
  );
  if (code !== 0) return code;
  const history = Array.isArray(payload) ? payload : [];
  context.output({
    status: "ok",
    command: "session.history",
    sessionId: options.sessionId,
    history,
    count: history.length,
  });
  return 0;
}

export async function runSessionContinuityForkCommand(
  context: CliRuntimeContext,
  options: SessionContinuityForkOptions,
): Promise<CliStatusCode> {
  const { payload, code } = await runContinuityQuery(
    context,
    "session.fork",
    options,
    {
      type: "chat.session.fork",
      payload: {
        sessionId: options.sessionId,
        ...(options.objective ? { objective: options.objective } : {}),
        ...(options.profile ? { profile: options.profile } : {}),
      },
    },
  );
  if (code !== 0) return code;
  context.output({
    status: "ok",
    command: "session.fork",
    sourceSessionId: options.sessionId,
    result: payload ?? null,
  });
  return 0;
}
