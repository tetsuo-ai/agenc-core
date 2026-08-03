import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeRootPath } from "../../helpers/source-path.js";
import {
  parseCsv,
  scanCsvFile,
  writeCsv,
  CsvParseError,
  createCsvInputRootCapability,
  deriveCsvItemIdentity,
} from "./csv-reader.js";

function fixture(name: string): string {
  return readFileSync(
    join(runtimeRootPath, "tests/fnd/fixtures/csv", name),
    "utf8",
  );
}

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

  it("skips rows where every field is empty (matches reference)", () => {
    const doc = parseCsv("a,b\n1,2\n,\n3,4\n");
    expect(doc.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("keeps prototype-shaped headers as inert own data properties", () => {
    const document = parseCsv(fixture("prototype-headers-v1.csv"));
    const row = document.rows[0]!;
    expect(Object.getPrototypeOf(row)).toBeNull();
    expect(Object.hasOwn(row, "__proto__")).toBe(true);
    expect(row.__proto__).toBe("synthetic-proto");
    expect(row.constructor).toBe("synthetic-constructor");
    expect(row.prototype).toBe("synthetic-prototype");
  });

  it("rejects duplicate, reserved, and extra headers or fields", () => {
    const configuredSourceId = { idColumn: "source_id" } as const;
    expect(() =>
      parseCsv(fixture("duplicate-headers-v1.csv"), configuredSourceId),
    ).toThrow(/duplicate CSV header.*columns 2 and 3/);
    expect(() =>
      parseCsv(fixture("reserved-header-v1.csv"), configuredSourceId),
    ).toThrow(/reserved for job output/);
    expect(() =>
      parseCsv(fixture("extra-field-v1.csv"), configuredSourceId),
    ).toThrow(/4 fields; header has 3/);
  });

  it("pads short rows without inventing source identity", () => {
    const document = parseCsv(fixture("short-row-padding-v1.csv"), {
      idColumn: "source_id",
    });
    expect(document.rows[0]).toMatchObject({
      source_id: "short-row",
      task: "missing notes",
      notes: "",
    });
  });

  it("rejects blank and exact duplicate configured source IDs with row evidence", () => {
    expect(() =>
      parseCsv(fixture("blank-source-id-v1.csv"), { idColumn: "source_id" }),
    ).toThrow(/blank at CSV data row 1/);
    expect(() =>
      parseCsv(fixture("unicode-whitespace-source-id-v1.csv"), {
        idColumn: "source_id",
      }),
    ).toThrow(/blank at CSV data row 1/);
    expect(() =>
      parseCsv(fixture("duplicate-source-id-v1.csv"), {
        idColumn: "source_id",
      }),
    ).toThrow(/data rows 1 and 3/);
  });

  it("preserves surrounding source-ID whitespace when the value is nonblank", () => {
    const document = parseCsv('source_id,task\n"  padded-id  ",x\n', {
      idColumn: "source_id",
    });
    expect(document.rows[0]!.source_id).toBe("  padded-id  ");
  });

  it("preserves embedded CR, LF, CRLF, and escaped quotes", () => {
    const document = parseCsv(fixture("quoted-crlf-v1.bin"), {
      idColumn: "source_id",
    });
    expect(document.rows[0]!.task).toContain("bare CR->\r<- bare LF->\n<-");
    expect(document.rows[0]!.task).toContain("CRLF->\r\n<-");
    expect(document.rows[0]!.notes).toBe('escaped "quote"');
  });

  it("enforces named byte, row, column, header, and field ceilings", () => {
    expect(() => parseCsv("a\n1\n", { maxInputBytes: 3 })).toThrow(
      /input is 4 bytes/,
    );
    expect(() => parseCsv("a,b\n1,2\n", { maxColumns: 1 })).toThrow(
      /more than 1 fields|2 columns/,
    );
    expect(() => parseCsv("long\nx\n", { maxHeaderBytes: 3 })).toThrow(
      /CSV header is 4 bytes/,
    );
    expect(parseCsv("abc\nx\n", { maxHeaderBytes: 3 }).headers).toEqual([
      "abc",
    ]);
    expect(() => parseCsv('"a""b"\nx\n', { maxHeaderBytes: 3 })).toThrow(
      /CSV header/u,
    );
    expect(() => parseCsv("a\nlong\n", { maxFieldBytes: 3 })).toThrow(
      /CSV field is 4 bytes/,
    );
    expect(() => parseCsv("a\n1\n2\n", { maxRows: 1 })).toThrow(
      /more than 1 data rows/,
    );
    expect(() => parseCsv("a\n123\n", { maxRecordBytes: 3 })).toThrow(
      /record is more than 3 bytes/u,
    );
  });

  it("rejects NUL, bare structural CR, whitespace headers, and interior BOMs", () => {
    expect(() => parseCsv("a\n\0\n")).toThrow(/NUL/u);
    expect(() => parseCsv("a\r1\n")).toThrow(/bare CR/u);
    expect(() => parseCsv("  ,b\n1,2\n")).toThrow(/header is blank/u);
    expect(() => parseCsv("a,b\n1,\uFEFF2\n")).toThrow(
      /BOM is permitted only/u,
    );
  });

  it("fatally rejects invalid streamed UTF-8 and aborts during scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-csv-reader-"));
    try {
      const invalid = join(root, "invalid.csv");
      await writeFile(invalid, Buffer.from([0x61, 0x0a, 0xff, 0x0a]));
      await expect(scanCsvFile(invalid)).rejects.toThrow(/not valid UTF-8/u);

      const cancellable = join(root, "cancel.csv");
      await writeFile(cancellable, "id\n1\n2\n3\n", "utf8");
      const controller = new AbortController();
      await expect(
        scanCsvFile(
          cancellable,
          { signal: controller.signal },
          {
            onRow: () => controller.abort(new Error("scan cancelled")),
          },
        ),
      ).rejects.toThrow(/scan cancelled/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits only CSV paths beneath the authenticated input root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-csv-input-root-"));
    const outside = await mkdtemp(join(tmpdir(), "agenc-csv-input-outside-"));
    try {
      await writeFile(join(root, "inside.csv"), "id\ninside\n", "utf8");
      const outsidePath = join(outside, "outside.csv");
      await writeFile(outsidePath, "id\noutside\n", "utf8");
      const inputRootCapability = createCsvInputRootCapability(root);

      await expect(
        scanCsvFile("inside.csv", { inputRootCapability }),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        scanCsvFile(outsidePath, { inputRootCapability }),
      ).rejects.toThrow(/outside the authorized input root/u);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects an in-root symlink before exposing outside CSV contents",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-csv-input-root-"));
      const outside = await mkdtemp(join(tmpdir(), "agenc-csv-input-outside-"));
      try {
        const outsidePath = join(outside, "outside.csv");
        await writeFile(outsidePath, "id\nsecret\n", "utf8");
        await symlink(outsidePath, join(root, "linked.csv"), "file");
        const inputRootCapability = createCsvInputRootCapability(root);
        let callbackInvoked = false;

        await expect(
          scanCsvFile(
            "linked.csv",
            { inputRootCapability },
            {
              onHeaders: () => {
                callbackInvoked = true;
              },
              onRow: () => {
                callbackInvoked = true;
              },
            },
          ),
        ).rejects.toThrow(/outside the authorized input root/u);
        expect(callbackInvoked).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it("derives stable opaque item IDs and safe worker names independently of source IDs", () => {
    const document = parseCsv("source_id,value\n../../escape,a\n", {
      idColumn: "source_id",
    });
    const identity = deriveCsvItemIdentity(
      "job-fixed",
      0,
      document.headers,
      document.rows[0]!,
    );
    expect(identity.itemId).toMatch(/^csv_item_[0-9a-f]{64}$/u);
    expect(identity.itemId).not.toContain("escape");
    expect(identity.workerName).toMatch(/^csv_row_0_[0-9a-f]{16}$/u);
    expect(
      deriveCsvItemIdentity(
        "job-fixed",
        0,
        document.headers,
        document.rows[0]!,
      ),
    ).toEqual(identity);
    expect(
      deriveCsvItemIdentity("job-other", 0, document.headers, document.rows[0]!)
        .itemId,
    ).not.toBe(identity.itemId);

    const renamedHeaderIdentity = deriveCsvItemIdentity(
      "job-fixed",
      0,
      ["renamed_source_id", "value"],
      { renamed_source_id: "../../escape", value: "a" },
    );
    expect(renamedHeaderIdentity.contentSha256).not.toBe(
      identity.contentSha256,
    );
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
