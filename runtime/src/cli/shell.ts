import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import process from "node:process";

import type {
  CliRuntimeContext,
  CliStatusCode,
  ShellExecOptions,
  ShellOptions,
} from "./types.js";
import { loadGatewayConfig } from "../gateway/config-watcher.js";
import { isProcessAlive, readPidFile } from "../gateway/daemon.js";
import { ensureDaemon } from "./operator-console.js";
import {
  findDaemonProcessesByIdentity,
  runStartCommand,
} from "./daemon.js";
import {
  DEFAULT_SESSION_SHELL_PROFILE,
  coerceSessionShellProfile,
  type SessionShellProfile,
} from "../gateway/shell-profile.js";
import { resolveConfiguredShellProfile } from "../gateway/shell-rollout.js";
import { createLogger } from "../utils/logger.js";

const TURN_IDLE_SETTLE_MS = 150;
const LOCAL_EXIT_COMMANDS = new Set([".exit", ".quit"]);

interface ShellState {
  ownerToken?: string;
  sessions: Record<string, string>;
}

interface WsLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
}

interface ShellDeps {
  readonly ensureDaemon: typeof ensureDaemon;
  readonly loadWsConstructor: () => Promise<new (url: string) => WsLike>;
  readonly createReadline: (params: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }) => Interface;
  readonly cwd: () => string;
  readonly homeDir: () => string;
}

interface ShellTurnWaiters {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface OpenShellSessionResult {
  readonly daemonPid: number;
  readonly daemonPort: number;
  readonly profile: SessionShellProfile;
  readonly workspaceRoot: string;
  sendTurn(content: string): Promise<void>;
  close(): void;
}

const DEFAULT_DEPS: ShellDeps = {
  ensureDaemon,
  loadWsConstructor: async () => {
    const wsModule = (await import("ws")) as {
      default: new (url: string) => WsLike;
    };
    return wsModule.default;
  },
  createReadline: ({ input, output }) =>
    createInterface({
      input,
      output,
      terminal: (output as NodeJS.WriteStream).isTTY !== false,
    }),
  cwd: () => process.cwd(),
  homeDir: () => homedir(),
};

function defaultShellState(): ShellState {
  return { sessions: {} };
}

function parseShellState(raw: string): ShellState {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sessionsRecord: Record<string, string> = {};
    if (parsed.sessions && typeof parsed.sessions === "object") {
      for (const [key, value] of Object.entries(
        parsed.sessions as Record<string, unknown>,
      )) {
        if (typeof value === "string" && value.trim().length > 0) {
          sessionsRecord[key] = value;
        }
      }
    }
    return {
      ownerToken:
        typeof parsed.ownerToken === "string" ? parsed.ownerToken : undefined,
      sessions: sessionsRecord,
    };
  } catch {
    return defaultShellState();
  }
}

function getShellStatePath(homeDir: string): string {
  return resolve(homeDir, ".agenc", "shell-state.json");
}

function loadShellState(homeDir: string): ShellState {
  const statePath = getShellStatePath(homeDir);
  try {
    return parseShellState(readFileSync(statePath, "utf8"));
  } catch {
    return defaultShellState();
  }
}

