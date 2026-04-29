import { describe, expect, test } from "vitest";
import {
  MEMORY_TYPES,
  parseFrontmatter,
  parseMemoryType,
  serializeMemory,
  type MemoryType,
} from "./types.js";

describe("parseMemoryType", () => {
  test("accepts each of the four canonical types", () => {
    for (const t of MEMORY_TYPES) {
      expect(parseMemoryType(t)).toBe(t);
    }
  });

  test("rejects unknown and non-string values", () => {
    expect(parseMemoryType("nope")).toBeUndefined();
    expect(parseMemoryType(42)).toBeUndefined();
    expect(parseMemoryType(undefined)).toBeUndefined();
  });
});

describe("parseFrontmatter", () => {
  test("parses each of the 4 memory types end-to-end", () => {
    for (const t of MEMORY_TYPES) {
      const raw = `---\nname: demo\ndescription: a ${t}\ntype: ${t}\n---\nbody`;
      const parsed = parseFrontmatter(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.frontmatter.name).toBe("demo");
      expect(parsed!.frontmatter.description).toBe(`a ${t}`);
      expect(parsed!.frontmatter.type).toBe(t as MemoryType);
      expect(parsed!.body).toBe("body");
    }
  });

  test("strips surrounding quotes on values", () => {
    const raw = `---\nname: "Quoted Name"\ndescription: 'Single Q'\ntype: user\n---\nbody`;
    const parsed = parseFrontmatter(raw)!;
    expect(parsed.frontmatter.name).toBe("Quoted Name");
    expect(parsed.frontmatter.description).toBe("Single Q");
  });

  test("returns null for missing opening fence", () => {
    expect(parseFrontmatter("no fence here")).toBeNull();
  });

  test("returns null for unclosed fence", () => {
    const raw = `---\nname: x\ntype: user\nbody with no close`;
    expect(parseFrontmatter(raw)).toBeNull();
  });

  test("preserves unknown keys in `extra`", () => {
    const raw = `---\nname: demo\ntype: user\nauthor: alice\nscope: private\n---\nbody`;
    const parsed = parseFrontmatter(raw)!;
    expect(parsed.frontmatter.extra.author).toBe("alice");
    expect(parsed.frontmatter.extra.scope).toBe("private");
  });

  test("silently drops malformed key:value lines inside fence", () => {
    const raw = `---\nname: demo\nnoColonHere\ntype: user\n---\nbody`;
    const parsed = parseFrontmatter(raw)!;
    expect(parsed.frontmatter.name).toBe("demo");
    expect(parsed.frontmatter.type).toBe("user");
  });

  test("unknown type value degrades to undefined (legacy files work)", () => {
    const raw = `---\nname: legacy\ntype: something-else\n---\nbody`;
    const parsed = parseFrontmatter(raw)!;
    expect(parsed.frontmatter.type).toBeUndefined();
    expect(parsed.frontmatter.name).toBe("legacy");
  });
});

describe("serializeMemory", () => {
  test("round-trips the full frontmatter + body", () => {
    const raw = `---\nname: demo\ndescription: my desc\ntype: feedback\n---\nhello world\n`;
    const parsed = parseFrontmatter(raw)!;
    const serialized = serializeMemory(parsed);
    const reparsed = parseFrontmatter(serialized)!;
    expect(reparsed.frontmatter.name).toBe("demo");
    expect(reparsed.frontmatter.description).toBe("my desc");
    expect(reparsed.frontmatter.type).toBe("feedback");
    expect(reparsed.body).toBe("hello world");
  });

  test("emits extra keys in stable (alphabetical) order", () => {
    const text = serializeMemory({
      frontmatter: {
        name: "demo",
        type: "user",
        extra: { zebra: "z", alpha: "a", mid: "m" },
      },
      body: "b",
    });
    const aIdx = text.indexOf("alpha:");
    const mIdx = text.indexOf("mid:");
    const zIdx = text.indexOf("zebra:");
    expect(aIdx).toBeGreaterThan(-1);
    expect(mIdx).toBeGreaterThan(aIdx);
    expect(zIdx).toBeGreaterThan(mIdx);
  });
});
