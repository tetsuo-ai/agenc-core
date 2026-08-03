import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { backfillPinnedRolloutFile } from "../src/state/backfill.js";
import {
  HARD_MAX_RECOVERY_SCAN_MILLISECONDS,
  HARD_MAX_RECOVERY_SOURCE_BYTES,
  HARD_MAX_RECOVERY_STARTUP_READ_BYTES,
} from "../src/state/recovery-contract.js";
import { openStateDatabases } from "../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../src/state/threads.js";

const DEFAULT_STRESS_EVENT_COUNT = 1_000_000;
const MAXIMUM_STRESS_EVENT_COUNT = DEFAULT_STRESS_EVENT_COUNT;
const GENERATION_BATCH_EVENTS = 2_000;
const MAXIMUM_RSS_GROWTH_KIB = 524_288;

const eventCount = stressEventCount(process.env.AGENC_RECOVERY_STRESS_EVENTS);
const root = mkdtempSync(join(tmpdir(), "agenc-recovery-million-"));
let driver: ReturnType<typeof openStateDatabases> | undefined;

try {
  const cwd = join(root, "repository");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  driver = openStateDatabases({ cwd, agencHome: join(root, "state") });
  const sessionId = "million-event";
  const sessionDirectory = join(driver.projectDir, "sessions", sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const rolloutPath = join(
    sessionDirectory,
    `rollout-2026-08-01T00-00-00-000Z-${sessionId}.jsonl`,
  );
  writeJournal(rolloutPath, eventCount);

  const baselineMaxRssKib = process.resourceUsage().maxRSS;
  const startedAt = performance.now();
  const result = backfillPinnedRolloutFile({
    projectDir: driver.projectDir,
    sessionId,
    rolloutPath,
    threads: new StateThreadRepository(driver),
    limits: {
      maxSourceBytes: HARD_MAX_RECOVERY_SOURCE_BYTES,
      maxEvents: DEFAULT_STRESS_EVENT_COUNT,
      maxReadBytes: HARD_MAX_RECOVERY_STARTUP_READ_BYTES,
      maxScanMilliseconds: HARD_MAX_RECOVERY_SCAN_MILLISECONDS,
    },
  });
  const elapsedMilliseconds = Math.round(performance.now() - startedAt);
  const projected =
    driver
      .prepareState<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM thread_rollout_items",
      )
      .get()?.count ?? -1;
  const maxRssGrowthKib = Math.max(
    0,
    process.resourceUsage().maxRSS - baselineMaxRssKib,
  );

  if (
    result.itemsIndexed !== eventCount ||
    result.proof.recordCount !== eventCount ||
    projected !== eventCount
  ) {
    throw new Error(
      `million-event projection mismatch: result=${result.itemsIndexed} proof=${result.proof.recordCount} rows=${projected}`,
    );
  }
  if (Object.hasOwn(result.proof, "records")) {
    throw new Error("million-event projection exposed a retained record array");
  }
  if (maxRssGrowthKib > MAXIMUM_RSS_GROWTH_KIB) {
    throw new Error(
      `million-event projection RSS grew ${maxRssGrowthKib} KiB; limit=${MAXIMUM_RSS_GROWTH_KIB} KiB`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      eventCount,
      projected,
      elapsedMilliseconds,
      maxRssGrowthKib,
      maximumRssGrowthKib: MAXIMUM_RSS_GROWTH_KIB,
      sourceByteLength: result.proof.sourceByteLength,
      sourceSha256: result.proof.sourceSha256,
    })}\n`,
  );
} finally {
  driver?.close();
  rmSync(root, { recursive: true, force: true });
}

function writeJournal(path: string, count: number): void {
  const fd = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    for (let first = 1; first <= count; first += GENERATION_BATCH_EVENTS) {
      const last = Math.min(count, first + GENERATION_BATCH_EVENTS - 1);
      const lines: string[] = [];
      for (let sequence = first; sequence <= last; sequence += 1) {
        lines.push(event(sequence));
      }
      writeComplete(fd, Buffer.from(lines.join(""), "utf8"));
    }
  } finally {
    closeSync(fd);
  }
}

function writeComplete(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0)
      throw new Error("failed to generate recovery stress journal");
    offset += written;
  }
}

function event(sequence: number): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      eventId: `event:${sequence}`,
      id: `e${sequence}`,
      seq: sequence,
      msg: { type: "turn_started", payload: { turnId: "stress" } },
    },
    eventVersion: 1,
  })}\n`;
}

function stressEventCount(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_STRESS_EVENT_COUNT : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAXIMUM_STRESS_EVENT_COUNT
  ) {
    throw new TypeError(
      `AGENC_RECOVERY_STRESS_EVENTS must be an integer in [1, ${MAXIMUM_STRESS_EVENT_COUNT}]`,
    );
  }
  return value;
}