function saveShellState(homeDir: string, state: ShellState): void {
  const statePath = getShellStatePath(homeDir);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

export function buildShellResumeKey(params: {
  workspaceRoot: string;
  profile: SessionShellProfile;
}): string {
  const resolvedRoot = realpathSync.native(params.workspaceRoot);
  const digest = createHash("sha256")
    .update(`${resolvedRoot}\0${params.profile}`)
    .digest("hex")
    .slice(0, 16);
  return `workspace:${digest}:${params.profile}`;
}

function formatPrompt(profile: SessionShellProfile): string {
  return `agenc(${profile})> `;
}

async function openShellSession(
  options: ShellOptions,
  deps: ShellDeps,
  io: {
    stderr: NodeJS.WritableStream;
    onMessage?: (content: string) => void;
  },
): Promise<OpenShellSessionResult> {
  const requestedProfile =
    coerceSessionShellProfile(options.profile) ?? DEFAULT_SESSION_SHELL_PROFILE;
  let profile = requestedProfile;
  const workspaceRoot = realpathSync.native(resolve(deps.cwd()));
  const state = loadShellState(deps.homeDir());

  const daemon = await deps.ensureDaemon(
    {
      configPath: options.configPath,
      pidPath: options.pidPath,
      logLevel: undefined,
      yolo: false,
    },
    {
      loadGatewayConfig,
      readPidFile,
      isProcessAlive,
      runStartCommand,
      findDaemonProcessesByIdentity,
      createLogger,
    },
  );
  try {
    const config = await loadGatewayConfig(options.configPath);
    profile = resolveConfiguredShellProfile({
      autonomy: config.autonomy,
      requested: requestedProfile,
      stableKey: buildShellResumeKey({
        workspaceRoot,
        profile: requestedProfile,
      }),
    }).profile;
  } catch {
    profile = requestedProfile;
  }
  const shellKey = buildShellResumeKey({ workspaceRoot, profile });

  const WsConstructor = await deps.loadWsConstructor();
  const ws = new WsConstructor(
    `ws://127.0.0.1:${options.controlPlanePort ?? daemon.port}`,
  );

  let ownerToken = state.ownerToken;
  let activeSessionId = options.sessionId?.trim() || undefined;
  let activeProfile = profile;
  let typingActive = false;
  let settleTimer: NodeJS.Timeout | undefined;
  let pendingTurn: ShellTurnWaiters | null = null;
  let bootstrapped = false;
  let bootstrapResolve: (() => void) | null = null;
  let bootstrapReject: ((error: Error) => void) | null = null;
  const bootstrapPromise = new Promise<void>((resolvePromise, rejectPromise) => {
    bootstrapResolve = resolvePromise;
    bootstrapReject = rejectPromise;
  });

  const clearTurnWaiter = (): void => {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    pendingTurn = null;
    typingActive = false;
  };

  const resolveTurn = (): void => {
    if (!pendingTurn) return;
    const { resolve } = pendingTurn;
    clearTurnWaiter();
    resolve();
  };

  const rejectTurn = (error: Error): void => {
    if (!pendingTurn) return;
    const { reject } = pendingTurn;
    clearTurnWaiter();
    reject(error);
  };

  const scheduleTurnSettle = (): void => {
    if (!pendingTurn || typingActive) return;
    if (settleTimer) {
      clearTimeout(settleTimer);
    }
    settleTimer = setTimeout(() => resolveTurn(), TURN_IDLE_SETTLE_MS);
  };

  const send = (type: string, payload?: Record<string, unknown>): void => {
    ws.send(
      JSON.stringify({
        id: randomUUID(),
        type,
        ...(payload ? { payload } : {}),
      }),
    );
  };

  ws.on("open", () => {
    const resumeSessionId =
      activeSessionId ??
      (!options.newSession ? state.sessions[shellKey] : undefined);
    if (resumeSessionId) {
      activeSessionId = resumeSessionId;
      send("chat.session.resume", {
        sessionId: resumeSessionId,
        ownerToken,
        workspaceRoot,
      });
      return;
    }
    send("chat.new", {
      ownerToken,
      workspaceRoot,
      shellProfile: profile,
    });
  });

  ws.on("message", (raw) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "unknown";
    const payload =
      parsed.payload && typeof parsed.payload === "object"
        ? (parsed.payload as Record<string, unknown>)
        : undefined;
    if (type === "chat.owner" && typeof payload?.ownerToken === "string") {
      ownerToken = payload.ownerToken;
      saveShellState(deps.homeDir(), {
        ...state,
        ownerToken,
        sessions: { ...state.sessions },
      });
      return;
    }
    if (type === "chat.session" && typeof payload?.sessionId === "string") {
      activeSessionId = payload.sessionId;
      const resumedProfile = coerceSessionShellProfile(payload?.shellProfile);
      if (resumedProfile) {
        activeProfile = resumedProfile;
      }
      state.sessions[shellKey] = payload.sessionId;
      saveShellState(deps.homeDir(), {
        ownerToken,
        sessions: { ...state.sessions },
      });
      if (!bootstrapped) {
        bootstrapped = true;
        bootstrapResolve?.();
      }
      return;
    }
    if (
      (type === "chat.resumed" || type === "chat.session.resumed") &&
      typeof payload?.sessionId === "string"
    ) {
      activeSessionId = payload.sessionId;
      const resumedProfile = coerceSessionShellProfile(payload?.shellProfile);
      if (resumedProfile) {
        activeProfile = resumedProfile;
      }
      state.sessions[shellKey] = payload.sessionId;
      saveShellState(deps.homeDir(), {
        ownerToken,
        sessions: { ...state.sessions },
      });
      if (!bootstrapped) {
        bootstrapped = true;
        bootstrapResolve?.();
      }
      return;
    }
    if (type === "chat.typing") {
      typingActive = payload?.active === true;
      if (!typingActive) {
        scheduleTurnSettle();
      }
      return;
    }
    if (type === "chat.message" && typeof payload?.content === "string") {
      io.onMessage?.(payload.content);
      scheduleTurnSettle();
      return;
    }
    if (type === "error") {
      const message =
        typeof parsed.error === "string" ? parsed.error : "Shell request failed";
      if (!bootstrapped && activeSessionId && /not found/i.test(message)) {
        activeSessionId = undefined;
        send("chat.new", {
          ownerToken,
          workspaceRoot,
          shellProfile: profile,
        });
        return;
      }
      io.stderr.write(`${message}\n`);
      if (!bootstrapped) {
        bootstrapReject?.(new Error(message));
        return;
      }
      rejectTurn(new Error(message));
    }
  });

  ws.on("close", () => {
    const error = new Error("Shell connection closed");
    bootstrapReject?.(error);
    rejectTurn(error);
  });

  ws.on("error", (error) => {
    const resolved =
      error instanceof Error ? error : new Error(String(error));
    bootstrapReject?.(resolved);
    rejectTurn(resolved);
  });

  await bootstrapPromise;

  return {
    daemonPid: daemon.pid,
    daemonPort: options.controlPlanePort ?? daemon.port,
    workspaceRoot,
    async sendTurn(content: string): Promise<void> {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        pendingTurn = {
          resolve: resolvePromise,
          reject: rejectPromise,
        };
        send("chat.message", {
          content,
          ownerToken,
          workspaceRoot,
          shellProfile: activeProfile,
        });
      });
    },
    close(): void {
      ws.close();
    },
    get profile() {
      return activeProfile;
    },
  };
}

