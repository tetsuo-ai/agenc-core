import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findRelevantMemories } from "../../src/memory/find-relevant.js";
import type {
  AdmittedMemorySelector,
  MemorySelectorRequest,
} from "../../src/memory/recall-contract.js";

let temporaryRoot = "";

afterEach(async () => {
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

async function memory(
  root: string,
  name: string,
  title: string,
  description: string,
): Promise<string> {
  const path = join(root, name);
  await writeFile(
    path,
    [
      "---",
      `name: ${title}`,
      `description: ${description}`,
      "type: user",
      "---",
      "body",
    ].join("\n"),
    "utf8",
  );
  return path;
}

describe("C3a relevant memory selection", () => {
  it("restores production lexical recall without sideQuery authority", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    const matching = await memory(
      temporaryRoot,
      "browser.md",
      "Browser automation",
      "Known browser launch gotchas",
    );
    await memory(temporaryRoot, "cooking.md", "Braising", "Cooking notes");

    const result = await findRelevantMemories(
      "browser automation",
      temporaryRoot,
      new AbortController().signal,
    );

    expect(result.map((entry) => entry.path)).toEqual([matching]);
  });

  it("passes only opaque candidates and accepts a validated selector subset", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    await memory(temporaryRoot, "alpha.md", "Alpha browser", "Browser notes");
    const beta = await memory(
      temporaryRoot,
      "beta.md",
      "Beta browser",
      "Browser warning",
    );
    let observed: MemorySelectorRequest | undefined;
    const selector: AdmittedMemorySelector = {
      select: vi.fn(async (request) => {
        observed = request;
        const betaCandidate = request.candidates.find(
          (candidate) => candidate.title === "Beta browser",
        );
        if (betaCandidate === undefined) {
          throw new Error("expected the beta memory in the admitted candidates");
        }
        return { kind: "selected", candidateIds: [betaCandidate.id] };
      }),
    };

    const result = await findRelevantMemories({
      query: "browser",
      memoryDirs: [temporaryRoot],
      signal: new AbortController().signal,
      admittedMemorySelector: selector,
    });

    expect(result.map((entry) => entry.path)).toEqual([beta]);
    expect(observed?.policy).toBe("agenc.memory-selector.v1");
    expect(
      observed?.candidates.map((candidate) => candidate.id).sort(),
    ).toEqual(["candidate-1", "candidate-2"]);
    expect(JSON.stringify(observed)).not.toContain(temporaryRoot);
  });

  it("uses lexical fallback for invented, duplicate, failed, or malformed selection", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    const lexical = await memory(
      temporaryRoot,
      "exact.md",
      "exact browser automation",
      "Preferred",
    );
    await memory(temporaryRoot, "other.md", "browser", "Secondary");
    const outcomes = [
      { kind: "selected", candidateIds: ["invented"] } as const,
      { kind: "selected", candidateIds: ["candidate-1", "candidate-1"] } as const,
      { kind: "malformed" } as const,
      { kind: "timeout" } as const,
      { kind: "unavailable" } as const,
    ];

    for (const outcome of outcomes) {
      const result = await findRelevantMemories({
        query: "browser automation",
        memoryDirs: [temporaryRoot],
        signal: new AbortController().signal,
        admittedMemorySelector: { select: async () => outcome },
      });
      expect(result[0]?.path).toBe(lexical);
    }
  });

  it("honors a valid empty selection but never invokes the selector at session start", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    await mkdir(join(temporaryRoot, "nested"));
    const recent = await memory(
      temporaryRoot,
      "recent.md",
      "Recent",
      "Session context",
    );
    const select = vi.fn(async () => ({
      kind: "selected" as const,
      candidateIds: [],
    }));
    const selector: AdmittedMemorySelector = { select };

    await expect(
      findRelevantMemories({
        query: "session",
        memoryDirs: [temporaryRoot],
        signal: new AbortController().signal,
        admittedMemorySelector: selector,
      }),
    ).resolves.toEqual([]);
    const sessionStart = await findRelevantMemories({
      query: "",
      mode: "session_start",
      memoryDirs: [temporaryRoot],
      signal: new AbortController().signal,
      admittedMemorySelector: selector,
    });
    expect(sessionStart.map((entry) => entry.path)).toEqual([recent]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("propagates the original abort reason across the selector layer", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    await memory(temporaryRoot, "browser.md", "Browser", "Browser notes");
    const controller = new AbortController();
    const reason = new Error("stop selector");
    const selector: AdmittedMemorySelector = {
      select: async () => {
        controller.abort(reason);
        throw reason;
      },
    };

    await expect(
      findRelevantMemories({
        query: "browser",
        memoryDirs: [temporaryRoot],
        signal: controller.signal,
        admittedMemorySelector: selector,
      }),
    ).rejects.toBe(reason);
  });

  it("clamps both lexical and selector paths to five memories", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    for (let index = 0; index < 8; index += 1) {
      await memory(
        temporaryRoot,
        `${index}.md`,
        `Browser ${index}`,
        "Browser automation",
      );
    }
    const signal = new AbortController().signal;
    const lexical = await findRelevantMemories("browser", temporaryRoot, signal);
    expect(lexical).toHaveLength(5);

    const selected = await findRelevantMemories({
      query: "browser",
      memoryDirs: [temporaryRoot],
      signal,
      admittedMemorySelector: {
        select: async () => ({
          kind: "selected",
          candidateIds: Array.from(
            { length: 8 },
            (_, index) => `candidate-${index + 1}`,
          ),
        }),
      },
    });
    expect(selected).toHaveLength(5);
  });
});
