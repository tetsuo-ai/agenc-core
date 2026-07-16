/**
 * Zero-dependency Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 *
 * Chromium is launched with `--remote-debugging-pipe`, which exposes CDP on
 * inherited file descriptors 3 (browser reads commands) and 4 (browser writes
 * responses) using NUL-delimited JSON. This is strictly safer than a loopback
 * TCP debugging port: there is no listening socket for anything on the host to
 * connect to, so no shared-secret handshake is needed — fd inheritance is the
 * capability. No puppeteer/playwright dependency.
 *
 * Flat session mode (`Target.attachToTarget({flatten:true})`) multiplexes every
 * page/session over the one pipe; messages and events carry a `sessionId`.
 *
 * @module
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../sandbox/execution-broker.js";
import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";

const NUL = "\0";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const HEALTHCHECK_TIMEOUT_MS = 10_000;
/**
 * Hard ceiling on a single NUL-delimited CDP frame. A frame is buffered whole
 * before it can be dispatched, so without a cap a hostile page could force
 * unbounded memory growth (e.g. a multi-GB `innerText`/screenshot response).
 * Generous enough for legitimate full-page screenshots; a breach fails the
 * connection closed.
 */
const MAX_CDP_MESSAGE_BYTES = 128 * 1024 * 1024;

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export interface CdpSendOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface CdpEvent {
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

export type CdpEventHandler = (event: CdpEvent) => void;

export class CdpError extends Error {
  readonly code = "CDP_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

interface PendingCommand {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function listenerKey(sessionId: string | undefined, method: string): string {
  return `${sessionId ?? ""}\u0000${method}`;
}

/** A live CDP connection over an inherited fd3/fd4 pipe. */
export class CdpConnection {
  #write: Writable;
  #nextId = 1;
  #buffer = "";
  #closed = false;
  #closeReason: string | undefined;
  readonly #maxMessageBytes: number;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #listeners = new Map<string, Set<CdpEventHandler>>();

  constructor(
    writePipe: Writable,
    readPipe: Readable,
    maxMessageBytes: number = MAX_CDP_MESSAGE_BYTES,
  ) {
    this.#write = writePipe;
    this.#maxMessageBytes = maxMessageBytes;
    readPipe.setEncoding("utf8");
    readPipe.on("data", (chunk: string) => this.#onData(chunk));
    readPipe.on("close", () => this.#failAll("CDP pipe closed"));
    readPipe.on("error", (err: Error) =>
      this.#failAll(`CDP pipe error: ${err.message}`),
    );
    writePipe.on("error", (err: Error) =>
      this.#failAll(`CDP pipe error: ${err.message}`),
    );
  }

  #onData(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    let index = this.#buffer.indexOf(NUL);
    while (index >= 0) {
      const raw = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (raw.length > 0) this.#dispatch(raw);
      index = this.#buffer.indexOf(NUL);
    }
    // Backstop: an unterminated frame past the ceiling means a runaway or
    // hostile response — fail closed instead of buffering without bound.
    if (this.#buffer.length > this.#maxMessageBytes) {
      this.#buffer = "";
      this.#failAll(
        `CDP frame exceeded ${this.#maxMessageBytes} bytes without a terminator`,
      );
    }
  }

  #dispatch(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(
          new CdpError(message.error.message ?? "CDP command failed"),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === "string") {
      const handlers = this.#listeners.get(
        listenerKey(message.sessionId, message.method),
      );
      if (handlers === undefined) return;
      const event: CdpEvent = {
        params: message.params ?? {},
        ...(message.sessionId !== undefined
          ? { sessionId: message.sessionId }
          : {}),
      };
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch {
          // Event handlers must not break the read loop.
        }
      }
    }
  }

  #failAll(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError(reason));
    }
    this.#pending.clear();
    this.#listeners.clear();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Send a CDP command; resolves with its `result` object. */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    options: CdpSendOptions = {},
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      return Promise.reject(
        new CdpError(this.#closeReason ?? "CDP connection closed"),
      );
    }
    const id = this.#nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`CDP command timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(`CDP command aborted: ${method}`));
      };
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new CdpError(`CDP command aborted: ${method}`));
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#pending.set(id, {
        resolve: (result) => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (err) => {
          options.signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer,
      });
      try {
        this.#write.write(JSON.stringify(payload) + NUL);
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(`failed to write CDP command: ${String(err)}`));
      }
    });
  }

  /** Subscribe to an event; returns a disposer. */
  on(
    sessionId: string | undefined,
    method: string,
    handler: CdpEventHandler,
  ): () => void {
    const key = listenerKey(sessionId, method);
    let set = this.#listeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    set.add(handler);
    return () => {
      const current = this.#listeners.get(key);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) this.#listeners.delete(key);
    };
  }

  /** Resolve when `method` fires (optionally matching `predicate`). */
  waitFor(
    sessionId: string | undefined,
    method: string,
    options: {
      readonly predicate?: (params: Record<string, unknown>) => boolean;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
      let dispose: () => void = () => {};
      const timer = setTimeout(() => {
        dispose();
        reject(new CdpError(`timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        clearTimeout(timer);
        dispose();
        reject(new CdpError(`aborted waiting for ${method}`));
      };
      dispose = this.on(sessionId, method, (event) => {
        if (options.predicate !== undefined && !options.predicate(event.params)) {
          return;
        }
        clearTimeout(timer);
        dispose();
        options.signal?.removeEventListener("abort", onAbort);
        resolve(event.params);
      });
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  close(): void {
    this.#failAll("CDP connection closed");
  }
}

export interface LaunchBrowserOptions {
  readonly executablePath: string;
  readonly userDataDir: string;
  readonly headless: boolean;
  readonly noSandbox: boolean;
  /**
   * Loopback port of the in-process SSRF proxy. All browser egress is forced
   * through it and the browser is denied its own DNS/direct connections, so
   * every connection is address-checked once at the proxy (no rebinding).
   */
  readonly proxyPort: number;
  /** Authenticated session boundary for the Chromium process. */
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
}

export interface LaunchedBrowser {
  readonly child: ChildProcess;
  readonly connection: CdpConnection;
}

export function buildChromiumArgs(options: LaunchBrowserOptions): string[] {
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${options.userDataDir}`,
    // Force ALL egress through the loopback SSRF proxy and deny the browser
    // its own DNS/direct connections. `MAP * ~NOTFOUND EXCLUDE 127.0.0.1`
    // makes any direct resolution fail (only the proxy at 127.0.0.1 is
    // reachable); `<-loopback>` disables Chromium's implicit localhost bypass
    // so even loopback traffic is policy-checked at the proxy.
    `--proxy-server=127.0.0.1:${options.proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    // WebRTC opens UDP (STUN/TURN/ICE) flows that an HTTP proxy does NOT carry,
    // so without this a navigated page could egress and disclose local IPs
    // entirely outside the SSRF proxy. Forcing WebRTC to use only the proxy for
    // UDP — which the loopback HTTP proxy cannot relay — disables that escape.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    "--metrics-recording-only",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    "--window-size=1280,800",
  ];
  if (options.headless) args.push("--headless=new", "--hide-scrollbars");
  if (options.noSandbox) args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

/**
 * Launch Chromium with a CDP pipe and confirm the connection is live via
 * `Browser.getVersion`. Throws if the browser fails to speak CDP within the
 * health-check window — the common cause is an executable that is a wrapper
 * script not forwarding fds 3/4 (e.g. a firejail/netns shim), so the error
 * points the user at `[browser].executable_path`.
 */
export async function launchBrowser(
  options: LaunchBrowserOptions,
): Promise<LaunchedBrowser> {
  const sandboxExecutionBroker = options.sandboxExecutionBroker;
  if (sandboxExecutionBroker === undefined) {
    throw missingSandboxExecutionBoundary("browser");
  }
  const env = scrubEnvForChildProcess(process.env);
  const spawnCommand = sandboxExecutionBroker.prepareSpawn("browser", {
    program: options.executablePath,
    args: buildChromiumArgs(options),
    cwd: sandboxExecutionBroker.cwd,
    env,
    additionalPermissions: {
      network: { enabled: true },
      fileSystem: {
        entries: [
          {
            path: { kind: "path", path: options.userDataDir },
            access: "write",
          },
        ],
      },
    },
  });
  const child = spawn(spawnCommand.program, [...spawnCommand.args], {
    cwd: spawnCommand.cwd,
    env: spawnCommand.env,
    argv0: spawnCommand.argv0,
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  const writePipe = child.stdio[3] as Writable | null;
  const readPipe = child.stdio[4] as Readable | null;
  if (writePipe === null || readPipe === null) {
    child.kill("SIGKILL");
    throw new CdpError("browser did not expose the CDP pipe file descriptors");
  }

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (err) =>
      reject(new CdpError(`failed to spawn browser: ${err.message}`)),
    );
    child.once("exit", (code) =>
      reject(
        new CdpError(
          `browser exited before CDP was ready (code ${code ?? "null"})${
            stderrTail !== "" ? `: ${stderrTail.trim()}` : ""
          }`,
        ),
      ),
    );
  });

  const connection = new CdpConnection(writePipe, readPipe);
  try {
    await Promise.race([
      connection.send("Browser.getVersion", {}, undefined, {
        timeoutMs: HEALTHCHECK_TIMEOUT_MS,
      }),
      spawnError,
    ]);
  } catch (err) {
    connection.close();
    child.kill("SIGKILL");
    const detail = err instanceof Error ? err.message : String(err);
    throw new CdpError(
      `browser did not establish a CDP pipe: ${detail}. If the executable is a wrapper script that does not forward file descriptors, set [browser].executable_path to a real Chromium binary.`,
    );
  }
  return { child, connection };
}
