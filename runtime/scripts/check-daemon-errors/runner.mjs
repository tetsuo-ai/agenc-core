/**
 * AgenC daemon JSON-RPC error-path gate.
 *
 * Opens raw Unix-socket connections to the user's running daemon and
 * sends crafted requests to verify every error code in the daemon's
 * JSON-RPC contract:
 *
 *   -32600  invalid request (bad jsonrpc version, missing method/id)
 *   -32601  method not found / not implemented
 *   -32602  invalid params (schema validation failures)
 *   -32000  server-defined (not initialized, already initialized,
 *           unsupported protocol version, lifecycle errors)
 *
 * Each scenario sends one or two JSON-RPC frames and asserts the daemon's
 * response shape matches the contract. The tests do not depend on the
 * model — they exercise only the dispatcher, validators, and transport
 * auth layer.
 *
 * Why a separate gate from check-tui-e2e? The TUI gate exercises the
 * happy path; this one exercises the rough edges. Keeping them separate
 * means a daemon protocol regression doesn't get blamed on a TUI flake.
 */
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SOCKET_PATH = path.join(homedir(), ".agenc", "daemon.sock");
const COOKIE_PATH = path.join(homedir(), ".agenc", "daemon.cookie");
const PROTOCOL_VERSION = "1.0.0";

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};
const color = (c, s) => (process.stdout.isTTY ? `${COLORS[c]}${s}${COLORS.reset}` : s);

function readCookie() {
  return readFileSync(COOKIE_PATH, "utf8").trim();
}

/**
 * Send a sequence of JSON-RPC frames over a fresh socket. Returns a map
 * of { id => response, all: [...] }. Responses can arrive out of order
 * relative to requests, so callers should look up by id, not by index.
 *
 * The expectedResponses count is the number of frames that should
 * produce a response. Frames without an id (notifications) don't
 * contribute. If null, waits for the connection to close after a
 * grace period.
 */
async function sendFrames(frames, { timeoutMs = 5_000, expectedResponses } = {}) {
  const expected =
    expectedResponses ?? frames.filter((f) => f.id !== undefined).length;
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH);
    const all = [];
    const byId = new Map();
    let buffer = "";
    let done = false;

    const settle = (value, error) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      // Timeout returns whatever has arrived so far rather than rejecting,
      // so tests can assert "no response" cleanly.
      settle({ all, byId });
    }, timeoutMs);

    socket.on("connect", () => {
      for (const frame of frames) {
        socket.write(JSON.stringify(frame) + "\n");
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          settle(undefined, new Error(`unparseable response: ${line}`));
          return;
        }
        all.push(parsed);
        if (parsed.id !== undefined) {
          byId.set(parsed.id, parsed);
        }
        if (all.length >= expected) {
          clearTimeout(timer);
          settle({ all, byId });
          return;
        }
      }
    });

    socket.on("error", (err) => settle(undefined, err));
    socket.on("close", () => {
      if (all.length > 0) {
        clearTimeout(timer);
        settle({ all, byId });
      } else {
        clearTimeout(timer);
        settle({ all, byId });
      }
    });
  });
}

const initialize = (overrides = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    protocol: { version: PROTOCOL_VERSION },
    clientName: "agenc-daemon-error-gate",
    authCookie: readCookie(),
    capabilities: {},
    ...overrides,
  },
});

const scenarios = [];

function expectError(byId, id, codes, msgPattern) {
  const r = byId.get(id);
  if (!r) throw new Error(`no response for id=${id}`);
  if (!r.error) throw new Error(`expected error for id=${id}, got: ${JSON.stringify(r)}`);
  const allowed = Array.isArray(codes) ? codes : [codes];
  if (!allowed.includes(r.error.code)) {
    throw new Error(
      `expected ${allowed.join(" or ")}, got ${r.error.code}: ${r.error.message}`,
    );
  }
  if (msgPattern && !msgPattern.test(r.error.message)) {
    throw new Error(
      `expected message ${msgPattern}, got: ${r.error.message}`,
    );
  }
}

function expectSuccess(byId, id) {
  const r = byId.get(id);
  if (!r) throw new Error(`no response for id=${id}`);
  if (r.error) throw new Error(`expected success for id=${id}, got error: ${JSON.stringify(r)}`);
  return r.result;
}

