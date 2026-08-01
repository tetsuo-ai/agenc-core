import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PORTABLE_REPOSITORY_PATH_LIMITS,
  isWellFormedUnicode,
  MAX_PORTABLE_REPOSITORY_PATH_DEPTH,
  MAX_PORTABLE_REPOSITORY_PATH_UTF8_BYTES,
  PortableRepositoryPathError,
  portablePathIdentity,
  portableUnicodeCaseIdentity,
  type PortableRepositoryPathLimits,
  validatePortableRepositoryPath,
} from "../helpers/portable-repository-path.js";
import {
  isUnicode15_1RepertoireScalar,
  UNICODE_15_1_PORTABLE_FOLD_FINGERPRINT_SHA256,
  UNICODE_15_1_REPERTOIRE_ENDPOINT_COUNT,
  UNICODE_15_1_REPERTOIRE_SCALAR_COUNT,
  UNICODE_15_1_REPERTOIRE_VERSION,
} from "../helpers/unicode-15-1-repertoire.js";

const PATH_LIMITS: PortableRepositoryPathLimits = Object.freeze({
  maxDepth: 4,
  maxPathUtf8Bytes: 32,
  maxSegmentUtf8Bytes: 16,
  maxSegmentUtf16CodeUnits: 16,
});
const MAX_UNICODE_SCALAR = 0x10ffff;

