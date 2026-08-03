import { describe, expect, it } from "vitest";

import { __agencBuildConfigTest } from "../../build.config.js";
import { resolveDefaultMemoryQueryHelperEntrypoint } from "../../src/memory/memory-query-pool.js";

describe("C3b memory query helper packaging", () => {
  it("ships the killable helper as its own runtime entrypoint", () => {
    expect(__agencBuildConfigTest.entry).toContain(
      "src/memory/memory-query-helper.mjs",
    );
  });

  it("resolves both source and root-chunk packaged layouts", () => {
    expect(resolveDefaultMemoryQueryHelperEntrypoint()).toMatch(
      /memory-query-helper\.mjs$/u,
    );
    expect(
      resolveDefaultMemoryQueryHelperEntrypoint(
        new URL("../../dist/chunk-memory-index.js", import.meta.url).href,
      ),
    ).toMatch(/dist[/\\]memory[/\\]memory-query-helper\.js$/u);
  });
});
