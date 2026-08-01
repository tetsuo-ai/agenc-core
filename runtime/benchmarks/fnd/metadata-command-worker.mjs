#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { runSupervisedProcess } from "../../src/utils/supervisedProcess.ts";

const MAX_REQUEST_BYTES = 20_000_000;
const SETTLEMENT_KEEPALIVE_INTERVAL_MS = 1_000;

try {
  const requestBytes = readFileSync(0);
  if (requestBytes.length === 0 || requestBytes.length > MAX_REQUEST_BYTES) {
    throw new Error("bounded metadata command request exceeds its byte limit");
  }
  const request = JSON.parse(requestBytes.toString("utf8"));
  const keepAlive = setInterval(() => {}, SETTLEMENT_KEEPALIVE_INTERVAL_MS);
  let result;
  try {
    result = await runSupervisedProcess(
      {
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        program: request.command,
      },
      {
        maxOutputBytes: request.maxOutputBytes,
        settleBackstopMs: request.settlementTimeoutMs,
        terminateGraceMs: 0,
        timeoutMs: request.timeoutMs,
      },
    );
  } finally {
    clearInterval(keepAlive);
  }
  process.stdout.write(
    JSON.stringify({
      backstopExpired: result.backstopExpired,
      error: result.error?.message,
      exitCode: result.exitCode,
      signal: result.signal,
      stderrBase64: result.stderr.toString("base64"),
      stdoutBase64: result.stdout.toString("base64"),
      stopReason: result.stopReason,
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`bounded metadata command worker failed: ${message}\n`);
  process.exitCode = 1;
}
