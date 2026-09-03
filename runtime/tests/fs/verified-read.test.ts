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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  type VerifiedReadContext,
} from "../../src/fs/verified-read.js";

const NEVER_ABORTED = new AbortController().signal;
const CONTEXT = DEFAULT_VERIFIED_READ_CONTEXT;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenc-verified-read-")));
  dirs.push(dir);
  return dir;
}

/**
 * A context carrying the `bindVerifiedRoot` race seam. That seam is the only
 * way to reach the window between the root's validating `lstat`/`realpath`
 * and the `open` that retains its descriptor: `O_NOFOLLOW` does not cover
 * mid-path components, so an ancestor repointed in that window makes the
 * `open` land somewhere the validation never saw.
 */
function seamContext(
  hook: (requestedPath: string) => void,
): VerifiedReadContext {
  return { ...CONTEXT, beforeRootOpenForTesting: hook };
}

describe("open flags", () => {
  // These two assert the flag VALUES. They perform no open, so nothing here
  // observes `O_NOFOLLOW` or `O_DIRECTORY` actually refusing anything; the
  // reason a behavioural test is impossible is at the top of this file.
  test.runIf(process.platform !== "win32")(
    "the verified file open flags request O_NOFOLLOW and O_NONBLOCK",
    () => {
      const flags = verifiedFileOpenFlags();
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    },
  );

  test.runIf(process.platform !== "win32")(
    "the verified directory open flags request O_DIRECTORY and O_NOFOLLOW",
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

  test("rejects a candidate that climbs out of the root to a file that exists", async () => {
    const base = makeRoot();
    const inner = join(base, "inner");
    mkdirSync(inner);
    // The escape target has to EXIST. With `../escape` absent this test passed
    // on ENOENT: the `isContained` pre-check, the ancestor canonical
    // containment, and the final-path containment could all be deleted at
    // once and it stayed green while a probe with a real target returned a
    // handle and read out-of-scope bytes.
    const escape = join(base, "escape");
    writeFileSync(escape, "out-of-scope body");
    expect(existsSync(escape)).toBe(true);
    expect(isContained(inner, join(inner, "..", "escape"))).toBe(false);
    const bound = (await bindVerifiedRoot(inner, NEVER_ABORTED, CONTEXT))!;
    try {
      // The ancestor walk's canonical containment is what this pins
      // individually: delete that one clause and the walk returns true. The
      // `isContained` pre-check in `openVerifiedCandidate` is redundant with
      // it for every reachable escape — a relative path can only leave the
      // root through a `..` segment, which is always a parent segment the
      // walk sees — so it is pinned collectively, not on its own.
      expect(
        await verifyParentChain(
          bound,
          join("..", "escape"),
          NEVER_ABORTED,
          CONTEXT,
        ),
      ).toBe(false);
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

  /**
   * A directory's `mtime`, `ctime`, and `size` move on every child add,
   * remove, or rename. Proving a *directory* on those fields is not
   * containment, and it cost everything: under purely benign sibling churn,
   * with no attacker at all, the MCP skill listing was available 0.07% of the
   * time. Containment is `dev`/`ino`/`mode`.
   */
  test("keeps a bound root usable while its children are being written", async () => {
    const root = makeRoot();
    const nested = join(root, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "SKILL.md"), "body");
    const bound = (await bindVerifiedRoot(root, NEVER_ABORTED, CONTEXT))!;
    try {
      writeFileSync(join(root, "sibling.md"), "neighbour");
      writeFileSync(join(nested, "other.md"), "neighbour");
      expect(
        await verifyParentChain(
          bound,
          join("nested", "SKILL.md"),
          NEVER_ABORTED,
          CONTEXT,
        ),
      ).toBe(true);
      const handle = await openVerifiedCandidate(
        bound,
        join("nested", "SKILL.md"),
        NEVER_ABORTED,
        CONTEXT,
      );
      expect(handle).not.toBeNull();
      await handle!.close();
    } finally {
      await closeVerifiedHandle(bound.handle, NEVER_ABORTED, CONTEXT);
    }
  });
});

/**
 * The window between a root's validating `lstat`/`realpath` and the `open`
 * that retains its descriptor. Both proofs that close it are pinned here, and
 * each test fails if *its* proof alone is deleted. They were unpinned before:
 * with both deleted, the instruction-file reader served out-of-scope bodies
 * under an in-scope URI (147,022 attempts, 7,985 served, 1 forged with a
 * natural window; 15,165 / 50 / 33 with the open delayed a millisecond).
 */
describe("root binding across the open", () => {
  test("rejects a root whose name leads to another directory by the time it is opened", async () => {
    const base = makeRoot();
    const dir = join(base, "root");
    mkdirSync(dir);
    const decoy = join(base, "decoy");
    mkdirSync(decoy);
    // Same name, same canonical path, different inode: only the
    // before/opened/after identity proof can tell.
    const context = seamContext((path) => {
      if (path !== dir) return;
      renameSync(dir, join(base, "root.away"));
      renameSync(decoy, dir);
    });
    await expect(
      bindVerifiedRoot(dir, NEVER_ABORTED, context),
    ).rejects.toMatchObject({
      name: "VerifiedRootUnstableError",
      reason: "identity",
    });
  });

  test("rejects a root whose canonical location moves before it is opened", async () => {
    const base = makeRoot();
    const real = join(base, "real");
    mkdirSync(join(real, "dir"), { recursive: true });
    symlinkSync(real, join(base, "parent"));
    const requested = join(base, "parent", "dir");
    // The inode behind the requested name never changes, so the identity
    // proof passes; what moves is where that name canonically leads, which
    // only the final-path proof compares.
    const context = seamContext((path) => {
      if (path !== requested) return;
      renameSync(real, join(base, "real2"));
      unlinkSync(join(base, "parent"));
      symlinkSync(join(base, "real2"), join(base, "parent"));
    });
    await expect(
      bindVerifiedRoot(requested, NEVER_ABORTED, context),
    ).rejects.toMatchObject({
      name: "VerifiedRootUnstableError",
      reason: "final-path",
    });
  });

  test("binds a root whose own contents change across the open", async () => {
    const base = makeRoot();
    const dir = join(base, "root");
    mkdirSync(dir);
    const context = seamContext((path) => {
      if (path !== dir) return;
      // A neighbouring write moves this directory's mtime and ctime between
      // the validating lstat and the fstat of the opened handle. That is not
      // an ancestor swap and must not fail the binding.
      writeFileSync(join(dir, "sibling.md"), "neighbour");
    });
    const bound = await bindVerifiedRoot(dir, NEVER_ABORTED, context);
    expect(bound).not.toBeNull();
    await closeVerifiedHandle(bound!.handle, NEVER_ABORTED, CONTEXT);
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
