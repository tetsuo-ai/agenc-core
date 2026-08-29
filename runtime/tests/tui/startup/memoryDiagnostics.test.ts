import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  MAX_MEMORY_CHARACTER_COUNT,
  type MemoryFileInfo,
} from "../../memory/index.js";
import { formatLargeMemoryDiagnostics } from "./memoryDiagnostics.js";

function memoryFile(path: string, contentLength: number): MemoryFileInfo {
  return {
    path,
    type: "Project",
    content: "x".repeat(contentLength),
  };
}

describe("startup memory diagnostics", () => {
  test("warns only above the canonical size threshold with the live message", () => {
    const path = join(process.cwd(), "AGENTS.md");

    expect(
      formatLargeMemoryDiagnostics([
        memoryFile(path, MAX_MEMORY_CHARACTER_COUNT),
      ]),
    ).toEqual([]);

    const diagnostics = formatLargeMemoryDiagnostics([
      memoryFile(path, MAX_MEMORY_CHARACTER_COUNT + 10_000),
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(
      "Large AGENTS.md will impact performance",
    );
    expect(diagnostics[0]).toContain("50.0k chars > 40.0k");
  });
});