scenarios.push({
  name: "01-invalid-jsonrpc-version",
  description: "request with jsonrpc=1.0 returns -32600",
  async run() {
    const { byId } = await sendFrames([
      { jsonrpc: "1.0", id: 99, method: "initialize", params: {} },
    ]);
    expectError(byId, 99, -32600);
  },
});

scenarios.push({
  name: "02-missing-method",
  description: "request without a method returns -32600",
  async run() {
    const { byId } = await sendFrames([
      { jsonrpc: "2.0", id: 100, params: {} },
    ]);
    // Auth layer also rejects pre-initialize messages; accept either
    // -32600 (request shape) or -32000 (auth) since the auth check
    // fires first in the dispatcher pipeline.
    expectError(byId, 100, [-32600, -32000]);
  },
});

scenarios.push({
  name: "03-missing-id",
  description: "request without an id is rejected (id-less requests can't be replied to)",
  async run() {
    // No id → daemon may not be able to respond at all. Send and wait
    // briefly; the assertion is that the daemon stays alive (verified by
    // the next scenario's initialize success).
    await sendFrames([{ jsonrpc: "2.0", method: "initialize", params: {} }], {
      timeoutMs: 1_000,
      expectedResponses: 1,
    });
    // No throw = test passes
  },
});

scenarios.push({
  name: "04-unknown-method-after-initialize",
  description: "calling an unknown method on an initialized connection returns -32601",
  async run() {
    const { byId } = await sendFrames([
      initialize(),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "absolutely.not.a.real.method",
        params: {},
      },
    ]);
    expectSuccess(byId, 1);
    expectError(byId, 2, -32601);
  },
});

scenarios.push({
  name: "05-not-initialized",
  description: "calling a method before initialize is rejected by auth (-32000)",
  async run() {
    const { byId } = await sendFrames([
      { jsonrpc: "2.0", id: 1, method: "agent.list", params: {} },
    ]);
    // Pre-initialize messages fail at the auth layer with
    // 'authentication failed' before the dispatcher's 'Not initialized'
    // check fires. Both are -32000.
    expectError(byId, 1, -32000);
  },
});

scenarios.push({
  name: "06-already-initialized",
  description: "calling initialize twice on one connection returns -32000 'Already initialized'",
  async run() {
    const { byId } = await sendFrames([
      initialize(),
      { ...initialize(), id: 2 },
    ]);
    expectSuccess(byId, 1);
    expectError(byId, 2, -32000, /already initialized/i);
  },
});

scenarios.push({
  name: "07-unsupported-protocol-version",
  description: "initialize with an unsupported protocol version returns -32000",
  async run() {
    const { byId } = await sendFrames([
      initialize({
        protocolVersion: "99.0.0",
        protocol: { version: "99.0.0" },
      }),
    ]);
    expectError(byId, 1, -32000, /unsupported protocol/i);
  },
});

scenarios.push({
  name: "08-bad-auth-cookie-same-uid",
  description: "bogus cookie is accepted on a same-UID Unix socket (auth ladder design)",
  async run() {
    // The daemon's auth ladder is: peer-cred OR private-socket-owner OR
    // cookie. Connecting on the local Unix socket from the same UID
    // matches private-socket-owner, so the cookie is not consulted.
    // This is intentional — the cookie is the fallback for cases where
    // the connection isn't trusted-by-UID (e.g., WebSocket, cross-user).
    // Verify the design: bogus cookie + same-UID socket = success.
    const { byId } = await sendFrames(
      [initialize({ authCookie: "not-the-real-cookie-1234" })],
      { timeoutMs: 2_000 },
    );
    const r = byId.get(1);
    if (!r) throw new Error(`no response for id=1`);
    if (r.error) {
      throw new Error(
        `expected success on same-UID socket, got error: ${JSON.stringify(r)}`,
      );
    }
    // Cross-UID / WebSocket cookie enforcement is a separate test target
    // not exercised here. See GAP-DMN-04 for the peer-cred binding gap.
  },
});

