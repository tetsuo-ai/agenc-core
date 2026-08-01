import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  isWellFormedUnicode,
  portablePathIdentity,
  portableUnicodeCaseIdentity,
  validatePortableRepositoryPath,
} from "../helpers/portable-repository-path.js";
import {
  isUnicode15_1RepertoireScalar,
  UNICODE_15_1_PORTABLE_FOLD_FINGERPRINT_SHA256,
  UNICODE_15_1_REPERTOIRE_SCALAR_COUNT,
} from "../helpers/unicode-15-1-repertoire.js";

const MAX_UNICODE_SCALAR = 0x10ffff;

describe("FND runtime-neutral portable repository paths", () => {
  test("validates portable Unicode paths identically", () => {
    expect(isWellFormedUnicode("nested/emoji-😀.txt")).toBe(true);
    expect(isWellFormedUnicode(`high-${String.fromCharCode(0xd800)}`)).toBe(
      false,
    );
    expect(validatePortableRepositoryPath("nested/emoji-😀.txt")).toEqual([
      "nested",
      "emoji-😀.txt",
    ]);
    expect(portablePathIdentity("Folder/CAFÉ.txt")).toBe(
      portablePathIdentity("folder/cafe\u0301.TXT"),
    );
    expect(() => validatePortableRepositoryPath("nested/../escape")).toThrow();
    expect(() => validatePortableRepositoryPath("C:/escape")).toThrow();
    expect(() => validatePortableRepositoryPath("\ua7cb")).toThrow();
  });

  test("rejects DOS 8.3 tilde aliases identically", () => {
    for (const alias of [
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
    ]) {
      expect(() => validatePortableRepositoryPath(alias)).toThrow();
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

  test("matches the exhaustive Unicode 15.1 portable-fold fingerprint", () => {
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
});
