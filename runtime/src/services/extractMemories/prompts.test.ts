import { describe, expect, it } from "vitest";
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  parseMemoryType,
} from "../../memdir/memory-types.js";
import { buildExtractAutoOnlyPrompt } from "./prompts.js";

describe("memory extraction prompt", () => {
  it("builds the source-aligned auto-memory extraction prompt", () => {
    const prompt = buildExtractAutoOnlyPrompt(
      3,
      "[feedback] feedback.md - testing guidance",
    );

    expect(prompt).toContain("~3 model-visible messages");
    expect(prompt).toContain("## Existing memory files");
    expect(prompt).toContain("[feedback] feedback.md - testing guidance");
    expect(prompt).toContain("FileRead, Grep, Glob");
    expect(prompt).toContain("Write/Edit/MultiEdit");
    expect(prompt).toContain("<name>feedback</name>");
    expect(prompt).toContain("## What NOT to save in memory");
    expect(prompt).toContain("Anything already documented in AGENC.md files.");
    expect(prompt).toContain("MEMORY.md` is an index");
    expect(prompt).toContain("urn:agenc:reference:api-latency-dashboard");
    expect(prompt).not.toMatch(/\b[a-z0-9-]+\.internal\b/iu);
    expect(prompt).not.toMatch(/https?:\/\//iu);
  });

  it("omits index instructions when the memory index is disabled", () => {
    const prompt = buildExtractAutoOnlyPrompt(1, "", true);

    expect(prompt).toContain("Write each memory to its own file");
    expect(prompt).not.toContain("add a pointer to that file in `MEMORY.md`");
    expect(prompt).not.toContain("MEMORY.md` is an index");
  });

  it("does not render existing memory files for empty manifests", () => {
    expect(buildExtractAutoOnlyPrompt(1, "")).not.toContain(
      "## Existing memory files",
    );
    expect(buildExtractAutoOnlyPrompt(1, " \n\t ")).not.toContain(
      "## Existing memory files",
    );
  });

  it("keeps the frontmatter taxonomy closed and parseable", () => {
    expect(MEMORY_FRONTMATTER_EXAMPLE.join("\n")).toContain(
      "type: {{user, feedback, project, reference}}",
    );
    expect(parseMemoryType("user")).toBe("user");
    expect(parseMemoryType("feedback")).toBe("feedback");
    expect(parseMemoryType("project")).toBe("project");
    expect(parseMemoryType("reference")).toBe("reference");
    expect(parseMemoryType("daily-log")).toBeUndefined();
    expect(parseMemoryType(undefined)).toBeUndefined();
  });
});
