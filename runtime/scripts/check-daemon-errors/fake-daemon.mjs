import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const [, , command, action] = process.argv;
const agencHome = process.env.AGENC_HOME;
if (!agencHome) throw new Error("AGENC_HOME is required");

const cookiePath = path.join(agencHome, "daemon.cookie");
const pidPath = path.join(agencHome, "daemon.pid");
const socketPath = path.join(agencHome, "daemon.sock");

if (command !== "daemon") {
  process.exitCode = 2;
} else if (action === "status") {
  let daemonPid;
  try {
    daemonPid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    process.kill(daemonPid, 0);
    if (!existsSync(socketPath)) daemonPid = undefined;
  } catch {
    daemonPid = undefined;
  }
  if (daemonPid === undefined) {
    process.exitCode = 1;
  } else {
    process.stdout.write(`AgenC daemon running (pid ${daemonPid})\n`);
  }
} else if (action === "start" && process.argv.includes("--foreground")) {
  const recordPath = process.env.AGENC_DAEMON_ERROR_GATE_RECORD;
  if (!recordPath) throw new Error("AGENC_DAEMON_ERROR_GATE_RECORD is required");

  const cookie = "private-daemon-error-gate-cookie";
  writeFileSync(cookiePath, `${cookie}\n`, { mode: 0o600 });
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
  writeFileSync(
    recordPath,
    `${JSON.stringify({
      agencHome,
      home: process.env.HOME,
      pid: process.pid,
    })}\n`,
    { mode: 0o600 },
  );

  const server = createServer((socket) => {
    let buffer = "";
    let initialized = false;

    const respond = (id, result, error) => {
      socket.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        ...(error === undefined ? { result } : { error }),
      })}\n`);
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }

        if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
          respond(request.id ?? null, undefined, {
            code: -32600,
            message: "Invalid request",
          });
          continue;
        }
        if (request.method === "initialize") {
          if (initialized) {
            respond(request.id, undefined, {
              code: -32000,
              message: "Already initialized",
            });
            continue;
          }
          const version = request.params?.protocolVersion;
          if (version !== "1.0.0") {
            respond(request.id, undefined, {
              code: -32000,
              message: "Unsupported protocol version",
            });
            continue;
          }
          initialized = true;
          respond(request.id, { protocolVersion: "1.0.0" });
          continue;
        }
        if (!initialized) {
          respond(request.id, undefined, {
            code: -32000,
            message: "Not initialized",
          });
          continue;
        }
        if (request.method === "absolutely.not.a.real.method") {
          if (process.env.AGENC_DAEMON_ERROR_GATE_FORCE_FAILURE === "1") {
            respond(request.id, { unexpected: true });
          } else {
            respond(request.id, undefined, {
              code: -32601,
              message: "Method not found",
            });
          }
          continue;
        }
        if (request.method === "agent.create" || request.method === "message.stream") {
          respond(request.id, undefined, {
            code: -32602,
            message: "Invalid params",
          });
          continue;
        }
        respond(request.id, undefined, {
          code: -32000,
          message: "Fixture operation failed",
        });
      }
    });
  });

  const removeDaemonArtifacts = () => {
    for (const candidate of [socketPath, pidPath, cookiePath]) {
      rmSync(candidate, { force: true });
    }
  };
  const stop = () => {
    server.close(() => {
      removeDaemonArtifacts();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.listen(socketPath);
} else {
  process.exitCode = 2;
}
