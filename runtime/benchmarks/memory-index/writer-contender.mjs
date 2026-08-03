#!/usr/bin/env node

import process from "node:process";

import { PersistentMemoryIndex } from "../../src/memory/full-corpus-index.ts";
import { MemoryQueryProcessPool } from "../../src/memory/memory-query-pool.ts";

const [databasePath, memoryRoot, helperEntrypoint] = process.argv.slice(2);
if (!databasePath || !memoryRoot || !helperEntrypoint) {
  throw new Error(
    "writer contender requires database, root, and query helper paths",
  );
}

const index = new PersistentMemoryIndex({
  databasePath,
  backgroundRefresh: false,
  queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
});

try {
  const result = await index.refresh(
    [{ path: memoryRoot, role: "global" }],
    new AbortController().signal,
  );
  process.stdout.write(
    `${JSON.stringify({
      kind: result.kind,
      reasons: result.roots.flatMap((root) =>
        root.reason === undefined ? [] : [root.reason],
      ),
    })}\n`,
  );
} finally {
  index.close();
}
