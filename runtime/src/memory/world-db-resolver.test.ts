import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveWorldDbPath, resolveWorldVectorDbPath } from "./world-db-resolver.js";

describe("resolveWorldDbPath", () => {
  const testHome = "/tmp/test-agenc-home";

  it("returns default memory.db when worldId is undefined", () => {
    const path = resolveWorldDbPath(undefined, testHome);
    expect(path).toBe(join(testHome, "memory.db"));
  });

  it("returns default memory.db when worldId is 'default'", () => {
    const path = resolveWorldDbPath("default", testHome);
    expect(path).toBe(join(testHome, "memory.db"));
  });

  it("returns per-world path for a named world", () => {
    const path = resolveWorldDbPath("my-world", testHome);
    expect(path).toBe(join(testHome, "worlds", "my-world", "memory.db"));
  });

  it("sanitizes path traversal attempts", () => {
    const path = resolveWorldDbPath("../../etc/passwd", testHome);
    expect(path).not.toContain("..");
    expect(path).toContain("worlds");
    expect(path).toContain("memory.db");
  });

  it("sanitizes special characters", () => {
    const path = resolveWorldDbPath("world/with:special<chars>", testHome);
    expect(path).not.toContain("/with");
    expect(path).not.toContain(":");
    expect(path).not.toContain("<");
    expect(path).not.toContain(">");
  });

  it("truncates overly long worldIds to 128 chars", () => {
    const longId = "a".repeat(256);
    const path = resolveWorldDbPath(longId, testHome);
    const worldSegment = path.split("/worlds/")[1]?.split("/")[0];
    expect(worldSegment!.length).toBeLessThanOrEqual(128);
  });

  it("allows hyphens, underscores, dots, and alphanumeric", () => {
    const path = resolveWorldDbPath("my-world_v2.0", testHome);
    expect(path).toContain("my-world_v2.0");
  });

  it("collapses consecutive dots", () => {
    const path = resolveWorldDbPath("world...name", testHome);
    expect(path).not.toContain("...");
  });
});

describe("resolveWorldVectorDbPath", () => {
  const testHome = "/tmp/test-agenc-home";

  it("returns default vectors.db when worldId is undefined", () => {
    const path = resolveWorldVectorDbPath(undefined, testHome);
    expect(path).toBe(join(testHome, "vectors.db"));
  });

  it("returns per-world vectors.db for a named world", () => {
    const path = resolveWorldVectorDbPath("my-world", testHome);
    expect(path).toBe(join(testHome, "worlds", "my-world", "vectors.db"));
  });
});