export async function runShellCommand(
  context: CliRuntimeContext,
  options: ShellOptions,
  io: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  } = {},
  deps: ShellDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const rl = deps.createReadline({ input: stdin, output: stdout });
  let session: OpenShellSessionResult | null = null;

  try {
    session = await openShellSession(options, deps, {
      stderr,
      onMessage: (content) => {
        stdout.write(`${content.trimEnd()}\n`);
      },
    });
    stdout.write(
      `Connected to daemon ${session.daemonPid} on port ${session.daemonPort} using profile "${session.profile}".\n`,
    );
    while (true) {
      const line = (await rl.question(formatPrompt(session.profile))).trim();
      if (!line) {
        continue;
      }
      if (LOCAL_EXIT_COMMANDS.has(line)) {
        break;
      }
      await session.sendTurn(line);
    }
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      command: "shell",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    rl.close();
    session?.close();
  }
}

export async function runShellExecCommand(
  context: CliRuntimeContext,
  options: ShellExecOptions,
  io: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  } = {},
  deps: ShellDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const outputs: string[] = [];
  let session: OpenShellSessionResult | null = null;

  try {
    session = await openShellSession(options, deps, {
      stderr,
      onMessage: (content) => {
        outputs.push(content.trimEnd());
      },
    });
    if (options.quietConnection !== true) {
      stdout.write(
        `Connected to daemon ${session.daemonPid} on port ${session.daemonPort} using profile "${session.profile}".\n`,
      );
    }
    await session.sendTurn(options.commandText);
    if (outputs.length > 0) {
      stdout.write(`${outputs.join("\n")}\n`);
    }
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      command: "shell.exec",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    session?.close();
  }
}
