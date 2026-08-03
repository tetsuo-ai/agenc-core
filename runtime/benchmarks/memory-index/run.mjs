#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PersistentMemoryIndex } from "../../src/memory/full-corpus-index.ts";
import { MemoryQueryProcessPool } from "../../src/memory/memory-query-pool.ts";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(benchmarkRoot, "../..");
const execFileAsync = promisify(execFile);
const helperEntrypoint = join(
  benchmarkRoot,
  "../../src/memory/memory-query-helper.mjs",
);
const full = process.argv.includes("--full");
const sizes = full ? [10_000, 100_000, 1_000_000] : [1_000];
const querySamples = full ? 100 : 10;
const points = [];

for (const size of sizes) {
  points.push(await benchmarkSize(size, querySamples));
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      suiteId: "agenc-memory-index-scaling-v1",
      profile: full ? "full" : "quick",
      points,
    },
    null,
    2,
  )}\n`,
);

async function benchmarkSize(size, samples) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agenc-memory-benchmark-"),
  );
  const memoryRoot = join(temporaryRoot, "memory");
  const stateRoot = join(temporaryRoot, "state");
  await mkdir(memoryRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const index = new PersistentMemoryIndex({
    databasePath: join(stateRoot, "memory.sqlite"),
    queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
  });
  let indexClosed = false;
  const roots = [{ path: memoryRoot, role: "global" }];
  try {
    const generationStarted = performance.now();
    await generateCorpus(memoryRoot, size);
    const generationMs = performance.now() - generationStarted;
    const buildStarted = performance.now();
    let refresh = await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    while (refresh.kind === "refresh_pending") {
      refresh = await index.refresh(roots, new AbortController().signal, {
        explicit: true,
      });
    }
    if (refresh.kind !== "complete") {
      throw new Error(
        `memory benchmark build did not complete: ${refresh.kind}`,
      );
    }
    const buildMs = performance.now() - buildStarted;

    const queryDurations = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const started = performance.now();
      const result = await index.query(
        roots,
        [`needle${sample % Math.max(1, Math.min(size, 100))}`],
        new AbortController().signal,
      );
      if (result.kind !== "complete" && result.kind !== "stale") {
        throw new Error(`memory benchmark query failed: ${result.kind}`);
      }
      queryDurations.push(performance.now() - started);
    }

    const updatePath = join(memoryRoot, "shard-0000", "memory-00000000.md");
    const incrementalStarted = performance.now();
    await writeFile(
      updatePath,
      memoryDocument("Updated benchmark memory", "incrementalneedle"),
    );
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: join("shard-0000", "memory-00000000.md"),
      kind: "update",
    });
    const incremental = await index.refresh(
      roots,
      new AbortController().signal,
      { explicit: false },
    );
    if (incremental.kind !== "complete") {
      throw new Error(
        `incremental memory build did not complete: ${incremental.kind}`,
      );
    }
    const incrementalUpdateMs = performance.now() - incrementalStarted;

    const watchedPath = join(memoryRoot, "shard-0000", "memory-00000001.md");
    const watcherStarted = performance.now();
    await writeFile(
      watchedPath,
      memoryDocument("Watched benchmark memory", "watcherneedle"),
    );
    await waitForQuery(index, roots, "watcherneedle");
    const watcherEventMs = performance.now() - watcherStarted;

    const auditStarted = performance.now();
    await index.auditSlice(roots[0], new AbortController().signal);
    const auditSliceMs = performance.now() - auditStarted;

    const contentionChanges = Math.min(size, 1_000);
    for (let ordinal = 0; ordinal < contentionChanges; ordinal += 1) {
      index.recordChange({
        rootPath: memoryRoot,
        relativePath: join(
          "shard-0000",
          `memory-${ordinal.toString().padStart(8, "0")}.md`,
        ),
        kind: "update",
      });
    }
    index.close();
    indexClosed = true;
    const contentionStarted = performance.now();
    const contention = await Promise.all([
      runWriterContender(index.databasePath, memoryRoot),
      runWriterContender(index.databasePath, memoryRoot),
    ]);
    const writerContentionMs = performance.now() - contentionStarted;
    const writerContentionPendingCount = contention.filter(
      (result) => result.kind === "refresh_pending",
    ).length;

    queryDurations.sort((left, right) => left - right);
    return {
      size,
      generationMs,
      buildMs,
      incrementalUpdateMs,
      watcherEventMs,
      auditSliceMs,
      writerContentionMs,
      writerContentionPendingCount,
      queryP50Ms: percentile(queryDurations, 0.5),
      queryP95Ms: percentile(queryDurations, 0.95),
      rssBytes: process.memoryUsage().rss,
      databaseBytes: (await stat(join(stateRoot, "memory.sqlite"))).size,
    };
  } finally {
    if (!indexClosed) index.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runWriterContender(databasePath, memoryRoot) {
  const contender = join(benchmarkRoot, "writer-contender.mjs");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", contender, databasePath, memoryRoot, helperEntrypoint],
    {
      cwd: runtimeRoot,
      encoding: "utf8",
      maxBuffer: 1_048_576,
      timeout: 60_000,
    },
  );
  return JSON.parse(stdout);
}

async function waitForQuery(index, roots, term) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const result = await index.query(
      roots,
      [term],
      new AbortController().signal,
    );
    if (result.candidates.length > 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("memory benchmark watcher did not converge");
}

async function generateCorpus(memoryRoot, size) {
  const shardSize = 1_000;
  for (let start = 0; start < size; start += shardSize) {
    const shard = join(
      memoryRoot,
      `shard-${Math.floor(start / shardSize)
        .toString()
        .padStart(4, "0")}`,
    );
    await mkdir(shard, { recursive: true });
    const writes = [];
    for (
      let index = start;
      index < Math.min(size, start + shardSize);
      index += 1
    ) {
      writes.push(
        writeFile(
          join(shard, `memory-${index.toString().padStart(8, "0")}.md`),
          memoryDocument(`Benchmark memory ${index}`, `needle${index % 100}`),
        ),
      );
    }
    await Promise.all(writes);
  }
}

function memoryDocument(title, description) {
  return `---\ntitle: ${title}\ndescription: ${description}\ntype: reference\n---\nBody.\n`;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  return values[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ];
}
