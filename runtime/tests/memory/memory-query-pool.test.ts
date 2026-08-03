import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_MEMORY_QUERY_PROCESSES,
  MAX_MEMORY_QUERY_QUEUE,
  MemoryIndexQueryResourceLimitedError,
} from "../../src/memory/full-corpus-contract.js";
import { MemoryQueryProcessPool } from "../../src/memory/memory-query-pool.js";

let temporaryRoot = "";

afterEach(async () => {
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

describe("C3b bounded memory query process pool", () => {
  it("kills a nonreturning helper at the wall deadline", async () => {
    const helper = await writeHelper(
      `process.stdin.resume();\nfor await (const _chunk of process.stdin) {}\nsetInterval(() => {}, 1000);\n`,
    );
    const pool = new MemoryQueryProcessPool({
      helperEntrypoint: helper,
      timeoutMs: 25,
    });

    await expect(
      pool.query(queryRequest(), new AbortController().signal),
    ).rejects.toBeInstanceOf(MemoryIndexQueryResourceLimitedError);
  });

  it("fails the exact first request beyond the four-process and 64-waiter bounds", async () => {
    const helper = await writeHelper(
      `process.stdin.resume();\nfor await (const _chunk of process.stdin) {}\nsetInterval(() => {}, 1000);\n`,
    );
    const pool = new MemoryQueryProcessPool({
      helperEntrypoint: helper,
      timeoutMs: 5_000,
    });
    const controller = new AbortController();
    const admitted = Array.from(
      { length: MAX_MEMORY_QUERY_PROCESSES + MAX_MEMORY_QUERY_QUEUE },
      () =>
        pool.query(queryRequest(), controller.signal).catch((error) => error),
    );

    await expect(pool.query(queryRequest(), controller.signal)).rejects.toThrow(
      "queue is full",
    );
    controller.abort(new Error("release bounded query fixture"));
    await Promise.all(admitted);
  });

  it("rejects an output overrun without parsing a timing-dependent prefix", async () => {
    const helper = await writeHelper(
      `process.stdin.resume();\nfor await (const _chunk of process.stdin) {}\nprocess.stdout.write(Buffer.alloc(1_048_581, 97));\n`,
    );
    const pool = new MemoryQueryProcessPool({ helperEntrypoint: helper });

    await expect(
      pool.query(queryRequest(), new AbortController().signal),
    ).rejects.toBeInstanceOf(MemoryIndexQueryResourceLimitedError);
  });
});

async function writeHelper(source: string): Promise<string> {
  if (temporaryRoot === "") {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-memory-helper-"));
  }
  const path = join(
    temporaryRoot,
    `helper-${Math.random().toString(16).slice(2)}.mjs`,
  );
  await writeFile(path, source, "utf8");
  return path;
}

function queryRequest() {
  return {
    databasePath: "/bounded/test.sqlite",
    rootId: "root",
    generationId: 1,
    rootRole: "global" as const,
    match: '"term"',
    limit: 1,
  };
}
