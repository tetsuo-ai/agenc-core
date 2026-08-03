import {
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  MAX_APPLY_PATCH_FILE_BYTES,
  MAX_APPLY_PATCH_LINE_BYTES,
} from "./limits.js";
import { parsePatch } from "./parser.js";
import { applyPatchText } from "./runtime.js";
import { workspaceMutationCoordinators } from "../../workspace/mutation-coordinator.js";

const BYTE_FIXTURES_ROOT = fileURLToPath(
  new URL("../../fnd/fixtures/patches/", import.meta.url),
);
const BYTE_FIXTURE_CASES = [
  "crlf-preserve-v1",
  "lf-preserve-v1",
  "mixed-preserve-v1",
  "no-final-newline-v1",
] as const;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function updatePatch(path: string, before: string, after: string): string {
  return `*** Begin Patch
*** Update File: ${path}
@@
-${before}
+${after}
*** End Patch
`;
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-d3-fidelity-"));
}

afterEach(() => {
  workspaceMutationCoordinators.clearForTests();
});

describe("apply_patch byte fidelity and input boundaries", () => {
  test.each(BYTE_FIXTURE_CASES)(
    "matches the frozen %s byte fixture",
    async (fixtureName) => {
      const fixtureRoot = join(BYTE_FIXTURES_ROOT, fixtureName);
      const caseDefinition = JSON.parse(
        await readFile(join(fixtureRoot, "case.json"), "utf8"),
      ) as { source: string; patch: string; expected: string };
      const source = await readFile(join(fixtureRoot, caseDefinition.source));
      const patchBytes = await readFile(
        join(fixtureRoot, caseDefinition.patch),
      );
      const expected = await readFile(
        join(fixtureRoot, caseDefinition.expected),
      );
      const root = await temporaryRoot();
      const target = join(root, "sample.txt");
      try {
        await writeFile(target, source);
        await applyPatchText(patchBytes.toString("utf8"), {
          cwd: root,
          allowedPaths: [root],
        });
        expect(await readFile(target)).toEqual(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("preserves a UTF-8 BOM and CRLF final newline byte-for-byte", async () => {
    const root = await temporaryRoot();
    const target = join(root, "bom.txt");
    const source = Buffer.concat([
      UTF8_BOM,
      Buffer.from("alpha\r\nbeta\r\n", "utf8"),
    ]);
    try {
      await writeFile(target, source);
      await applyPatchText(updatePatch("bom.txt", "beta", "BETA"), {
        cwd: root,
        allowedPaths: [root],
      });
      expect(await readFile(target)).toEqual(
        Buffer.concat([UTF8_BOM, Buffer.from("alpha\r\nBETA\r\n", "utf8")]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["invalid UTF-8", Buffer.from([0xc3, 0x28]), /not valid UTF-8/u],
    ["UTF-16LE BOM", Buffer.from([0xff, 0xfe, 0x61, 0x00]), /UTF-16LE/u],
    ["UTF-16BE BOM", Buffer.from([0xfe, 0xff, 0x00, 0x61]), /UTF-16BE/u],
    [
      "UTF-32LE BOM",
      Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]),
      /UTF-32LE/u,
    ],
    [
      "UTF-32BE BOM",
      Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61]),
      /UTF-32BE/u,
    ],
  ])(
    "rejects %s without replacing the source",
    async (_label, source, error) => {
      const root = await temporaryRoot();
      const target = join(root, "encoded.txt");
      try {
        await writeFile(target, source);
        await expect(
          applyPatchText(updatePatch("encoded.txt", "a", "b"), {
            cwd: root,
            allowedPaths: [root],
          }),
        ).rejects.toThrow(error);
        expect(await readFile(target)).toEqual(source);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("reports exact NUL and unpaired-surrogate offsets before path I/O", async () => {
    const nulPatch = updatePatch("bad\0path.txt", "a", "b");
    const surrogatePatch = updatePatch("bad\ud800path.txt", "a", "b");
    const absentRoot = join(tmpdir(), "agenc-d3-root-that-does-not-exist");

    expect(() => parsePatch(nulPatch)).toThrow(
      `UTF-16 offset ${nulPatch.indexOf("\0")}: NUL code units`,
    );
    expect(() => parsePatch(surrogatePatch)).toThrow(
      `UTF-16 offset ${surrogatePatch.indexOf("\ud800")}: unpaired high surrogate`,
    );
    await expect(
      applyPatchText(nulPatch, {
        cwd: absentRoot,
        allowedPaths: [absentRoot],
      }),
    ).rejects.toThrow(/NUL code units/u);
  });

  test("accepts a line at the named byte limit and rejects the next byte", () => {
    const addMarkerBytes = Buffer.byteLength("+", "utf8");
    const exact = "x".repeat(MAX_APPLY_PATCH_LINE_BYTES - addMarkerBytes);
    expect(
      parsePatch(
        `*** Begin Patch\n*** Add File: exact.txt\n+${exact}\n*** End Patch`,
      ).hunks,
    ).toHaveLength(1);
    expect(() =>
      parsePatch(
        `*** Begin Patch\n*** Add File: too-large.txt\n+${exact}x\n*** End Patch`,
      ),
    ).toThrow(/exceeds the .*byte limit/u);
  });

  test("rejects a regular file beyond the named byte limit before decoding", async () => {
    const root = await temporaryRoot();
    const target = join(root, "oversized.txt");
    const oversizedBytes = MAX_APPLY_PATCH_FILE_BYTES + 1;
    try {
      await writeFile(target, "a", "utf8");
      await truncate(target, oversizedBytes);
      await expect(
        applyPatchText(updatePatch("oversized.txt", "a", "b"), {
          cwd: root,
          allowedPaths: [root],
        }),
      ).rejects.toThrow(
        `exceeds the ${MAX_APPLY_PATCH_FILE_BYTES}-byte apply_patch file limit`,
      );
      await expect(stat(target)).resolves.toMatchObject({
        size: oversizedBytes,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("honors pre-I/O aborts and deadlines", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.txt");
    const source = Buffer.from("a\n", "utf8");
    const controller = new AbortController();
    controller.abort();
    try {
      await writeFile(target, source);
      await expect(
        applyPatchText(updatePatch("target.txt", "a", "b"), {
          cwd: root,
          allowedPaths: [root],
          signal: controller.signal,
        }),
      ).rejects.toThrow(/aborted during payload parsing/u);
      await expect(
        applyPatchText(updatePatch("target.txt", "a", "b"), {
          cwd: root,
          allowedPaths: [root],
          deadlineAt: Date.now() - 1,
        }),
      ).rejects.toThrow(/deadline expired during payload parsing/u);
      expect(await readFile(target)).toEqual(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes cancellation after the first effect through verified rollback", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    const controller = new AbortController();
    let preWriteChecks = 0;
    try {
      await writeFile(first, "one\n", "utf8");
      await writeFile(second, "two\n", "utf8");
      await expect(
        applyPatchText(
          `*** Begin Patch
*** Update File: first.txt
@@
-one
+ONE
*** Update File: second.txt
@@
-two
+TWO
*** End Patch
`,
          {
            cwd: root,
            allowedPaths: [root],
            signal: controller.signal,
            __testAfterPreWriteCheck: async () => {
              preWriteChecks += 1;
              if (preWriteChecks === 2) controller.abort();
            },
          },
        ),
      ).rejects.toThrow(/was rolled back.*aborted during filesystem commit/su);
      await expect(readFile(first, "utf8")).resolves.toBe("one\n");
      await expect(readFile(second, "utf8")).resolves.toBe("two\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
