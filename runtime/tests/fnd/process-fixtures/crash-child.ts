import { spawn } from "node:child_process";
import { open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  PROCESS_EVIDENCE_NONCE_ENV,
  PROCESS_EVIDENCE_NONCE_HEX_LENGTH,
  PROCESS_EVIDENCE_NONCE_JSON_KEY,
} from "../../helpers/process-evidence-contract.mjs";

const EXIT_USAGE = 64;
const EXIT_STATE_INVALID = 65;
const LOOP_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 25;
const INITIAL_HEARTBEAT_HOLD_MS = 150;
const HEARTBEAT_UPDATE_COUNT = 3;
const MAX_PATH_UTF8_BYTES = 4_096;
const PREPARED_STATE = "prepared\n";
const RECOVERED_STATE = "recovered\n";
const HEX_PATTERN = /^[0-9a-f]+$/u;

type Command =
  | "heartbeat-and-exit"
  | "heartbeat-cooperative"
  | "heartbeat-starts-at-two"
  | "heartbeat-stall"
  | "mark-and-wait"
  | "recover"
  | "resist"
  | "simulated-failure";

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  switch (command) {
    case "heartbeat-and-exit":
      await heartbeatAndExit(requiredPath(3, "heartbeat path"));
      return;
    case "heartbeat-cooperative":
      await heartbeatCooperative(requiredPath(3, "heartbeat path"));
      return;
    case "heartbeat-starts-at-two":
      await heartbeatStartsAtTwo(requiredPath(3, "heartbeat path"));
      return;
    case "heartbeat-stall":
      await heartbeatStall(requiredPath(3, "heartbeat path"));
      return;
    case "mark-and-wait":
      await markAndWait(
        requiredPath(3, "state path"),
        requiredPath(4, "marker path"),
      );
      return;
    case "recover":
      await recover(requiredPath(3, "state path"));
      return;
    case "resist":
      await resist(requiredPath(3, "descendant marker path"));
      return;
    case "simulated-failure":
      process.exitCode = EXIT_STATE_INVALID;
      return;
    default:
      process.stderr.write(
        "usage: crash-child <heartbeat-and-exit|heartbeat-cooperative|heartbeat-stall|" +
          "heartbeat-starts-at-two|mark-and-wait|recover|resist|" +
          "simulated-failure> ...\n",
      );
      process.exitCode = EXIT_USAGE;
  }
}

async function heartbeatAndExit(heartbeatPath: string): Promise<void> {
  for (let sequence = 1; sequence <= HEARTBEAT_UPDATE_COUNT; sequence += 1) {
    await writeHeartbeat(heartbeatPath, sequence);
    await delay(
      sequence === 1 ? INITIAL_HEARTBEAT_HOLD_MS : HEARTBEAT_INTERVAL_MS,
    );
  }
}

async function heartbeatCooperative(heartbeatPath: string): Promise<never> {
  await writeHeartbeat(heartbeatPath, 1);
  return waitForever();
}

async function heartbeatStall(heartbeatPath: string): Promise<never> {
  await writeHeartbeat(heartbeatPath, 1);
  process.on("SIGTERM", () => {});
  return waitForever();
}

async function heartbeatStartsAtTwo(heartbeatPath: string): Promise<never> {
  await writeHeartbeat(heartbeatPath, 2);
  return waitForever();
}

async function markAndWait(
  statePath: string,
  markerPath: string,
): Promise<never> {
  await writeDurableFile(statePath, PREPARED_STATE);
  await writeEvidenceFile(markerPath, {
    schemaVersion: 1,
    phase: "prepared",
  });
  process.on("SIGTERM", () => {});
  return waitForever();
}

async function recover(statePath: string): Promise<void> {
  const state = await readFile(statePath, "utf8");
  if (state !== PREPARED_STATE && state !== RECOVERED_STATE) {
    process.stderr.write("state is not recoverable\n");
    process.exitCode = EXIT_STATE_INVALID;
    return;
  }
  if (state === PREPARED_STATE)
    await writeDurableFile(statePath, RECOVERED_STATE);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, state: "recovered" })}\n`,
  );
}

async function resist(descendantMarkerPath: string): Promise<never> {
  process.on("SIGTERM", () => {});
  const descendantSource =
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
  const descendant = spawn(process.execPath, ["--eval", descendantSource], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  if (descendant.pid === undefined || descendant.pid <= 1) {
    throw new Error("resistant descendant did not publish a valid pid");
  }
  await writeEvidenceFile(descendantMarkerPath, {
    schemaVersion: 1,
    descendantPid: descendant.pid,
  });
  return waitForever();
}

async function writeHeartbeat(path: string, sequence: number): Promise<void> {
  await writeEvidenceFile(path, { schemaVersion: 1, sequence });
}

async function writeEvidenceFile(
  path: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeDurableFile(
    path,
    `${JSON.stringify({
      ...payload,
      [PROCESS_EVIDENCE_NONCE_JSON_KEY]: requiredEvidenceNonce(),
    })}\n`,
  );
}

async function writeDurableFile(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.pending-${process.pid}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  if (process.platform !== "win32") {
    const parent = await open(dirname(path), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}

function waitForever(): Promise<never> {
  return new Promise<never>(() => {
    setInterval(() => {}, LOOP_INTERVAL_MS);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function requiredPath(index: number, label: string): string {
  const value = process.argv[index];
  if (
    value === undefined ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_UTF8_BYTES
  ) {
    throw new Error(`${label} must be a bounded absolute path`);
  }
  return value;
}

function requiredEvidenceNonce(): string {
  const value = process.env[PROCESS_EVIDENCE_NONCE_ENV];
  if (
    value === undefined ||
    value.length !== PROCESS_EVIDENCE_NONCE_HEX_LENGTH ||
    !HEX_PATTERN.test(value)
  ) {
    throw new Error("process evidence nonce is missing or malformed");
  }
  return value;
}

await main();
