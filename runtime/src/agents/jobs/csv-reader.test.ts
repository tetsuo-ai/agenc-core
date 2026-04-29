import { describe, expect, it } from "vitest";
import { parseCsv, writeCsv, CsvParseError } from "./csv-reader.js";

describe("parseCsv", () => {
  it("parses a simple header + row CSV", () => {
    const doc = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(doc.headers).toEqual(["a", "b", "c"]);
    expect(doc.rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5", c: "6" },
    ]);
  });

  it("treats quoted fields as a single token, including embedded commas", () => {
    const doc = parseCsv('a,b\n"hello, world",x\n');
    expect(doc.rows).toEqual([{ a: "hello, world", b: "x" }]);
  });

  it("preserves embedded newlines inside quoted fields", () => {
    const doc = parseCsv('a\n"line1\nline2"\n');
    expect(doc.rows).toEqual([{ a: "line1\nline2" }]);
  });

  it("decodes a doubled quote as a literal quote", () => {
    const doc = parseCsv('a\n"he said ""hi"""\n');
    expect(doc.rows).toEqual([{ a: 'he said "hi"' }]);
  });

  it("preserves trailing empty fields as empty strings", () => {
    const doc = parseCsv("a,b,c\n1,,\n");
    expect(doc.rows).toEqual([{ a: "1", b: "", c: "" }]);
  });

  it("throws on an unterminated quoted field", () => {
    expect(() => parseCsv('a\n"no close')).toThrow(CsvParseError);
  });

  it("strips a UTF-8 BOM from the first header cell", () => {
    const doc = parseCsv("﻿id,value\n1,a\n");
    expect(doc.headers).toEqual(["id", "value"]);
  });

  it("skips rows where every field is empty (matches codex)", () => {
    const doc = parseCsv("a,b\n1,2\n,\n3,4\n");
    expect(doc.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });
});

describe("writeCsv", () => {
  it("round-trips simple input", () => {
    const text = writeCsv({
      headers: ["a", "b"],
      rows: [{ a: "1", b: "2" }],
    });
    expect(text).toBe("a,b\n1,2\n");
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    const text = writeCsv({
      headers: ["x", "y"],
      rows: [{ x: 'has "q"', y: "has,comma" }],
    });
    expect(text).toBe('x,y\n"has ""q""","has,comma"\n');
  });
});
