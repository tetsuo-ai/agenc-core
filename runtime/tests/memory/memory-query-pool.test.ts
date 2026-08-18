import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_MEMORY_QUERY_PROCESSES,
  MAX_MEMORY_QUERY_QUEUE,
  MemoryIndexQueryResourceLimitedError,
  memoryIndexRootId,
  stableMemoryId,
} from "../../src/memory/full-corpus-contract.js";
import {
  decodeMemoryQueryResponseFrame,
  encodeMemoryQueryFrame,
  MEMORY_QUERY_HELPER_PROTOCOL_VERSION,
} from "../../src/memory/full-corpus-protocol.js";
import { MemoryQueryProcessPool } from "../../src/memory/memory-query-pool.js";

let temporaryRoot = "";

const helperEntrypoint = fileURLToPath(
  new URL("../../src/memory/memory-query-helper.mjs", import.meta.url),
);

afterEach(async () => {
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

describe("C3b bounded memory query process pool", () => {
  it("classifies a malformed protocol-v2 request as invalid_request", async () => {
    const child = spawn(process.execPath, [helperEntrypoint], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stdin.end(
      encodeMemoryQueryFrame({
        protocolVersion: MEMORY_QUERY_HELPER_PROTOCOL_VERSION,
      }),
    );
    const [exitCode] = await once(child, "close");

    expect(exitCode).toBe(1);
    expect(
      decodeMemoryQueryResponseFrame(Buffer.concat(output)),
    ).toMatchObject({
      kind: "error",
      code: "invalid_request",
    });
  });

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

  it("rejects a valid candidate outside the requested generation", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-memory-helper-"));
    const canonicalPath = join(temporaryRoot, "wire.md").normalize("NFC");
    const rootPath = temporaryRoot.normalize("NFC");
    const rootId = memoryIndexRootId(rootPath);
    const response = {
      protocolVersion: MEMORY_QUERY_HELPER_PROTOCOL_VERSION,
      kind: "ok",
      candidates: [
        {
          memoryId: stableMemoryId(canonicalPath),
          generationId: 1,
          canonicalPath,
          title: "Wire",
          description: "wire",
          type: null,
          mtimeMs: 1,
          size: 1,
          fingerprint: "0".repeat(64),
          rootId,
          rootRole: "global",
          bm25Score: -1,
          headerSnapshot: {
            relativePath: "wire.md",
            fileDev: "1",
            fileIno: "1",
            fileMode: "33188",
            fileMtimeNs: "1",
            fileCtimeNs: "1",
            rootDev: "1",
            rootIno: "2",
            rootMode: "16877",
            rootSize: "4096",
            rootMtimeNs: "1",
            rootCtimeNs: "1",
          },
        },
      ],
    };
    const serialized = JSON.stringify(response);
    const helper = await writeHelper(
      `process.stdin.resume();
for await (const _chunk of process.stdin) {}
const payload = Buffer.from(${JSON.stringify(serialized)}, "utf8");
const frame = Buffer.allocUnsafe(4 + payload.byteLength);
frame.writeUInt32BE(payload.byteLength, 0);
payload.copy(frame, 4);
process.stdout.write(frame);
`,
    );
    const pool = new MemoryQueryProcessPool({ helperEntrypoint: helper });

    await expect(
      pool.query(
        {
          databasePath: join(temporaryRoot, "unused.sqlite"),
          rootId,
          generationId: 2,
          rootRole: "global",
          match: '"wire"',
          limit: 1,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("outside its bound generation");
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
