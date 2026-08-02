import { describe, expect, test } from "vitest";

import {
  assertGrepArgumentEncoding,
  assertGrepArgvWithinLimits,
  createRipgrepWireParser,
  createRipgrepWireValidator,
  decodeRipgrepPathBytes,
  grepArgvUtf8Bytes,
  grepWindowsCommandLineUtf16CodeUnits,
  MAX_GREP_ARGV_UTF8_BYTES,
  MAX_GREP_WINDOWS_COMMAND_LINE_UTF16_CODE_UNITS,
  quoteWindowsCommandLineArgument,
  renderRipgrepContentBytes,
  renderRipgrepPathBytes,
  type GrepBoundaryError,
} from "./ripgrep-protocol.js";

function boundaryReason(error: unknown): string | undefined {
  return (error as GrepBoundaryError | undefined)?.reason;
}

function jsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function wireText(text: string): { readonly text: string } {
  return { text };
}

function begin(path: unknown): unknown {
  return { type: "begin", data: { path } };
}

function match(path: unknown, lines: unknown): unknown {
  return {
    type: "match",
    data: {
      path,
      lines,
      line_number: 1,
      absolute_offset: 0,
      submatches: [{ match: wireText("x"), start: 0, end: 1 }],
    },
  };
}

function context(path: unknown, lines: unknown): unknown {
  return {
    type: "context",
    data: {
      path,
      lines,
      line_number: 2,
      absolute_offset: 2,
      submatches: [],
    },
  };
}

function end(path: unknown): unknown {
  return { type: "end", data: { path } };
}

const summary = Object.freeze({ type: "summary", data: {} });

