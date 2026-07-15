import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { validateRuntimeArchive } from "../../src/utils/runtime-archive.js";

function tarHeader(path: string, type = "0", link = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write("00000000000\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function archive(...members: Array<[string, string?, string?]>): Buffer {
  return gzipSync(Buffer.concat([
    ...members.map(([path, type, link]) => tarHeader(path, type, link)),
    Buffer.alloc(1024),
  ]));
}

describe("update-side runtime archive validation", () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), "agenc-update-archive-")); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  test.each([
    "node_modules/pkg/file:stream",
    "node_modules/pkg/COM1.txt",
    "node_modules/pkg/LPT\u00b9.txt",
    "node_modules/pkg/file.",
  ])("rejects the unsafe Windows path %s", (member) => {
    const path = join(work, "runtime.tar.gz");
    writeFileSync(path, archive([member]));
    expect(() => validateRuntimeArchive(path, "win")).toThrow(/unsafe runtime archive path for win/);
  });

  test("rejects case-insensitive path collisions", () => {
    const path = join(work, "runtime.tar.gz");
    writeFileSync(path, archive(
      ["node_modules/", "5"],
      ["node_modules/Pkg", "5"],
      ["node_modules/pkg", "5"],
    ));
    expect(() => validateRuntimeArchive(path, "win")).toThrow(/case\/Unicode path collision/);
  });

  test("validates exact raw USTAR path and link bytes without trimming", () => {
    const cases: Array<{
      name: string;
      members: Array<[string, string?, string?]>;
      expected: RegExp;
    }> = [
      {
        name: "trailing-space-path",
        members: [["node_modules/", "5"], ["node_modules/pkg/file "]],
        expected: /unsafe runtime archive path for win/,
      },
      {
        name: "leading-space-path",
        members: [["node_modules/", "5"], [" node_modules/pkg/file"]],
        expected: /outside node_modules/,
      },
      {
        name: "trailing-space-link",
        members: [["node_modules/", "5"], ["node_modules/link", "2", "./target "]],
        expected: /unsafe runtime archive link target for win/,
      },
    ];
    for (const fixture of cases) {
      const path = join(work, `${fixture.name}.tar.gz`);
      writeFileSync(path, archive(...fixture.members));
      expect(() => validateRuntimeArchive(path, "win")).toThrow(fixture.expected);
    }
  });

  test("rejects a symlink graph whose lexical targets compose outside node_modules", () => {
    const path = join(work, "symlink-graph-escape.tar.gz");
    writeFileSync(path, archive(
      ["node_modules/", "5"],
      ["node_modules/a/", "5"],
      ["node_modules/a/b/", "5"],
      ["node_modules/a/b/c/", "5"],
      ["node_modules/a/b/c/x", "2", "../../.."],
      ["node_modules/y", "2", "a/b/c/x/../../../../escape"],
    ));
    expect(() => validateRuntimeArchive(path, "linux")).toThrow(
      /symlink graph escapes (?:the extraction root|node_modules)/,
    );
  });

  test("accepts a valid in-tree symlink graph and rejects cycles", () => {
    const valid = join(work, "valid-symlink-graph.tar.gz");
    writeFileSync(valid, archive(
      ["node_modules/", "5"],
      ["node_modules/pkg/", "5"],
      ["node_modules/current", "2", "pkg"],
    ));
    expect(() => validateRuntimeArchive(valid, "linux")).not.toThrow();

    const cycle = join(work, "cyclic-symlink-graph.tar.gz");
    writeFileSync(cycle, archive(
      ["node_modules/", "5"],
      ["node_modules/a", "2", "b"],
      ["node_modules/b", "2", "a"],
    ));
    expect(() => validateRuntimeArchive(cycle, "linux")).toThrow(
      /symlink graph contains a cycle or excessive depth/,
    );
  });

  test.skipIf(
    !spawnSync("/usr/bin/tar", ["--version"], { encoding: "utf8" }).stdout
      ?.includes("GNU tar"),
  )("rejects GNU sparse PAX output-name metadata honored by the extractor", () => {
    const source = join(work, "sparse-source");
    const modules = join(source, "node_modules");
    mkdirSync(modules, { recursive: true });
    const filename = "a".repeat(48);
    const sparseFile = join(modules, filename);
    const descriptor = openSync(sparseFile, "w");
    try {
      ftruncateSync(descriptor, 16 * 1024 * 1024);
      writeSync(descriptor, Buffer.from("X"), 0, 1, 16 * 1024 * 1024 - 1);
    } finally {
      closeSync(descriptor);
    }
    const raw = join(work, "sparse.tar");
    const created = spawnSync("/usr/bin/tar", [
      "--format=pax",
      "--sparse",
      "--sparse-version=1.0",
      "-cf",
      raw,
      "-C",
      source,
      "node_modules",
    ], { encoding: "utf8" });
    expect(created.status, created.stderr).toBe(0);

    const bytes = readFileSync(raw);
    const originalName = `node_modules/${filename}`;
    const needle = Buffer.from(`GNU.sparse.name=${originalName}\n`);
    const recordOffset = bytes.indexOf(needle);
    expect(recordOffset).toBeGreaterThanOrEqual(0);
    const escapedName = `.pax-root-${"b".repeat(originalName.length - ".pax-root-".length)}`;
    const mutated = Buffer.from(bytes);
    mutated.write(
      escapedName,
      recordOffset + Buffer.byteLength("GNU.sparse.name="),
      originalName.length,
      "utf8",
    );
    const archivePath = join(work, "sparse-mutated.tar.gz");
    writeFileSync(archivePath, gzipSync(mutated));

    const extractionRoot = join(work, "extracted");
    mkdirSync(extractionRoot);
    const extracted = spawnSync("/usr/bin/tar", ["-xzf", archivePath, "-C", extractionRoot], {
      encoding: "utf8",
    });
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(readdirSync(extractionRoot)).toContain(escapedName);
    expect(existsSync(join(extractionRoot, escapedName))).toBe(true);
    expect(() => validateRuntimeArchive(archivePath, "linux")).toThrow(
      /unsupported PAX key: GNU\.sparse\./,
    );
  });
});
