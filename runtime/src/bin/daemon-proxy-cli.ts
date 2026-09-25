import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Duplex, Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { posix, win32 } from "node:path";
import { createNodeDaemonCliHost, resolveAgenCDaemonCookiePath, resolveAgenCDaemonSocketPath } from "../app-server/daemon-cli.js";

const MAX_LINE = 1024 * 1024;
const MAX_BUFFER = 4 * MAX_LINE;
const METHODS = new Set(["initialize", "ping", "session.list", "session.attach", "session.detach",
  "session.snapshot", "session.transcript", "session.transcript.v2", "session.artifact.read", "session.cancelTurn",
  "message.send", "tool.approve", "tool.deny"]);

export type DaemonProxyCommand = { readonly mode: "stdio"; readonly coreHome?: string } | "help";

/** Shell-safe transport for a saved remote home, validated on the remote OS. */
export function decodeDaemonProxyHome(encoded: string, platform: NodeJS.Platform = process.platform): string | null {
  if (encoded.length > 5500 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length > 4096 || bytes.toString("base64url") !== encoded) return null;
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
    if (platform !== "win32") return posix.isAbsolute(value) ? value : null;
    // Windows isAbsolute also accepts root-relative paths, which are not a
    // stable home identity. Device namespaces are not filesystem home roots.
    if (!win32.isAbsolute(value) || /^[\\/]{2}[?.][\\/]/u.test(value)) return null;
    return /^[A-Za-z]:[\\/]/u.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value) ? value : null;
  } catch { return null; }
}

export function daemonProxyEnvironment(env: NodeJS.ProcessEnv, command: Exclude<DaemonProxyCommand, "help">): NodeJS.ProcessEnv {
  return command.coreHome === undefined ? { ...env } : { ...env, AGENC_HOME: command.coreHome };
}

export function parseAgenCDaemonProxyCliArgs(argv: readonly string[], platform: NodeJS.Platform = process.platform): DaemonProxyCommand | null {
  if (argv[0] !== "daemon" || argv[1] !== "proxy") return null;
  if (argv.length === 3 && argv[2] === "--stdio") return { mode: "stdio" };
  if (argv.length === 5 && argv[2] === "--stdio" && argv[3] === "--home-b64") {
    const coreHome = decodeDaemonProxyHome(argv[4]!, platform);
    if (coreHome !== null) return { mode: "stdio", coreHome };
  }
  return "help";
}

export interface DaemonProxyIo { input: Readable; output: Writable; error: Writable }

