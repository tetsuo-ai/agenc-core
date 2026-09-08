import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { writeDurableAtomicFile } from "../utils/durable-atomic-file.js";
import { asRecord } from "../utils/record.js";
import { acquireLocalSqliteLock, assertLocalPrivateFile } from "../utils/sqlite-lock.js";

interface DailyMediaUsage {
  readonly day: string;
  readonly count: number;
}

function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const midnight = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(midnight) &&
    new Date(midnight).toISOString().slice(0, 10) === value;
}

async function readDailyMediaUsage(path: string): Promise<DailyMediaUsage | undefined> {
  let serialized: string;
  try {
    await assertLocalPrivateFile(path, { timeoutMs: 5_000, label: "media quota ledger" });
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const state = asRecord(JSON.parse(serialized) as unknown);
  const day = state?.day;
  const count = state?.count;
  if (!isUtcDay(day) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Invalid media quota ledger; preserve it for recovery");
  }
  return { day, count };
}

export async function reserveDailyMediaQuota(options: {
  readonly usageFile: string;
  readonly dailyLimit: number;
  readonly now: () => number;
}): Promise<boolean> {
  if (!Number.isSafeInteger(options.dailyLimit) || options.dailyLimit < 0) {
    throw new Error("Daily media limit must be a nonnegative safe integer");
  }
  const requestedPath = resolve(options.usageFile);
  await mkdir(dirname(requestedPath), { recursive: true, mode: 0o700 });
  const directory = await realpath(dirname(requestedPath));
  const path = join(directory, basename(requestedPath));
  const release = await acquireLocalSqliteLock(`${path}.lock.sqlite`, {
    timeoutMs: 5_000,
    label: "media quota reservation",
  });
  try {
    const today = new Date(options.now()).toISOString().slice(0, 10);
    const usage = await readDailyMediaUsage(path);
    const day = usage !== undefined && usage.day > today ? usage.day : today;
    const count = usage?.day === day ? usage.count : 0;
    if (count >= options.dailyLimit) return false;
    await writeDurableAtomicFile(
      path,
      `${path}.${randomUUID()}.tmp`,
      `${JSON.stringify({ day, count: count + 1 }, null, 2)}\n`,
    );
    return true;
  } finally {
    release();
  }
}