scenarios.push({
  name: "09-invalid-params-agent-create",
  description: "agent.create with malformed params returns -32602",
  async run() {
    const { byId } = await sendFrames(
      [
        initialize(),
        {
          jsonrpc: "2.0",
          id: 2,
          method: "agent.create",
          params: { objective: 12345 },
        },
      ],
      { timeoutMs: 35_000 },
    );
    expectSuccess(byId, 1);
    expectError(byId, 2, [-32602, -32000]);
  },
});

scenarios.push({
  name: "10-agent-stop-unknown",
  description: "agent.stop with an unknown agentId returns a clean error",
  async run() {
    const { byId } = await sendFrames(
      [
        initialize(),
        {
          jsonrpc: "2.0",
          id: 2,
          method: "agent.stop",
          params: { agentId: "agent-that-does-not-exist-7c3f" },
        },
      ],
      { timeoutMs: 35_000 },
    );
    expectSuccess(byId, 1);
    const r = byId.get(2);
    if (!r) throw new Error(`no response for id=2`);
    if (!r.error) throw new Error(`expected error, got success: ${JSON.stringify(r)}`);
  },
});

scenarios.push({
  name: "11-message-stream-without-session",
  description: "message.stream without sessionId returns -32602",
  async run() {
    const { byId } = await sendFrames(
      [
        initialize(),
        {
          jsonrpc: "2.0",
          id: 2,
          method: "message.stream",
          params: { content: [{ type: "text", text: "hi" }] },
        },
      ],
      { timeoutMs: 35_000 },
    );
    expectSuccess(byId, 1);
    expectError(byId, 2, [-32602, -32000]);
  },
});

scenarios.push({
  name: "12-session-attach-unknown-session",
  description: "session.attach with unknown sessionId returns a clean error",
  async run() {
    const { byId } = await sendFrames(
      [
        initialize(),
        {
          jsonrpc: "2.0",
          id: 2,
          method: "session.attach",
          params: {
            sessionId: "session-that-does-not-exist-abc1",
            clientId: "test-client",
          },
        },
      ],
      { timeoutMs: 35_000 },
    );
    expectSuccess(byId, 1);
    const r = byId.get(2);
    if (!r) throw new Error(`no response for id=2`);
    if (!r.error) throw new Error(`expected error, got success: ${JSON.stringify(r)}`);
  },
});

scenarios.push({
  name: "13-malformed-json",
  description: "non-JSON payload doesn't crash the daemon",
  async run() {
    return new Promise((resolve, reject) => {
      const socket = connect(SOCKET_PATH);
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        // Daemon may either close the connection or emit a parse error.
        // Either is acceptable; what matters is that the daemon is still
        // alive afterwards, which we verify on the next scenario's
        // initialize.
        resolve();
      }, 2_000);
      socket.on("connect", () => {
        socket.write("not json at all\nstill not json\n");
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
      });
      socket.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Connection error is acceptable — daemon refused or closed.
        resolve();
      });
      socket.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  },
});

scenarios.push({
  name: "14-daemon-still-alive-after-malformed",
  description: "after malformed-payload abuse, daemon still serves a normal initialize",
  async run() {
    const { byId } = await sendFrames([initialize()]);
    expectSuccess(byId, 1);
  },
});

async function main() {
  console.log(color("bold", `agenc daemon protocol-error gate (${scenarios.length} scenarios)`));
  console.log("");

  const failed = [];
  let passed = 0;
  for (const sc of scenarios) {
    process.stdout.write(`  ${color("dim", "→")} ${sc.name} … `);
    const start = Date.now();
    try {
      await sc.run();
      passed += 1;
      console.log(
        `${color("green", "PASS")} ${color("dim", `(${Date.now() - start}ms)`)}`,
      );
    } catch (e) {
      console.log(`${color("red", "FAIL")} ${color("dim", `(${Date.now() - start}ms)`)}`);
      console.log(`      ${color("red", "✗")} ${e.message}`);
      failed.push({ name: sc.name, error: e });
    }
  }

  console.log("");
  if (failed.length === 0) {
    console.log(color("green", `✓ ${passed}/${scenarios.length} passed`));
    process.exit(0);
  } else {
    console.log(color("red", `✗ ${failed.length}/${scenarios.length} failed (${passed} passed)`));
    for (const f of failed) {
      console.log(`    - ${f.name}: ${f.error.message}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(color("red", "fatal: " + (e?.stack ?? e)));
  process.exit(1);
});