/** Cookie stays inside this process. stdout is exclusively bounded protocol frames. */
export async function bridgeDaemonProxy(socket: Duplex, cookie: string, io: DaemonProxyIo): Promise<number> {
  if (!/^[a-f0-9]{64}$/i.test(cookie)) { io.error.write("SSH_PROXY_AUTH_UNAVAILABLE\n"); socket.destroy(); return 1; }
  return new Promise<number>((resolve) => {
    let ended = false, initialized = false;
    let initializeId: string | number | null = null;
    let inputBuffer = "", outputBuffer = "";
    const inputDecoder = new StringDecoder("utf8"), outputDecoder = new StringDecoder("utf8");
    const pending = new Set<string | number>();
    const timer = setTimeout(() => finish(1, "SSH_PROXY_INITIALIZE_TIMEOUT"), 15_000);
    timer.unref();
    const finish = (code: number, error?: string): void => {
      if (ended) return;
      ended = true; clearTimeout(timer); socket.destroy();
      io.input.off("data", onInput); io.input.off("end", onInputEnd); io.input.off("error", onError);
      io.output.off("error", onError); socket.off("data", onOutput);
      if (error) io.error.write(`${error}\n`);
      resolve(code);
    };
    const write = (output: Writable, value: unknown, source: Readable): boolean => {
      const line = JSON.stringify(value) + "\n";
      if (Buffer.byteLength(line) > MAX_LINE || output.writableLength + Buffer.byteLength(line) > MAX_BUFFER) {
        finish(1, "SSH_PROXY_BUFFER_LIMIT"); return false;
      }
      if (!output.write(line)) {
        source.pause(); output.once("drain", () => { if (!ended) source.resume(); });
      }
      return true;
    };
    const deny = (id: string | number, message: string): void => { write(io.output, { jsonrpc: "2.0", id, error: { code: -32600, message } }, socket); };
    const parseLines = (buffer: string, process: (frame: Record<string, unknown>) => void): string => {
      let newline: number;
      while (!ended && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE) { finish(1, "SSH_PROXY_FRAME_LIMIT"); return ""; }
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { finish(1, "SSH_PROXY_INVALID_FRAME"); return ""; }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) { finish(1, "SSH_PROXY_INVALID_FRAME"); return ""; }
        process(frame as Record<string, unknown>);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) { finish(1, "SSH_PROXY_FRAME_LIMIT"); return ""; }
      return buffer;
    };
    const onInput = (chunk: Buffer | string): void => {
      inputBuffer = parseLines(inputBuffer + (typeof chunk === "string" ? chunk : inputDecoder.write(chunk)), (frame) => {
        const id = frame.id;
        if (frame.jsonrpc !== "2.0" || (typeof id !== "string" && typeof id !== "number") ||
          typeof frame.method !== "string" || !METHODS.has(frame.method) || pending.has(id)) {
          finish(1, "SSH_PROXY_REQUEST_DENIED"); return;
        }
        if (pending.size >= 64) { deny(id, "SSH proxy request limit"); return; }
        if (frame.method !== "initialize" && !initialized) { deny(id, "Initialize the SSH connection first"); return; }
        if (frame.method === "initialize") {
          if (initialized || initializeId !== null) { deny(id, "SSH connection already initialized"); return; }
          const params = frame.params;
          if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) { deny(id, "Invalid initialize parameters"); return; }
          frame.params = { ...(params as Record<string, unknown> | undefined), authCookie: cookie };
          initializeId = id;
        }
        pending.add(id);
        write(socket, frame, io.input);
      });
    };
    const onOutput = (chunk: Buffer | string): void => {
      outputBuffer = parseLines(outputBuffer + (typeof chunk === "string" ? chunk : outputDecoder.write(chunk)), (frame) => {
        // Never expose the portable daemon authenticator, even if a daemon error echoes input.
        if (JSON.stringify(frame).includes(cookie)) { finish(1, "SSH_PROXY_SECRET_REDACTED"); return; }
        if (frame.id === initializeId && initializeId !== null) {
          if (frame.error) { write(io.output, { jsonrpc: "2.0", id: initializeId, error: { code: -32001, message: "Remote Core initialization failed" } }, socket); finish(1, "SSH_PROXY_AUTH_FAILED"); return; }
          initialized = true; clearTimeout(timer);
        }
        if (typeof frame.id === "number" || typeof frame.id === "string") pending.delete(frame.id);
        write(io.output, frame, socket);
      });
    };
    const onError = (): void => finish(1, "SSH_PROXY_CONNECTION_CLOSED");
    const onInputEnd = (): void => finish(0);
    io.input.on("data", onInput); io.input.once("end", onInputEnd); io.input.once("error", onError);
    io.output.once("error", onError); socket.on("data", onOutput); socket.once("error", onError);
    socket.once("close", () => finish(0));
    socket.once("end", () => finish(0));
  });
}

export async function runAgenCDaemonProxyCli(command: DaemonProxyCommand): Promise<number> {
  if (command === "help") { process.stderr.write("Usage: agenc daemon proxy --stdio [--home-b64 <base64url-absolute-home>]\nConnects to the running local Core daemon for an authenticated SSH client.\n"); return 2; }
  const host = createNodeDaemonCliHost();
  const env = daemonProxyEnvironment(host.env, command);
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    const cookie = (await readFile(resolveAgenCDaemonCookiePath(env, host.userHome), "utf8")).trim();
    const connected = createConnection(resolveAgenCDaemonSocketPath(env, host.userHome));
    socket = connected;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { connected.destroy(); reject(new Error("timeout")); }, 10_000);
      connected.once("connect", () => { clearTimeout(timer); resolve(); });
      connected.once("error", () => { clearTimeout(timer); reject(new Error("connect")); });
    });
    return await bridgeDaemonProxy(connected, cookie, { input: process.stdin, output: process.stdout, error: process.stderr });
  } catch {
    socket?.destroy(); process.stderr.write("SSH_PROXY_DAEMON_UNAVAILABLE\n"); return 1;
  }
}
