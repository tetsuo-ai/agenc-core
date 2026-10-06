import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  closeFullCorpusMemoryIndexes,
  findRelevantMemories,
} from "../src/memory/find-relevant.js";
import { MAX_MEMORY_QUERY_RESULT_BYTES } from "../src/memory/full-corpus-contract.js";
import { PersistentMemoryIndex } from "../src/memory/full-corpus-index.js";
import {
  encodeMemoryQueryFrame,
  MEMORY_QUERY_FRAME_HEADER_BYTES,
  MEMORY_QUERY_HELPER_PROTOCOL_VERSION,
} from "../src/memory/full-corpus-protocol.js";
import {
  MemoryQueryProcessPool,
  resolveDefaultMemoryQueryHelperEntrypoint,
} from "../src/memory/memory-query-pool.js";
import { scrubEnvForChildProcess } from "../src/unified-exec/scrub-env.js";
import { runSupervisedProcess } from "../src/utils/supervisedProcess.js";

// Run with HOME and TMPDIR under /private/tmp. The helper measurement includes
// process startup, IPC and SQL; the Node startup sample estimates its spawn
// portion without changing the production helper.
const samples = {
  recall: [] as number[],
  refresh: [] as number[],
  query: [] as number[],
  helper: [] as number[],
};
const states = { refresh: [] as string[], query: [] as string[] };
const originalRefresh = PersistentMemoryIndex.prototype.refresh;
const originalQuery = PersistentMemoryIndex.prototype.query;
const originalHelper = MemoryQueryProcessPool.prototype.query;

PersistentMemoryIndex.prototype.refresh = async function (...args) {
  const start = performance.now();
  try {
    const result = await originalRefresh.apply(this, args);
    states.refresh.push(result.kind);
    return result;
  } finally {
    samples.refresh.push(performance.now() - start);
  }
};
PersistentMemoryIndex.prototype.query = async function (...args) {
  const start = performance.now();
  try {
    const result = await originalQuery.apply(this, args);
    states.query.push(result.kind);
    return result;
  } finally {
    samples.query.push(performance.now() - start);
  }
};
MemoryQueryProcessPool.prototype.query = async function (...args) {
  const start = performance.now();
  try {
    return await originalHelper.apply(this, args);
  } finally {
    samples.helper.push(performance.now() - start);
  }
};

const home = await mkdtemp(join(tmpdir(), "agenc-recall-bench-"));
const root = join(home, "memory");
try {
  await mkdir(root);
  await writeFile(join(root, "MEMORY.md"), "# Memory index\n", "utf8");
  for (let index = 0; index < 50; index += 1) {
    await writeFile(
      join(root, `note-${index}.md`),
      `---\nname: Browser note ${index}\ndescription: Browser workflow ${index}\ntype: user\n---\nBody ${index}\n`,
      "utf8",
    );
  }
  const signal = new AbortController().signal;
  for (let run = 0; run < 13; run += 1) {
    const start = performance.now();
    await findRelevantMemories({
      query: "browser",
      memoryDirs: [root],
      signal,
      memoryIndexDatabasePath: join(home, "state", "memory-v1.sqlite"),
    });
    samples.recall.push(performance.now() - start);
  }
  for (const [name, values] of Object.entries(samples)) {
    const warm = values.slice(1);
    const median = warm.length > 0 ? `${medianOf(warm).toFixed(2)}ms` : "skipped";
    const first = values.length > 0 ? `${values[0]!.toFixed(2)}ms` : "skipped";
    console.log(`${name}: first=${first} warm median=${median} n=${warm.length}`);
  }
  console.log(`index states: refresh=${states.refresh.join(",")} query=${states.query.join(",")}`);
  const startup: number[] = [];
  for (let run = 0; run < 8; run += 1) {
    const start = performance.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    startup.push(performance.now() - start);
  }
  console.log(`node startup proxy: median=${medianOf(startup).toFixed(2)}ms`);
  const helperStartup: number[] = [];
  const helperEntrypoint = resolveDefaultMemoryQueryHelperEntrypoint();
  for (let run = 0; run < 8; run += 1) {
    const start = performance.now();
    await runSupervisedProcess(
      {
        program: process.execPath,
        args: [helperEntrypoint],
        cwd: dirname(helperEntrypoint),
        env: scrubEnvForChildProcess(process.env),
      },
      {
        stdin: encodeMemoryQueryFrame({
          protocolVersion: MEMORY_QUERY_HELPER_PROTOCOL_VERSION,
        }),
        timeoutMs: 500,
        maxOutputBytes:
          MAX_MEMORY_QUERY_RESULT_BYTES + MEMORY_QUERY_FRAME_HEADER_BYTES,
      },
    );
    helperStartup.push(performance.now() - start);
  }
  console.log(`contained helper startup: median=${medianOf(helperStartup).toFixed(2)}ms`);
} finally {
  closeFullCorpusMemoryIndexes();
  await rm(home, { recursive: true, force: true });
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}
