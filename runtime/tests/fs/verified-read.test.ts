/**
 * Unit tests for the shared descriptor-bound read primitives.
 *
 * Two things are pinned here that no end-to-end test can pin:
 *
 *   - the open flags, because `O_NOFOLLOW` has no behavioural mutant. Every
 *     *distinct* replacement is already rejected by the identity proof around
 *     the open, so the only case the flag alone catches is a symlink pointing
 *     at the very inode that was admitted — and no second name for an inode
 *     can be created without moving its ctime (hard link and rename both do),
 *     which the identity proof then rejects. The flag is still the structural
 *     guarantee, so it is pinned on its value.
 *   - the fail-closed platform decision, because the CI matrix cannot run on a
 *     platform with no descriptor-path mechanism.
 */
import { constants } from "node:fs";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_VERIFIED_READ_CONTEXT,
  UnsupportedVerifiedReadPlatformError,
  bindVerifiedRoot,
  closeVerifiedHandle,
  descriptorHandlePath,
  isContained,
  openVerifiedCandidate,
  verifiedDirectoryOpenFlags,
  verifiedFileOpenFlags,
  verifyParentChain,
} from "../../src/fs/verified-read.js";

const NEVER_ABORTED = new AbortController().signal;
const CONTEXT = DEFAULT_VERIFIED_READ_CONTEXT;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-verified-read-"));
  dirs.push(dir);
  return dir;
}

describe("open flags", () => {
  test.runIf(process.platform !== "win32")(
    "a verified file open refuses to follow a final-component symlink and never blocks",
    () => {
      const flags = verifiedFileOpenFlags();
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    },
  );

  test.runIf(process.platform !== "win32")(
    "a verified directory open demands a directory and refuses to follow a symlink",
    () => {
      const flags = verifiedDirectoryOpenFlags();
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(flags & constants.O_DIRECTORY).toBe(constants.O_DIRECTORY);
    },
  );
});

describe("root binding", () => {
  test("binds a real directory and reports its canonical path", async () => {
    const root = makeRoot();
    const bound = await bindVerifiedRoot(root, NEVER_ABORTED, CONTEXT);
    expect(bound).not.toBeNull();
    expect(bound!.binding.canonicalPath).toBe(root);
    await closeVerifiedHandle(bound!.handle, NEVER_ABORTED, CONTEXT);
  });

  test("refuses a root that is a symlink", async () => {
    const root = makeRoot();
    const target = join(root, "real");
    mkdirSync(target);
    symlinkSync(target, join(root, "linked"));
    expect(
      await bindVerifiedRoot(join(root, "linked"), NEVER_ABORTED, CONTEXT),
    ).toBeNull();
  });

  test("refuses a root that is not a directory", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "file"), "x");
    expect(
      await bindVerifiedRoot(join(root, "file"), NEVER_ABORTED, CONTEXT),
    ).toBeNull();
  });
});

describe("ancestor chain", () => {
  test("rejects a candidate reached through a symlinked ancestor", async () => {
    const root = makeRoot();
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "SKILL.md"), "body");
    symlinkSync("real", join(root, "linked"));
    const bound = (await bindVerifiedRoot(root, NEVER_ABORTED, CONTEXT))!;
    try {
      expect(
        await verifyParentChain(
          bound,
          join("real", "SKILL.md"),
          NEVER_ABORTED,
          CONTEXT,
        ),
      ).toBe(true);
      expect(
        await verifyParentChain(
          bound,
          join("linked", "SKILL.md"),
          NEVER_ABORTED,
          CONTEXT,
        ),
      ).toBe(false);
      expect(
        await openVerifiedCandidate(
          bound,
          join("linked", "SKILL.md"),
          NEVER_ABORTED,
          CONTEXT,
        ),
      ).toBeNull();
    } finally {
      await closeVerifiedHandle(bound.handle, NEVER_ABORTED, CONTEXT);
    }
  });

  test("rejects every candidate once the bound root is exchanged for another directory", async () => {
    const root = makeRoot();
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "SKILL.md"), "body");
    const bound = (await bindVerifiedRoot(real, NEVER_ABORTED, CONTEXT))!;
    try {
      expect(
        await verifyParentChain(bound, "SKILL.md", NEVER_ABORTED, CONTEXT),
      ).toBe(true);
      // The name the root was bound under now leads to a different directory.
      const decoy = join(root, "decoy");
      mkdirSync(decoy);
      writeFileSync(join(decoy, "SKILL.md"), "decoy");
      renameSync(real, join(root, "real.away"));
      renameSync(decoy, real);
      expect(
        await verifyParentChain(bound, "SKILL.md", NEVER_ABORTED, CONTEXT),
      ).toBe(false);
    } finally {
      await closeVerifiedHandle(bound.handle, NEVER_ABORTED, CONTEXT);
    }
  });

  test("rejects a candidate that climbs out of the root", async () => {
    const root = makeRoot();
    expect(isContained(root, join(root, "..", "escape"))).toBe(false);
    const bound = (await bindVerifiedRoot(root, NEVER_ABORTED, CONTEXT))!;
    try {
      expect(
        await openVerifiedCandidate(
          bound,
          join("..", "escape"),
          NEVER_ABORTED,
          CONTEXT,
        ),
      ).toBeNull();
    } finally {
      await closeVerifiedHandle(bound.handle, NEVER_ABORTED, CONTEXT);
    }
  });
});

describe("platform fail-closed", () => {
  test("a platform with no descriptor-path mechanism raises instead of degrading", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      ...descriptor,
      value: "sunos",
    });
    try {
      expect(() =>
        descriptorHandlePath(
          { fd: 3 } as never,
          "/workspace",
          DEFAULT_VERIFIED_READ_CONTEXT,
        ),
      ).toThrow(UnsupportedVerifiedReadPlatformError);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
});
