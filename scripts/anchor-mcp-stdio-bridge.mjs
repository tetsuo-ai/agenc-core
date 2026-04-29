#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

function defaultAnchorMcpCommand() {
  if (process.env.ANCHOR_MCP_COMMAND) return process.env.ANCHOR_MCP_COMMAND;
  const home = process.env.HOME;
  if (home) {
    return path.join(home, ".cargo", "bin", "anchor-mcp");
  }
  return "anchor-mcp";
}

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/anchor-mcp-stdio-bridge.mjs [anchor-mcp-command] [anchor-mcp-args...]",
      "",
      "Examples:",
      "  node scripts/anchor-mcp-stdio-bridge.mjs anchor-mcp --mcp",
      "  node scripts/anchor-mcp-stdio-bridge.mjs /home/user/.cargo/bin/anchor-mcp --mcp",
      "",
      "Env overrides:",
      "  ANCHOR_MCP_COMMAND   Override the anchor-mcp binary path",
    ].join("\n"),
  );
}

function frame(message) {
  return `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n\r\n${message}`;
}

function parseHeaderBlock(headerBlock) {
  const headers = new Map();
  for (const rawLine of headerBlock.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(key, value);
  }
  return headers;
}

function createFrameDecoder(onMessage) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      const fallbackHeaderEnd = headerEnd < 0 ? buffer.indexOf("\n\n") : -1;
      const effectiveHeaderEnd = headerEnd >= 0 ? headerEnd : fallbackHeaderEnd;

      if (effectiveHeaderEnd < 0) {
        break;
      }

      const separatorLength = headerEnd >= 0 ? 4 : 2;
      const headerBlock = buffer
        .subarray(0, effectiveHeaderEnd)
        .toString("utf8");
      const headers = parseHeaderBlock(headerBlock);
      const contentLengthRaw = headers.get("content-length");
      if (!contentLengthRaw) {
        throw new Error("Missing Content-Length header");
      }

      const contentLength = Number.parseInt(contentLengthRaw, 10);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        throw new Error(`Invalid Content-Length header: ${contentLengthRaw}`);
      }

      const messageStart = effectiveHeaderEnd + separatorLength;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        break;
      }

      const message = buffer.subarray(messageStart, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);
      onMessage(message);
    }
  };
}

function createLineDecoder(onLine) {
  let textBuffer = "";

  return (chunk) => {
    textBuffer += chunk.toString("utf8");

    while (true) {
      const newlineIndex = textBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = textBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      textBuffer = textBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        onLine(line);
      }
    }
  };
}

function createParentDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  let protocol = "unknown";

  function detectProtocol() {
    if (protocol !== "unknown" || buffer.length === 0) {
      return protocol;
    }

    const preview = buffer.toString("utf8");
    const trimmed = preview.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      protocol = "line";
      return protocol;
    }

    const framePrefix = "Content-Length:";
    if (framePrefix.startsWith(preview) || preview.startsWith(framePrefix)) {
      protocol = "framed";
      return protocol;
    }

    return protocol;
  }

  function consumeLineMessages() {
    while (buffer.length > 0) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.toString("utf8", 0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.subarray(newlineIndex + 1);
      if (line.trim().length > 0) {
        onMessage(line);
      }
    }
  }

  const consumeFramedMessages = createFrameDecoder(onMessage);

  return {
    get protocol() {
      return protocol;
    },
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const activeProtocol = detectProtocol();
      if (activeProtocol === "line") {
        consumeLineMessages();
        return;
      }
      if (activeProtocol === "framed") {
        consumeFramedMessages(buffer);
        buffer = Buffer.alloc(0);
      }
    },
  };
}

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  usage();
  process.exit(0);
}

const command = cliArgs[0] ?? defaultAnchorMcpCommand();
const childArgs = cliArgs.length > 0 ? cliArgs.slice(1) : ["--mcp"];

const child = spawn(command, childArgs, {
  env: {
    ...process.env,
    ANCHOR_MCP_WRAPPER_BYPASS: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

const parentDecoder = createParentDecoder((message) => {
  child.stdin.write(`${message}\n`);
});

process.stdin.on("data", (chunk) => {
  try {
    parentDecoder.push(chunk);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`anchor-mcp-stdio-bridge failed to parse frame: ${message}\n`);
    child.kill("SIGTERM");
    process.exitCode = 1;
  }
});

process.stdin.on("end", () => {
  child.stdin.end();
});

const decodeChildLines = createLineDecoder((line) => {
  if (parentDecoder.protocol === "framed") {
    process.stdout.write(frame(line));
    return;
  }
  process.stdout.write(`${line}\n`);
});

child.stdout.on("data", (chunk) => {
  decodeChildLines(chunk);
});

child.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`anchor-mcp-stdio-bridge failed to launch child: ${message}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 0);
});