describe("ripgrep argv accounting", () => {
  test("matches libuv quoting for empty, spaces, quotes, and backslashes", () => {
    expect(quoteWindowsCommandLineArgument("")).toBe('""');
    expect(quoteWindowsCommandLineArgument("plain")).toBe("plain");
    expect(quoteWindowsCommandLineArgument("two words")).toBe('"two words"');
    expect(quoteWindowsCommandLineArgument('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsCommandLineArgument("two words\\")).toBe(
      '"two words\\\\"',
    );
    expect(quoteWindowsCommandLineArgument("line\nbreak")).toBe("line\nbreak");
  });

  test("counts non-BMP text as two UTF-16 code units", () => {
    expect(grepWindowsCommandLineUtf16CodeUnits("rg", ["😀"])).toBe(6);
  });

  test("accepts exactly 30,000 Windows code units and rejects 30,001", () => {
    const atBoundary = "a".repeat(
      MAX_GREP_WINDOWS_COMMAND_LINE_UTF16_CODE_UNITS - 4,
    );
    const overBoundary = `${atBoundary}a`;

    expect(grepWindowsCommandLineUtf16CodeUnits("rg", [atBoundary])).toBe(
      MAX_GREP_WINDOWS_COMMAND_LINE_UTF16_CODE_UNITS,
    );
    expect(() =>
      assertGrepArgvWithinLimits("rg", [atBoundary], "win32"),
    ).not.toThrow();
    expect(() =>
      assertGrepArgvWithinLimits("rg", [overBoundary], "win32"),
    ).toThrowError(
      expect.objectContaining({ reason: "WINDOWS_COMMAND_LINE_LIMIT" }),
    );
  });

  test("keeps the POSIX aggregate byte boundary independent", () => {
    const atBoundary = "a".repeat(MAX_GREP_ARGV_UTF8_BYTES - 3);
    expect(grepArgvUtf8Bytes("r", [atBoundary])).toBe(MAX_GREP_ARGV_UTF8_BYTES);
    expect(() =>
      assertGrepArgvWithinLimits("r", [atBoundary], "linux"),
    ).not.toThrow();
    expect(() =>
      assertGrepArgvWithinLimits("r", [`${atBoundary}a`], "linux"),
    ).toThrowError(expect.objectContaining({ reason: "ARGV_UTF8_LIMIT" }));
  });

  test("rejects NUL and lone surrogates before accounting", () => {
    expect(() => assertGrepArgumentEncoding("a\0b", "pattern")).toThrowError(
      expect.objectContaining({ reason: "ARGUMENT_NUL" }),
    );
    expect(() => assertGrepArgumentEncoding("\ud800", "pattern")).toThrowError(
      expect.objectContaining({ reason: "ARGUMENT_LONE_SURROGATE" }),
    );
    expect(() => assertGrepArgumentEncoding("\udc00", "pattern")).toThrowError(
      expect.objectContaining({ reason: "ARGUMENT_LONE_SURROGATE" }),
    );
    expect(() => assertGrepArgumentEncoding("😀", "pattern")).not.toThrow();
  });
});

describe("ripgrep files-with-matches protocol", () => {
  test("keeps control and invalid UTF-8 path bytes as exact records", () => {
    const paths = [
      Buffer.from("colon:name"),
      Buffer.from("new\nline"),
      Buffer.from("tab\tname"),
      Buffer.from([0x63, 0x74, 0x72, 0x6c, 0x01]),
      Buffer.from([0x62, 0x61, 0x64, 0xff]),
      Buffer.from("long-segment-".repeat(512)),
    ];
    const wire = Buffer.concat(
      paths.flatMap((path) => [path, Buffer.from([0])]),
    );
    const parser = createRipgrepWireParser("files_with_matches");
    for (let offset = 0; offset < wire.byteLength; offset += 7) {
      parser.push(wire.subarray(offset, offset + 7));
    }
    parser.finish();

    expect(parser.records.map((record) => record.path)).toEqual(paths);
    expect(renderRipgrepPathBytes(paths[1] as Buffer)).toBe("new\\nline");
    expect(renderRipgrepPathBytes(paths[4] as Buffer)).toBe(
      "bad\\xff [path-encoding=bytes]",
    );
  });

  test("preserves a leading UTF-8 BOM as record data", () => {
    const leadingBom = Buffer.from([0xef, 0xbb, 0xbf]);
    const path = Buffer.concat([leadingBom, Buffer.from("name.txt")]);
    const content = Buffer.concat([
      leadingBom,
      Buffer.from("needle\r\n", "utf8"),
    ]);

    expect(decodeRipgrepPathBytes(path)).toBe("\ufeffname.txt");
    expect(renderRipgrepPathBytes(path)).toBe("\ufeffname.txt");
    expect(renderRipgrepContentBytes(content)).toBe("\ufeffneedle");
  });

  test("rejects missing NUL and record boundary plus one", () => {
    const missingNul = createRipgrepWireParser("files_with_matches");
    missingNul.push(Buffer.from("path"));
    expect(() => missingNul.finish()).toThrowError(
      expect.objectContaining({ reason: "MISSING_NUL" }),
    );

    const atBoundary = createRipgrepWireParser("files_with_matches", {
      maxRecordBytes: 4,
    });
    atBoundary.push(Buffer.from("1234\0"));
    atBoundary.finish();
    expect(atBoundary.records).toHaveLength(1);

    const overBoundary = createRipgrepWireParser("files_with_matches", {
      maxRecordBytes: 4,
    });
    expect(() => overBoundary.push(Buffer.from("12345\0"))).toThrowError(
      expect.objectContaining({ reason: "RECORD_LIMIT" }),
    );
  });

  test("enforces decoded-byte and result boundaries", () => {
    const decoded = createRipgrepWireParser("files_with_matches", {
      maxDecodedBytes: 4,
    });
    decoded.push(Buffer.from("1234\0"));
    expect(() => decoded.push(Buffer.from("5\0"))).toThrowError(
      expect.objectContaining({ reason: "DECODED_OUTPUT_LIMIT" }),
    );

    const results = createRipgrepWireParser("files_with_matches", {
      maxResults: 1,
    });
    results.push(Buffer.from("a\0"));
    expect(() => results.push(Buffer.from("b\0"))).toThrowError(
      expect.objectContaining({ reason: "RESULT_LIMIT" }),
    );
  });
});

describe("ripgrep count protocol", () => {
  test("parses raw path NUL decimal newline without inventing fields", () => {
    const first = Buffer.from("colon:name\ncontrol\t");
    const second = Buffer.from([0x62, 0x61, 0x64, 0xfe]);
    const parser = createRipgrepWireParser("count");
    parser.push(
      Buffer.concat([
        first,
        Buffer.from("\0"),
        Buffer.from("123456789\n"),
        second,
        Buffer.from("\0"),
        Buffer.from("7\n"),
      ]),
    );
    parser.finish();

    expect(parser.records).toEqual([
      { kind: "count", path: first, count: 123456789 },
      { kind: "count", path: second, count: 7 },
    ]);
  });

  test("rejects missing delimiters, invalid decimals, and overflow", () => {
    const missingNul = createRipgrepWireParser("count");
    missingNul.push(Buffer.from("path"));
    expect(() => missingNul.finish()).toThrowError(
      expect.objectContaining({ reason: "MISSING_NUL" }),
    );

    const missingNewline = createRipgrepWireParser("count");
    missingNewline.push(
      Buffer.concat([Buffer.from("path"), Buffer.from([0]), Buffer.from("1")]),
    );
    expect(() => missingNewline.finish()).toThrowError(
      expect.objectContaining({ reason: "UNTERMINATED_RECORD" }),
    );

    const invalid = createRipgrepWireParser("count");
    expect(() =>
      invalid.push(
        Buffer.concat([
          Buffer.from("path"),
          Buffer.from([0]),
          Buffer.from("1x\n"),
        ]),
      ),
    ).toThrowError(expect.objectContaining({ reason: "INVALID_COUNT" }));

    const overflow = createRipgrepWireParser("count", {
      maxAggregateMatchCount: 10,
    });
    overflow.push(
      Buffer.concat([Buffer.from("a"), Buffer.from([0]), Buffer.from("6\n")]),
    );
    expect(() =>
      overflow.push(
        Buffer.concat([Buffer.from("b"), Buffer.from([0]), Buffer.from("5\n")]),
      ),
    ).toThrowError(expect.objectContaining({ reason: "COUNT_OVERFLOW" }));
  });

  test("validates without retaining skipped records", () => {
    const validator = createRipgrepWireValidator("count");
    validator.push(Buffer.from("valid.txt\x001\n", "utf8"));
    expect(validator.records).toEqual([]);
    expect(() =>
      validator.push(Buffer.from("skipped.txt\0not-decimal\n", "utf8")),
    ).toThrowError(expect.objectContaining({ reason: "INVALID_COUNT" }));
    expect(validator.records).toEqual([]);
  });
});

describe("ripgrep JSON content protocol", () => {
  test("decodes text and base64 records and validates submatches", () => {
    const invalidPath = { bytes: Buffer.from([0x62, 0xff]).toString("base64") };
    const lines = wireText("x\n");
    const parser = createRipgrepWireParser("content");
    parser.push(
      Buffer.concat([
        jsonLine(begin(invalidPath)),
        jsonLine(match(invalidPath, lines)),
        jsonLine(context(invalidPath, wireText("y\n"))),
        jsonLine(end(invalidPath)),
        jsonLine(summary),
      ]),
    );
    parser.finish();

    expect(parser.records).toHaveLength(2);
    expect(parser.records[0]).toEqual(
      expect.objectContaining({
        kind: "content",
        recordType: "match",
        path: Buffer.from([0x62, 0xff]),
        lines: Buffer.from("x\n"),
      }),
    );
  });

  test("accepts canonical empty base64 for a zero-width byte match", () => {
    const path = wireText("a");
    const parser = createRipgrepWireParser("content");
    parser.push(jsonLine(begin(path)));
    parser.push(
      jsonLine({
        type: "match",
        data: {
          path,
          lines: { bytes: "" },
          line_number: null,
          absolute_offset: 0,
          submatches: [{ match: { bytes: "" }, start: 0, end: 0 }],
        },
      }),
    );
    parser.push(jsonLine(end(path)));
    parser.push(jsonLine(summary));
    parser.finish();

    expect(parser.records).toEqual([
      expect.objectContaining({
        kind: "content",
        lines: Buffer.alloc(0),
        submatches: [{ bytes: Buffer.alloc(0), start: 0, end: 0 }],
      }),
    ]);
  });

  test("rejects equal-length submatch bytes that differ from the line slice", () => {
    const path = wireText("a");
    const parser = createRipgrepWireParser("content");
    parser.push(jsonLine(begin(path)));

    expect(() =>
      parser.push(
        jsonLine({
          type: "match",
          data: {
            path,
            lines: wireText("x\n"),
            line_number: 1,
            absolute_offset: 0,
            submatches: [{ match: wireText("y"), start: 0, end: 1 }],
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ reason: "INVALID_JSON_RECORD" }));
  });

  test("rejects malformed JSON and impossible record order", () => {
    const malformed = createRipgrepWireParser("content");
    expect(() => malformed.push(Buffer.from("{]\n"))).toThrowError(
      expect.objectContaining({ reason: "MALFORMED_JSON" }),
    );

    const beforeBegin = createRipgrepWireParser("content");
    expect(() =>
      beforeBegin.push(jsonLine(match(wireText("a"), wireText("x\n")))),
    ).toThrowError(
      expect.objectContaining({ reason: "INVALID_JSON_RECORD_ORDER" }),
    );

    const missingEnd = createRipgrepWireParser("content");
    missingEnd.push(jsonLine(begin(wireText("a"))));
    expect(() => missingEnd.finish()).toThrowError(
      expect.objectContaining({ reason: "INVALID_JSON_RECORD_ORDER" }),
    );
  });

  test("rejects noncanonical base64 and context boundary plus one", () => {
    const base64 = createRipgrepWireParser("content");
    expect(() => base64.push(jsonLine(begin({ bytes: "***=" })))).toThrowError(
      expect.objectContaining({ reason: "INVALID_WIRE_BASE64" }),
    );

    const path = wireText("a");
    const contexts = createRipgrepWireParser("content", {
      maxContextRecords: 1,
    });
    contexts.push(jsonLine(begin(path)));
    contexts.push(jsonLine(context(path, wireText("x\n"))));
    expect(() =>
      contexts.push(jsonLine(context(path, wireText("y\n")))),
    ).toThrowError(expect.objectContaining({ reason: "CONTEXT_LIMIT" }));
  });

  test("requires a newline and final summary on completed output", () => {
    const unterminated = createRipgrepWireParser("content");
    unterminated.push(Buffer.from(JSON.stringify(summary)));
    expect(() => unterminated.finish()).toThrowError(
      expect.objectContaining({ reason: "UNTERMINATED_RECORD" }),
    );

    const noSummary = createRipgrepWireParser("content");
    expect(() => noSummary.finish()).toThrowError(
      expect.objectContaining({ reason: "INVALID_JSON_RECORD_ORDER" }),
    );
  });

  test("exposes stable reasons rather than parser-dependent messages", () => {
    const parser = createRipgrepWireParser("files_with_matches", {
      maxRecordBytes: 1,
    });
    try {
      parser.push(Buffer.from("ab\0"));
    } catch (error) {
      expect(boundaryReason(error)).toBe("RECORD_LIMIT");
    }
  });
});