function expectPathError(
  action: () => unknown,
  code: PortableRepositoryPathError["code"],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PortableRepositoryPathError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected PortableRepositoryPathError ${code}`);
}

describe("portable repository path policy", () => {
  it("returns an immutable segment copy for a portable Unicode path", () => {
    const segments = validatePortableRepositoryPath(
      "nested/emoji-😀.txt",
      PATH_LIMITS,
    );

    expect(segments).toEqual(["nested", "emoji-😀.txt"]);
    expect(Object.isFrozen(segments)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PORTABLE_REPOSITORY_PATH_LIMITS)).toBe(true);
  });

  it("detects both malformed surrogate forms before UTF-8 accounting", () => {
    const unpairedHigh = `high-${String.fromCharCode(0xd800)}`;
    const unpairedLow = `low-${String.fromCharCode(0xdc00)}`;

    expect(isWellFormedUnicode("paired-😀")).toBe(true);
    expect(isWellFormedUnicode(unpairedHigh)).toBe(false);
    expect(isWellFormedUnicode(unpairedLow)).toBe(false);
    expectPathError(
      () => validatePortableRepositoryPath(unpairedHigh),
      "malformed_unicode",
    );
    expectPathError(
      () => validatePortableRepositoryPath(unpairedLow),
      "malformed_unicode",
    );
  });

  it("rejects absolute, namespace, separator, empty, and dot paths", () => {
    const cases = [
      ["", "empty_path"],
      ["/absolute", "absolute_path"],
      ["//server/share", "absolute_path"],
      ["C:/absolute", "absolute_path"],
      ["C:\\absolute", "absolute_path"],
      ["\\\\?\\C:\\absolute", "absolute_path"],
      ["nested\\file", "separator"],
      ["nested//file", "separator"],
      ["nested/", "separator"],
      ["./file", "dot_segment"],
      ["nested/../file", "dot_segment"],
    ] as const;

    for (const [value, code] of cases) {
      expectPathError(() => validatePortableRepositoryPath(value), code);
    }
    expectPathError(
      () => validatePortableRepositoryPath(42 as unknown as string),
      "path_type",
    );
  });

  it("rejects control, Windows-forbidden, and trailing characters", () => {
    for (const value of ["nul\0byte", "line\nbreak", "delete\u007fbyte"]) {
      expectPathError(
        () => validatePortableRepositoryPath(value),
        "control_character",
      );
    }
    for (const character of ["<", ">", ":", '"', "|", "?", "*"]) {
      expectPathError(
        () => validatePortableRepositoryPath(`bad${character}name`),
        "forbidden_character",
      );
    }
    expectPathError(
      () => validatePortableRepositoryPath("trailing."),
      "trailing_character",
    );
    expectPathError(
      () => validatePortableRepositoryPath("trailing "),
      "trailing_character",
    );
  });

  it("rejects every reserved Windows device form and internal segment", () => {
    const deviceNames = [
      "CON",
      "prn.txt",
      "Aux",
      "NUL.bin",
      "CLOCK$",
      "COM1",
      "com9.log",
      "LPT1",
      "lpt9.txt",
      "COM¹",
      "com².txt",
      "LPT³.log",
    ];
    for (const deviceName of deviceNames) {
      expectPathError(
        () => validatePortableRepositoryPath(`nested/${deviceName}`),
        "reserved_segment",
      );
    }
    for (const internalName of [".Git", ".AGENC-FND-CONTROL"]) {
      expectPathError(
        () => validatePortableRepositoryPath(`nested/${internalName}/file`),
        "reserved_segment",
      );
    }
    expect(validatePortableRepositoryPath("com0/lpt10/.gitignore")).toEqual([
      "com0",
      "lpt10",
      ".gitignore",
    ]);
  });

  it("rejects DOS 8.3 tilde aliases in every path segment", () => {
    const aliases = [
      "git~1",
      "GIT~0001",
      "nested/git~2/config",
      "nested/agenc-~1/file",
      "FOO~12.TXT",
      "a~~1.z",
      "git~12345",
      "mañ~1",
      "é~1.txt",
      "文件~1",
      "файл~2.dat",
      "ßßßßßß~1",
    ];
    for (const alias of aliases) {
      expectPathError(
        () => validatePortableRepositoryPath(alias),
        "reserved_segment",
      );
    }

    for (const ordinaryName of [
      "git~",
      "git~x",
      "ordinary~backup",
      "a~1234567",
      "foo~1.long",
      "mañ~x",
      "mañ ~1",
      "文件文件文件文~1",
    ]) {
      expect(validatePortableRepositoryPath(ordinaryName)).toEqual([
        ordinaryName,
      ]);
    }
  });

  it("rejects a short-name-shaped segment before filesystem mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-portable-path-"));
    const candidate = join(root, "git~1");
    try {
      const mutation = async (): Promise<void> => {
        // Windows may resolve a generated git~N alias to .git. This sentinel
        // deliberately needs no host alias support: validation must stop every
        // platform before the filesystem call can create the candidate.
        validatePortableRepositoryPath("git~1");
        await mkdir(candidate);
      };
      await expect(mutation()).rejects.toMatchObject({
        code: "reserved_segment",
      });
      await expect(lstat(candidate)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: false });
    }
  });

  it("enforces depth at limit and limit plus one", () => {
    const limits = { ...PATH_LIMITS, maxDepth: 2 };
    expect(validatePortableRepositoryPath("a/b", limits)).toEqual(["a", "b"]);
    expectPathError(
      () => validatePortableRepositoryPath("a/b/c", limits),
      "path_depth_limit",
    );
  });

  it("enforces total UTF-8 bytes at limit and limit plus one", () => {
    const limits = {
      ...PATH_LIMITS,
      maxPathUtf8Bytes: 4,
      maxSegmentUtf8Bytes: 4,
      maxSegmentUtf16CodeUnits: 4,
    };
    expect(validatePortableRepositoryPath("😀", limits)).toEqual(["😀"]);
    expectPathError(
      () => validatePortableRepositoryPath("😀x", limits),
      "path_utf8_limit",
    );
  });

  it("enforces segment UTF-8 bytes at limit and limit plus one", () => {
    const limits = {
      ...PATH_LIMITS,
      maxSegmentUtf8Bytes: 4,
    };
    expect(validatePortableRepositoryPath("éé", limits)).toEqual(["éé"]);
    expectPathError(
      () => validatePortableRepositoryPath("ééx", limits),
      "segment_utf8_limit",
    );
  });

  it("enforces segment UTF-16 units at limit and limit plus one", () => {
    const limits = {
      ...PATH_LIMITS,
      maxSegmentUtf16CodeUnits: 2,
    };
    expect(validatePortableRepositoryPath("😀", limits)).toEqual(["😀"]);
    expectPathError(
      () => validatePortableRepositoryPath("😀x", limits),
      "segment_utf16_limit",
    );
  });

  it("maps case and canonical Unicode forms to one portable identity", () => {
    expect(portablePathIdentity("Folder/CAFÉ.txt")).toBe(
      portablePathIdentity("folder/cafe\u0301.TXT"),
    );
    expect(portablePathIdentity("Folder/CAFÉ.txt")).toBe("folder/café.txt");
    expect(portablePathIdentity("σ.txt")).toBe(portablePathIdentity("ς.TXT"));
    expect(portablePathIdentity("ß.txt")).toBe(portablePathIdentity("SS.TXT"));
    expect(portablePathIdentity("ß.txt")).toBe(portablePathIdentity("ẞ.TXT"));
  });

  it("pins path admission and folding to Unicode 15.1", () => {
    expect(UNICODE_15_1_REPERTOIRE_VERSION).toBe("15.1.0");
    expect(UNICODE_15_1_REPERTOIRE_ENDPOINT_COUNT).toBe(1_430);
    expect(UNICODE_15_1_REPERTOIRE_SCALAR_COUNT).toBe(287_412);
    for (const codePoint of [0xa7cb, 0x1c89, 0xa7ce, 0x1fa8a]) {
      expect(isUnicode15_1RepertoireScalar(codePoint)).toBe(false);
      expectPathError(
        () => validatePortableRepositoryPath(String.fromCodePoint(codePoint)),
        "unicode_repertoire",
      );
    }
    for (const codePoint of [0x264, 0x19b, 0x1f600]) {
      expect(isUnicode15_1RepertoireScalar(codePoint)).toBe(true);
      expect(
        validatePortableRepositoryPath(String.fromCodePoint(codePoint)),
      ).toEqual([String.fromCodePoint(codePoint)]);
    }
  });

  it("matches the exhaustive Unicode 15.1 portable-fold fingerprint", () => {
    const digest = createHash("sha256");
    let scalarCount = 0;
    for (let codePoint = 0; codePoint <= MAX_UNICODE_SCALAR; codePoint += 1) {
      if (!isUnicode15_1RepertoireScalar(codePoint)) continue;
      scalarCount += 1;
      digest.update(`${codePoint.toString(16)}:`);
      digest.update(
        portableUnicodeCaseIdentity(String.fromCodePoint(codePoint)),
      );
      digest.update("\n");
    }
    expect(scalarCount).toBe(UNICODE_15_1_REPERTOIRE_SCALAR_COUNT);
    expect(digest.digest("hex")).toBe(
      UNICODE_15_1_PORTABLE_FOLD_FINGERPRINT_SHA256,
    );
  });

  it("enforces the Unicode identity UTF-8 byte ceiling", () => {
    const overLimit = "\u0800".repeat(
      Math.floor(MAX_PORTABLE_REPOSITORY_PATH_UTF8_BYTES / 3) + 1,
    );
    expect(overLimit.length).toBeLessThan(
      MAX_PORTABLE_REPOSITORY_PATH_UTF8_BYTES,
    );
    expect(() => portableUnicodeCaseIdentity(overLimit)).toThrowError(
      PortableRepositoryPathError,
    );
  });

  it("rejects proxy, accessor, missing, unknown, and excessive limits", () => {
    expectPathError(
      () =>
        validatePortableRepositoryPath(
          "safe",
          new Proxy(PATH_LIMITS, {}) as PortableRepositoryPathLimits,
        ),
      "invalid_limits",
    );
    const symbolLimits = Object.assign({}, PATH_LIMITS, {
      [Symbol("hostile")]: 1,
    }) as PortableRepositoryPathLimits;
    expectPathError(
      () => validatePortableRepositoryPath("safe", symbolLimits),
      "invalid_limits",
    );

    let getterCalls = 0;
    const accessorLimits = {
      maxDepth: PATH_LIMITS.maxDepth,
      maxPathUtf8Bytes: PATH_LIMITS.maxPathUtf8Bytes,
      maxSegmentUtf8Bytes: PATH_LIMITS.maxSegmentUtf8Bytes,
      get maxSegmentUtf16CodeUnits() {
        getterCalls += 1;
        return PATH_LIMITS.maxSegmentUtf16CodeUnits;
      },
    };
    expectPathError(
      () => validatePortableRepositoryPath("safe", accessorLimits),
      "invalid_limits",
    );
    expect(getterCalls).toBe(0);

    expectPathError(
      () =>
        validatePortableRepositoryPath("safe", {
          ...PATH_LIMITS,
          maxDepth: MAX_PORTABLE_REPOSITORY_PATH_DEPTH + 1,
        }),
      "invalid_limits",
    );
    expectPathError(
      () =>
        validatePortableRepositoryPath("safe", {
          ...PATH_LIMITS,
          extra: 1,
        } as PortableRepositoryPathLimits),
      "invalid_limits",
    );
    expectPathError(
      () =>
        validatePortableRepositoryPath("safe", {
          maxDepth: PATH_LIMITS.maxDepth,
          maxPathUtf8Bytes: PATH_LIMITS.maxPathUtf8Bytes,
          maxSegmentUtf8Bytes: PATH_LIMITS.maxSegmentUtf8Bytes,
        } as PortableRepositoryPathLimits),
      "invalid_limits",
    );
  });
});
