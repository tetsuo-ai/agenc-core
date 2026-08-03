import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { PersistentMemoryIndex } from "../../src/memory/full-corpus-index.js";
import { MemoryQueryProcessPool } from "../../src/memory/memory-query-pool.js";

interface HeldOutContract {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly newestBaselineSize: number;
  readonly minimumFullCorpusTop1Recall: number;
  readonly maximumPrecisionRegression: number;
  readonly cases: readonly {
    readonly id: string;
    readonly queryTerms: readonly string[];
    readonly title: string;
    readonly description: string;
  }[];
}

const heldOutPath = fileURLToPath(
  new URL("../../benchmarks/memory-index/held-out.v1.json", import.meta.url),
);
const helperEntrypoint = fileURLToPath(
  new URL("../../src/memory/memory-query-helper.mjs", import.meta.url),
);

let temporaryRoot = "";
let index: PersistentMemoryIndex | undefined;

afterEach(async () => {
  index?.close();
  index = undefined;
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

describe("C3b held-out full-corpus relevance gate", () => {
  it("dominates newest-200 old-memory recall without precision regression", async () => {
    const contract = JSON.parse(
      await readFile(heldOutPath, "utf8"),
    ) as HeldOutContract;
    expect(contract).toMatchObject({
      schemaVersion: 1,
      suiteId: "agenc-memory-relevance-v1",
      newestBaselineSize: 200,
    });
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-memory-held-out-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    const relevantPaths = new Map<string, string>();
    for (const testCase of contract.cases) {
      const path = join(memoryRoot, `${testCase.id}.md`);
      await writeFile(
        path,
        memoryDocument(testCase.title, testCase.description),
      );
      await utimes(path, oldTime, oldTime);
      relevantPaths.set(testCase.id, path);
    }
    for (let distractor = 0; distractor < 220; distractor += 1) {
      await writeFile(
        join(memoryRoot, `recent-${distractor.toString().padStart(3, "0")}.md`),
        memoryDocument(`Recent ${distractor}`, "unrelated compiler note"),
      );
    }
    index = new PersistentMemoryIndex({
      databasePath: join(stateRoot, "memory.sqlite"),
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const roots = [{ path: memoryRoot, role: "global" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });

    let fullCorpusHits = 0;
    let preciseHits = 0;
    for (const testCase of contract.cases) {
      const result = await index.query(
        roots,
        testCase.queryTerms,
        new AbortController().signal,
      );
      const expected = relevantPaths.get(testCase.id);
      if (result.candidates[0]?.canonicalPath === expected) fullCorpusHits += 1;
      if (result.candidates.length === 1) preciseHits += 1;
    }
    const recall = fullCorpusHits / contract.cases.length;
    const precision = preciseHits / contract.cases.length;
    const newest200Recall = 0;
    expect(recall).toBeGreaterThan(newest200Recall);
    expect(recall).toBeGreaterThanOrEqual(contract.minimumFullCorpusTop1Recall);
    expect(1 - precision).toBeLessThanOrEqual(
      contract.maximumPrecisionRegression,
    );
  });
});

function memoryDocument(title: string, description: string): string {
  return `---\ntitle: ${title}\ndescription: ${description}\ntype: reference\n---\nBody.\n`;
}
