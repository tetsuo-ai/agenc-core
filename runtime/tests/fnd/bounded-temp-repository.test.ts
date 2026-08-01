import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readBoundedDirectoryNames } from "../helpers/bounded-repository-filesystem.js";
import { gitProcessFailure } from "../helpers/bounded-repository-git.js";
import { MAX_GIT_MESSAGE_BYTES } from "../helpers/bounded-repository-policy.js";
import {
  BoundedRepositoryError,
  createBoundedTempRepository,
  createBoundedTempRepositoryForTest,
  type BoundedRepositoryTestHooks,
  type BoundedTempRepository,
} from "../helpers/bounded-temp-repository.js";

const repositories = new Set<BoundedTempRepository>();
const SMALL_BYTE_LIMIT = 4;
const GIT_OUTPUT_BYTE = 1;

afterEach(async () => {
  const errors: unknown[] = [];
  for (const repository of repositories) {
    try {
      await repository.cleanup();
    } catch (error) {
      errors.push(error);
    }
    repositories.delete(repository);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "bounded repository test cleanup failed");
  }
});

async function createRepository(
  options: Parameters<typeof createBoundedTempRepository>[0] = {},
): Promise<BoundedTempRepository> {
  const repository = await createBoundedTempRepository(options);
  repositories.add(repository);
  return repository;
}

async function createHookedRepository(
  hook: BoundedRepositoryTestHooks,
  options: Parameters<typeof createBoundedTempRepository>[0] = {},
): Promise<BoundedTempRepository> {
  const repository = await createBoundedTempRepositoryForTest(options, hook);
  repositories.add(repository);
  return repository;
}

function expectRepositoryError(
  action: () => unknown,
  code: BoundedRepositoryError["code"],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BoundedRepositoryError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected BoundedRepositoryError ${code}`);
}

describe("bounded temporary repository", () => {
  it("rejects invalid directory bounds before opening the directory", async () => {
    const repository = await createRepository();

    for (const maximumEntries of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        readBoundedDirectoryNames(
          join(repository.root, "missing"),
          maximumEntries,
          "bounded directory",
        ),
      ).rejects.toThrow(/non-negative safe integer/u);
    }
  });

  it("rejects accessor-based test hooks without invoking them", async () => {
    let getterCalls = 0;
    const hooks = Object.defineProperty({}, "hit", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => {};
      },
    }) as BoundedRepositoryTestHooks;

    await expect(
      createBoundedTempRepositoryForTest({}, hooks),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(getterCalls).toBe(0);
  });

  it("copies bytes synchronously and enforces entry and byte quotas", async () => {
    const repository = await createRepository({
      maxEntries: 1,
      maxTotalBytes: SMALL_BYTE_LIMIT,
      maxFileBytes: SMALL_BYTE_LIMIT,
    });
    const source = Buffer.from("four");
    const write = repository.writeBytes("emoji-😀.bin", source);
    source.fill(0xff);
    await write;

    expect(await repository.readBytes("emoji-😀.bin")).toEqual(
      Buffer.from("four"),
    );
    expect(repository.usage()).toEqual({
      entries: 1,
      files: 1,
      directories: 0,
      symlinks: 0,
      totalBytes: SMALL_BYTE_LIMIT,
    });
    await expect(
      repository.writeBytes("second.bin", Buffer.from("x")),
    ).rejects.toMatchObject({ code: "quota" });
    expect(repository.usage()).toMatchObject({ entries: 1, totalBytes: 4 });
  });

  it("accepts minimum path limits and preserves repository error taxonomy", async () => {
    const repository = await createRepository({
      maxEntries: 1,
      maxTotalBytes: 1,
      maxFileBytes: 1,
      maxDepth: 1,
      maxPathUtf8Bytes: 1,
      maxSegmentUtf8Bytes: 1,
      maxSegmentUtf16CodeUnits: 1,
      maxGitOutputBytes: 1,
      maxGitWallMs: 1,
    });
    await repository.writeBytes("a", Buffer.from("x"));
    expect(await repository.readBytes("a")).toEqual(Buffer.from("x"));

    await expect(
      createBoundedTempRepository({
        maxPathUtf8Bytes: 1,
        maxSegmentUtf8Bytes: 2,
      }),
    ).rejects.toMatchObject({
      name: "BoundedRepositoryError",
      code: "invalid_input",
    });
  });

  it("does not charge pinned Git metadata against the user entry limit", async () => {
    const repository = await createRepository({ maxEntries: 1 });
    await repository.writeBytes("owned.bin", Buffer.from("before"));
    await repository.initGit();

    await repository.writeBytes("owned.bin", Buffer.from("after"));
    expect(await repository.readBytes("owned.bin")).toEqual(
      Buffer.from("after"),
    );
    expect(repository.usage()).toMatchObject({ entries: 1, files: 1 });
  });

  it("preflights nested batches, replacements, and portable collisions", async () => {
    const repository = await createRepository({
      maxEntries: 5,
      maxTotalBytes: 8,
      maxFileBytes: 4,
    });
    await repository.writeBytesBatch([
      { relativePath: "nested/a.bin", bytes: Buffer.from("aa") },
      { relativePath: "nested/b.bin", bytes: Buffer.from("bb") },
    ]);
    expect(repository.usage()).toEqual({
      entries: 3,
      files: 2,
      directories: 1,
      symlinks: 0,
      totalBytes: 4,
    });
    await repository.writeBytesBatch([
      { relativePath: "nested/a.bin", bytes: Buffer.from("four") },
    ]);
    expect(await repository.readBytes("nested/a.bin")).toEqual(
      Buffer.from("four"),
    );
    expect(repository.usage().totalBytes).toBe(6);

    const before = repository.usage();
    await expect(
      repository.writeBytesBatch([
        { relativePath: "Case.bin", bytes: Buffer.from("x") },
        { relativePath: "case.BIN", bytes: Buffer.from("y") },
      ]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(repository.usage()).toEqual(before);
    await expect(
      repository.writeBytesBatch([
        { relativePath: "tree", bytes: Buffer.from("x") },
        { relativePath: "tree/child", bytes: Buffer.from("y") },
      ]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(repository.usage()).toEqual(before);
  });

  it("rejects sparse, accessor, proxy, shared, and detached inputs before mutation", async () => {
    const repository = await createRepository();
    const sparse = new Array<{ relativePath: string; bytes: Uint8Array }>(1);
    expectRepositoryError(
      () => repository.writeBytesBatch(sparse),
      "invalid_input",
    );
    expectRepositoryError(
      () =>
        repository.writeBytesBatch(
          new Proxy([], {}) as Array<{
            relativePath: string;
            bytes: Uint8Array;
          }>,
        ),
      "invalid_input",
    );

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "relativePath", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "accessor.bin";
      },
    });
    Object.defineProperty(accessor, "bytes", {
      enumerable: true,
      value: Buffer.from("x"),
    });
    expectRepositoryError(
      () =>
        repository.writeBytesBatch([accessor] as Array<{
          relativePath: string;
          bytes: Uint8Array;
        }>),
      "invalid_input",
    );
    expect(getterCalls).toBe(0);

    expectRepositoryError(
      () =>
        repository.writeBytes(
          "shared.bin",
          new Uint8Array(new SharedArrayBuffer(1)),
        ),
      "invalid_input",
    );
    const detached = new Uint8Array([1]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expectRepositoryError(
      () => repository.writeBytes("detached.bin", detached),
      "invalid_input",
    );
    expect(repository.usage().entries).toBe(0);
  });

  it("rolls back a mixed replacement/create transaction exactly", async () => {
    let handler: (checkpoint: string) => void = () => {};
    const repository = await createHookedRepository({
      hit(checkpoint) {
        handler(checkpoint);
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("old"));
    const before = repository.usage();
    handler = (checkpoint) => {
      if (checkpoint === "batch:before-install:1") {
        throw new Error("injected install failure");
      }
    };

    await expect(
      repository.writeBytesBatch([
        { relativePath: "owned.bin", bytes: Buffer.from("new") },
        { relativePath: "nested/new.bin", bytes: Buffer.from("new") },
      ]),
    ).rejects.toThrow(/injected install failure/u);
    handler = () => {};
    expect(repository.usage()).toEqual(before);
    expect(await repository.readBytes("owned.bin")).toEqual(Buffer.from("old"));
    await expect(repository.readBytes("nested/new.bin")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects same-length staged-byte tampering before install", async () => {
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint !== "batch:before-install:0") return;
        const control = join(dirname(repository.root), "control");
        const transaction = readdirSync(control).find((name) =>
          name.startsWith("transaction-"),
        );
        if (transaction === undefined) {
          throw new Error("transaction staging directory was not found");
        }
        writeFileSync(join(control, transaction, "stage", "0"), "evil");
      },
    });

    await expect(
      repository.writeBytes("owned.bin", Buffer.from("safe")),
    ).rejects.toThrow(/content|digest|external/u);
    expect(repository.usage().entries).toBe(0);
    await expect(
      readFile(repository.resolve("owned.bin")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects same-length replacement tampering after batch planning", async () => {
    let tamper = false;
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (tamper && checkpoint === "batch:before-backup:0") {
          writeFileSync(repository.resolve("owned.bin"), "evil");
        }
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("safe"));
    tamper = true;

    await expect(
      repository.writeBytes("owned.bin", Buffer.from("new!")),
    ).rejects.toThrow(/content|digest|external/u);
    expect(await readFile(repository.resolve("owned.bin"), "utf8")).toBe(
      "evil",
    );
  });

  it("revalidates owned parents immediately before installation", async () => {
    let exchangeParent = false;
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (!exchangeParent || checkpoint !== "batch:before-install:0") return;
        renameSync(
          repository.resolve("owned"),
          repository.resolve("owned-moved"),
        );
        mkdirSync(repository.resolve("owned"));
      },
    });
    await repository.makeDirectory("owned");
    const before = repository.usage();
    exchangeParent = true;

    await expect(
      repository.writeBytes("owned/child.bin", Buffer.from("child")),
    ).rejects.toThrow(/external|parent|identity/u);
    expect(repository.usage()).toEqual(before);
    await expect(
      readFile(repository.resolve("owned/child.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks every installed file before publishing the batch ledger", async () => {
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint === "batch:before-install:1") {
          writeFileSync(repository.resolve("first.bin"), "evil!");
        }
      },
    });

    await expect(
      repository.writeBytesBatch([
        { relativePath: "first.bin", bytes: Buffer.from("first") },
        { relativePath: "second.bin", bytes: Buffer.from("second") },
      ]),
    ).rejects.toThrow(/content|digest|external/u);
    expect(repository.usage().entries).toBe(0);
    await expect(
      readFile(repository.resolve("first.bin")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(repository.resolve("second.bin")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never restores a backup whose original content was tampered", async () => {
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint === "batch:after-backup:0") {
          const control = join(dirname(repository.root), "control");
          const transaction = readdirSync(control).find((name) =>
            name.startsWith("transaction-"),
          );
          if (transaction === undefined) {
            throw new Error("transaction backup directory was not found");
          }
          writeFileSync(join(control, transaction, "backup", "0"), "evil");
        }
        if (checkpoint === "batch:before-install:1") {
          throw new Error("injected after backup tamper");
        }
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("safe"));

    await expect(
      repository.writeBytesBatch([
        { relativePath: "owned.bin", bytes: Buffer.from("new!") },
        { relativePath: "second.bin", bytes: Buffer.from("next") },
      ]),
    ).rejects.toMatchObject({ name: "AggregateError" });
    await expect(
      readFile(repository.resolve("owned.bin")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rechecks portable sibling aliases immediately before installation", async () => {
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint === "batch:before-install:0") {
          writeFileSync(repository.resolve("Case.bin"), "racer");
        }
      },
    });

    await expect(
      repository.writeBytes("case.bin", Buffer.from("owned")),
    ).rejects.toThrow(/collision|external|sibling/u);
    expect(repository.usage().entries).toBe(0);
    expect(await readFile(repository.resolve("Case.bin"), "utf8")).toBe(
      "racer",
    );
  });

  it("never removes a racer at an unexecuted destination", async () => {
    let repository: BoundedTempRepository;
    let handler: (checkpoint: string) => void = () => {};
    repository = await createHookedRepository({
      hit(checkpoint) {
        handler(checkpoint);
      },
    });
    handler = (checkpoint) => {
      if (checkpoint === "batch:before-install:1") {
        writeFileSync(repository.resolve("racer.bin"), "racer");
        throw new Error("injected after racer");
      }
    };

    await expect(
      repository.writeBytesBatch([
        { relativePath: "first.bin", bytes: Buffer.from("first") },
        { relativePath: "racer.bin", bytes: Buffer.from("planned") },
      ]),
    ).rejects.toThrow(/injected after racer/u);
    handler = () => {};
    expect(repository.usage().entries).toBe(0);
    expect(await repository.readBytes("racer.bin")).toEqual(
      Buffer.from("racer"),
    );
    await expect(repository.readBytes("first.bin")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never overwrites a racer while restoring a rollback backup", async () => {
    let handler: (checkpoint: string) => void = () => {};
    const repository = await createHookedRepository({
      hit(checkpoint) {
        handler(checkpoint);
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("old"));
    handler = (checkpoint) => {
      if (checkpoint === "batch:before-install:0") {
        throw new Error("primary install failure");
      }
      if (checkpoint === "batch:rollback:before-restore-link:0") {
        writeFileSync(repository.resolve("owned.bin"), "racer");
      }
    };

    await expect(
      repository.writeBytes("owned.bin", Buffer.from("new")),
    ).rejects.toMatchObject({ name: "AggregateError" });
    handler = () => {};
    expect(await readFile(repository.resolve("owned.bin"), "utf8")).toBe(
      "racer",
    );
    await expect(
      repository.writeBytes("later.bin", Buffer.from("later")),
    ).rejects.toMatchObject({ code: "poisoned" });
  });

  it("aggregates rollback failure and poisons later mutation", async () => {
    let handler: (checkpoint: string) => void = () => {};
    const repository = await createHookedRepository({
      hit(checkpoint) {
        handler(checkpoint);
      },
    });
    handler = (checkpoint) => {
      if (checkpoint === "batch:before-install:1") {
        throw new Error("primary failure");
      }
      if (checkpoint === "batch:rollback:before-remove-install:0") {
        throw new Error("rollback failure");
      }
    };

    await expect(
      repository.writeBytesBatch([
        { relativePath: "first.bin", bytes: Buffer.from("first") },
        { relativePath: "second.bin", bytes: Buffer.from("second") },
      ]),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        expect.objectContaining({ message: "primary failure" }),
        expect.objectContaining({ message: "rollback failure" }),
      ],
    });
    handler = () => {};
    await expect(
      repository.writeBytes("later.bin", Buffer.from("later")),
    ).rejects.toMatchObject({ code: "poisoned" });
    expect(await repository.readBytes("first.bin")).toEqual(
      Buffer.from("first"),
    );
  });

  it("supports owned directory rename/removal and rejects unowned mutation", async () => {
    const repository = await createRepository();
    await repository.writeBytes("tree/child.bin", Buffer.from("child"));
    await repository.rename("tree", "moved");
    expect(await repository.readBytes("moved/child.bin")).toEqual(
      Buffer.from("child"),
    );
    await repository.remove("moved/child.bin");
    await repository.remove("moved");
    expect(repository.usage().entries).toBe(0);

    await writeFile(repository.resolve("external.bin"), "external");
    await expect(repository.remove("external.bin")).rejects.toMatchObject({
      code: "external_change",
    });
    await expect(
      repository.writeBytes("external.bin", Buffer.from("replacement")),
    ).rejects.toMatchObject({ code: "external_change" });
    expect(await repository.readBytes("external.bin")).toEqual(
      Buffer.from("external"),
    );
  });

  it("rejects a missing ledger-owned descendant before directory rename", async () => {
    const repository = await createRepository();
    await repository.writeBytes("tree/child.bin", Buffer.from("child"));
    await unlink(repository.resolve("tree/child.bin"));

    await expect(repository.rename("tree", "moved")).rejects.toMatchObject({
      code: "external_change",
    });
    expect(repository.usage()).toMatchObject({
      entries: 2,
      files: 1,
      directories: 1,
    });
    expect(await lstat(repository.resolve("tree"))).toBeDefined();
    await expect(lstat(repository.resolve("moved"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a missing ledger-owned descendant before directory gitAdd", async () => {
    const repository = await createRepository();
    await repository.writeBytes("tree/child.bin", Buffer.from("child"));
    await repository.initGit();
    await repository.gitAdd(["tree"]);
    await repository.gitCommit("test: establish owned tree");
    await unlink(repository.resolve("tree/child.bin"));

    await expect(repository.gitAdd(["tree"])).rejects.toMatchObject({
      code: "external_change",
    });
  });

  it("rejects an external portable alias beside an owned ancestor", async () => {
    const repository = await createRepository();
    await repository.makeDirectory("Case");
    const alias = repository.resolve("case");
    try {
      await mkdir(alias);
    } catch (error) {
      expect(["EEXIST", "EPERM"]).toContain(
        (error as NodeJS.ErrnoException).code,
      );
      return;
    }

    try {
      await expect(
        repository.writeBytes("Case/child.bin", Buffer.from("blocked")),
      ).rejects.toMatchObject({ code: "external_change" });
      await expect(
        lstat(repository.resolve("Case/child.bin")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(alias, { recursive: true, force: false });
    }
  });

  it("rejects permission changes to an owned file identity", async () => {
    const repository = await createRepository();
    await repository.writeBytes("owned.bin", Buffer.from("safe"));
    const path = repository.resolve("owned.bin");
    const before = await lstat(path, { bigint: true });
    await chmod(path, Number(before.mode & 0o777n) ^ 0o200);
    const after = await lstat(path, { bigint: true });
    if (after.mode === before.mode) {
      expect(process.platform).toBe("win32");
      return;
    }

    await expect(repository.readBytes("owned.bin")).rejects.toMatchObject({
      code: "external_change",
    });
  });

  it("rechecks rename boundaries without overwriting a destination racer", async () => {
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint === "rename:before-commit") {
          writeFileSync(repository.resolve("destination.bin"), "racer");
        }
      },
    });
    await repository.writeBytes("source.bin", Buffer.from("owned"));

    await expect(
      repository.rename("source.bin", "destination.bin"),
    ).rejects.toMatchObject({ code: "external_change" });
    expect(await readFile(repository.resolve("source.bin"), "utf8")).toBe(
      "owned",
    );
    expect(await readFile(repository.resolve("destination.bin"), "utf8")).toBe(
      "racer",
    );
  });

  it("poisons a committed rename whose content changes before verification", async () => {
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint === "rename:after-commit-before-verify") {
          writeFileSync(repository.resolve("destination.bin"), "evil!");
        }
      },
    });
    await repository.writeBytes("source.bin", Buffer.from("owned"));

    await expect(
      repository.rename("source.bin", "destination.bin"),
    ).rejects.toMatchObject({
      code: "committed_cleanup",
      committed: true,
    });
    await expect(
      repository.writeBytes("later.bin", Buffer.from("later")),
    ).rejects.toMatchObject({ code: "poisoned" });
  });

  it("rechecks remove boundaries and preserves a substituted source", async () => {
    let repository: BoundedTempRepository;
    const displacedName = "owned-displaced.bin";
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint !== "remove:before-commit") return;
        renameSync(
          repository.resolve("owned.bin"),
          repository.resolve(displacedName),
        );
        writeFileSync(repository.resolve("owned.bin"), "racer");
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("owned"));

    await expect(repository.remove("owned.bin")).rejects.toMatchObject({
      code: "external_change",
    });
    expect(await readFile(repository.resolve("owned.bin"), "utf8")).toBe(
      "racer",
    );
    expect(await readFile(repository.resolve(displacedName), "utf8")).toBe(
      "owned",
    );
  });

  it("rejects same-length in-place tampering before reads or destructive mutation", async () => {
    const repository = await createRepository();
    await repository.writeBytes("owned.bin", Buffer.from("safe"));
    await writeFile(repository.resolve("owned.bin"), "evil");

    await expect(repository.readBytes("owned.bin")).rejects.toMatchObject({
      code: "external_change",
    });
    await expect(repository.remove("owned.bin")).rejects.toMatchObject({
      code: "external_change",
    });
    expect(await readFile(repository.resolve("owned.bin"), "utf8")).toBe(
      "evil",
    );
  });

  it("rejects portable collisions with unowned sibling names", async () => {
    const repository = await createRepository();
    await writeFile(repository.resolve("Case.bin"), "external");

    await expect(
      repository.writeBytes("case.BIN", Buffer.from("owned")),
    ).rejects.toMatchObject({ code: "external_change" });
    expect(await readFile(repository.resolve("Case.bin"), "utf8")).toBe(
      "external",
    );
    await expect(
      readFile(repository.resolve("case.BIN")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never adopts a directory substituted after mkdir", async () => {
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint !== "directory:after-mkdir-before-verify:0") return;
        const created = repository.resolve("victim");
        renameSync(created, `${created}-escaped`);
        mkdirSync(created, { mode: 0o700 });
      },
    });

    await expect(repository.makeDirectory("victim")).rejects.toThrow();
    expect(repository.usage().entries).toBe(0);
    expect(readdirSync(repository.root)).toEqual(["victim", "victim-escaped"]);
    await expect(repository.makeDirectory("later")).rejects.toMatchObject({
      code: "poisoned",
    });
  });

  it("rejects hard links and symlink traversal", async () => {
    const repository = await createRepository();
    await repository.writeBytes("source.bin", Buffer.from("source"));
    await link(
      repository.resolve("source.bin"),
      repository.resolve("alias.bin"),
    );
    await expect(repository.readBytes("source.bin")).rejects.toThrow(
      /external change|singly linked/u,
    );

    const linked = await repository.createSymlink(
      "redirect",
      process.platform === "win32" ? repository.root : "/",
      "directory",
    );
    if (linked === "created") {
      await expect(
        repository.writeBytes("redirect/outside.bin", Buffer.from("blocked")),
      ).rejects.toThrow();
    } else {
      expect(linked).toBe("unsupported");
    }
  });

  it("quarantines cleanup and never deletes a recreated root pathname", async () => {
    let repository: BoundedTempRepository;
    let recreate = false;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint !== "cleanup:after-quarantine" || !recreate) return;
        mkdirSync(repository.root, { mode: 0o700 });
        writeFileSync(join(repository.root, "must-survive.txt"), "survives");
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("owned"));
    recreate = true;
    await expect(repository.cleanup()).rejects.toMatchObject({
      code: "external_change",
    });
    repositories.delete(repository);
    expect(
      await readFile(join(repository.root, "must-survive.txt"), "utf8"),
    ).toBe("survives");
    await rm(repository.root, { recursive: true, force: false });
    await repository.cleanup();
    await repository.cleanup();
  });

  it("fails closed when a quarantined repository is moved away", async () => {
    let repository: BoundedTempRepository;
    let quarantinePath: string | undefined;
    let escapedPath: string | undefined;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint !== "cleanup:after-quarantine") return;
        const allocation = dirname(repository.root);
        quarantinePath = readdirSync(allocation)
          .filter((name) => name.startsWith("quarantine-"))
          .map((name) => join(allocation, name))[0];
        if (quarantinePath === undefined) {
          throw new Error("quarantine path was not found");
        }
        escapedPath = `${repository.root}-escaped`;
        renameSync(quarantinePath, escapedPath);
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("owned"));

    await expect(repository.cleanup()).rejects.toMatchObject({
      code: "external_change",
    });
    expect(quarantinePath).toBeDefined();
    expect(escapedPath).toBeDefined();
    expect(await readFile(join(escapedPath!, "owned.bin"), "utf8")).toBe(
      "owned",
    );
    renameSync(escapedPath!, quarantinePath!);
    await repository.cleanup();
    repositories.delete(repository);
  });

  it("rechecks quarantine identity immediately before recursive removal", async () => {
    let repository: BoundedTempRepository;
    let quarantinePath: string | undefined;
    let escapedPath: string | undefined;
    let exchange = true;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint !== "cleanup:before-repository-remove" || !exchange)
          return;
        const allocation = dirname(repository.root);
        quarantinePath = readdirSync(allocation)
          .filter((name) => name.startsWith("quarantine-"))
          .map((name) => join(allocation, name))[0];
        if (quarantinePath === undefined) {
          throw new Error("quarantine path was not found");
        }
        escapedPath = `${repository.root}-escaped-before-remove`;
        renameSync(quarantinePath, escapedPath);
        mkdirSync(quarantinePath, { mode: 0o700 });
        writeFileSync(join(quarantinePath, "must-survive.txt"), "survives");
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("owned"));

    await expect(repository.cleanup()).rejects.toMatchObject({
      code: "external_change",
    });
    expect(
      await readFile(join(quarantinePath!, "must-survive.txt"), "utf8"),
    ).toBe("survives");
    exchange = false;
    await rm(quarantinePath!, { recursive: true, force: false });
    await rename(escapedPath!, quarantinePath!);
    await repository.cleanup();
    repositories.delete(repository);
  });

  it("refuses cleanup when the original root identity is substituted", async () => {
    const repository = await createRepository();
    const displaced = `${repository.root}-displaced`;
    await rename(repository.root, displaced);
    try {
      await mkdir(repository.root, { mode: 0o700 });
      await writeFile(join(repository.root, "must-survive.txt"), "survives");
      await expect(repository.cleanup()).rejects.toMatchObject({
        code: "external_change",
      });
      expect(
        await readFile(join(repository.root, "must-survive.txt"), "utf8"),
      ).toBe("survives");
    } finally {
      await rm(repository.root, { recursive: true, force: true });
      await rename(displaced, repository.root);
    }
    await repository.cleanup();
    repositories.delete(repository);
  });

  it("creates deterministic Git commits with hooks disabled", async () => {
    const first = await createRepository();
    await first.initGit();
    await mkdir(join(first.root, ".git", "hooks"));
    await writeFile(
      join(first.root, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nexit 99\n",
      { mode: 0o700 },
    );
    await first.writeBytes("tracked.txt", Buffer.from("tracked\n"));
    await first.gitAdd(["tracked.txt"]);
    const firstHead = await first.gitCommit("test: deterministic commit");
    expect(firstHead).toMatch(/^[0-9a-f]{40}$/u);
    expect(await first.gitStatus()).toBe("");

    const second = await createRepository();
    await second.initGit();
    await second.writeBytes("tracked.txt", Buffer.from("tracked\n"));
    await second.gitAdd(["tracked.txt"]);
    expect(await second.gitCommit("test: deterministic commit")).toBe(
      firstHead,
    );
  });

  it("rejects duplicate Git path identities and audits overlapping paths once", async () => {
    const auditedPaths: string[] = [];
    const repository = await createHookedRepository({
      hit(checkpoint) {
        const prefix = "git-add:before-content-audit:";
        if (checkpoint.startsWith(prefix)) {
          auditedPaths.push(checkpoint.slice(prefix.length));
        }
      },
    });
    await repository.writeBytes("tree/child.bin", Buffer.from("tracked\n"));
    await repository.initGit();

    await expect(repository.gitAdd(["tree", "TREE"])).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(auditedPaths).toEqual([]);

    await repository.gitAdd(["tree/child.bin", "tree"]);
    expect(auditedPaths).toEqual(["tree"]);
  });

  it("rechecks owned content after the final pre-Git checkpoint", async () => {
    let tamper = false;
    let repository: BoundedTempRepository;
    repository = await createHookedRepository({
      hit(checkpoint) {
        if (!tamper || checkpoint !== "git-add:before-supervised-run") return;
        writeFileSync(repository.resolve("tracked.txt"), "evil\n");
      },
    });
    await repository.initGit();
    await repository.writeBytes("tracked.txt", Buffer.from("safe\n"));
    tamper = true;

    await expect(repository.gitAdd(["tracked.txt"])).rejects.toMatchObject({
      code: "external_change",
    });

    tamper = false;
    expect(await readFile(repository.resolve("tracked.txt"), "utf8")).toBe(
      "evil\n",
    );
    expect(await repository.gitStatus()).toBe("?? tracked.txt\n");
  });

  it("rejects oversized Git-add invocations before launch without poisoning", async () => {
    let launchCheckpoints = 0;
    const repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint === "git-add:before-supervised-run") {
          launchCheckpoints += 1;
        }
      },
    });
    const paths = Array.from(
      { length: 24 },
      (_, index) =>
        `launch-boundary-${String(index).padStart(2, "0")}-${"x".repeat(170)}.txt`,
    );
    await repository.writeBytesBatch(
      paths.map((relativePath) => ({
        relativePath,
        bytes: Buffer.from("x"),
      })),
    );
    await repository.initGit();

    await expect(repository.gitAdd(paths)).rejects.toMatchObject({
      code: "git",
      kind: "discovery",
      mutationOutcome: "not_applicable",
    });
    expect(launchCheckpoints).toBe(0);

    await repository.gitAdd([paths[0]!]);
    expect(launchCheckpoints).toBe(1);
    expect(await repository.gitStatus()).toContain(`A  ${paths[0]!}`);
  });

  it("admits an oversized raw Git path list after directory collapse", async () => {
    const repository = await createRepository();
    const descendants = Array.from(
      { length: 24 },
      (_, index) =>
        `tree/collapse-boundary-${String(index).padStart(2, "0")}-${"x".repeat(160)}.txt`,
    );
    await repository.writeBytesBatch(
      descendants.map((relativePath) => ({
        relativePath,
        bytes: Buffer.from("x"),
      })),
    );
    await repository.initGit();

    await repository.gitAdd([...descendants, "tree"]);

    expect(await repository.gitStatus()).toContain("A  tree/");
  });

  it("rejects oversized commit messages before launch without poisoning", async () => {
    let commitLaunchCheckpoints = 0;
    const repository = await createHookedRepository({
      hit(checkpoint) {
        if (checkpoint === "git-commit:before-supervised-run") {
          commitLaunchCheckpoints += 1;
        }
      },
    });
    await repository.initGit();
    await repository.writeBytes("tracked.txt", Buffer.from("tracked\n"));
    await repository.gitAdd(["tracked.txt"]);

    await expect(
      repository.gitCommit("m".repeat(MAX_GIT_MESSAGE_BYTES)),
    ).rejects.toMatchObject({
      code: "git",
      kind: "discovery",
      mutationOutcome: "not_applicable",
    });
    expect(commitLaunchCheckpoints).toBe(0);

    const head = await repository.gitCommit(
      "test: valid commit after admission rejection",
    );
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    expect(commitLaunchCheckpoints).toBe(1);
  });

  it("fails closed when supervised Git output exceeds its bound", async () => {
    const repository = await createRepository({
      maxGitOutputBytes: GIT_OUTPUT_BYTE,
    });
    await repository.initGit();
    await repository.writeBytes("untracked.txt", Buffer.from("untracked\n"));
    await expect(repository.gitStatus()).rejects.toMatchObject({ code: "git" });
  });

  it("blocks cleanup after a classified unproven Git spawn failure", async () => {
    let injectFailure = false;
    const repository = await createHookedRepository({
      hit(checkpoint) {
        if (injectFailure && checkpoint === "git-add:before-supervised-run") {
          throw gitProcessFailure(
            "stage repository files",
            {
              exitCode: null,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              stopReason: "spawn_error",
              forced: false,
              backstopExpired: false,
              error: new Error("injected spawn failure"),
            },
            true,
          );
        }
      },
    });
    await repository.initGit();
    await repository.writeBytes("must-survive.txt", Buffer.from("survives"));
    const allocation = dirname(repository.root);
    try {
      injectFailure = true;
      await expect(
        repository.gitAdd(["must-survive.txt"]),
      ).rejects.toMatchObject({
        kind: "survivors_unproven",
        processState: "survivors_unproven",
      });
      await expect(repository.cleanup()).rejects.toMatchObject({
        code: "poisoned",
        message: expect.stringContaining("cleanup is unproven"),
      });
      expect(
        await readFile(repository.resolve("must-survive.txt"), "utf8"),
      ).toBe("survives");
    } finally {
      repositories.delete(repository);
      await rm(allocation, { recursive: true, force: true });
    }
  });

  it("marks post-commit HEAD verification failure as committed", async () => {
    const repository = await createRepository({
      maxGitOutputBytes: GIT_OUTPUT_BYTE,
    });
    await repository.initGit();
    await repository.writeBytes("tracked.txt", Buffer.from("tracked\n"));
    await repository.gitAdd(["tracked.txt"]);

    await expect(
      repository.gitCommit("test: ambiguous head read"),
    ).rejects.toMatchObject({
      code: "committed_cleanup",
      committed: true,
    });
    expect(
      (
        await readFile(
          join(repository.root, ".git", "refs", "heads", "main"),
          "utf8",
        )
      ).trim(),
    ).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("refuses to stage unowned external paths", async () => {
    const repository = await createRepository();
    await repository.initGit();
    await writeFile(repository.resolve("external.txt"), "external\n");

    await expect(repository.gitAdd(["external.txt"])).rejects.toMatchObject({
      code: "external_change",
    });
  });

  it("rejects redirected Git metadata before spawning Git", async () => {
    const first = await createRepository();
    const second = await createRepository();
    await first.initGit();
    await second.initGit();
    await first.writeBytes("tracked.txt", Buffer.from("tracked\n"));
    const firstGit = join(first.root, ".git");
    const displacedGit = `${firstGit}-displaced`;
    await rename(firstGit, displacedGit);
    try {
      await symlink(join(second.root, ".git"), firstGit, "dir");
    } catch (error) {
      await rename(displacedGit, firstGit);
      expect(["EACCES", "ENOTSUP", "EPERM"]).toContain(
        (error as NodeJS.ErrnoException).code,
      );
      return;
    }
    try {
      await expect(first.gitAdd(["tracked.txt"])).rejects.toMatchObject({
        code: "external_change",
      });
      await expect(
        readFile(join(second.root, ".git", "index")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(firstGit, { force: false });
      await rename(displacedGit, firstGit);
    }
  });

  it("rejects redirected Git object storage before spawning Git", async () => {
    const first = await createRepository();
    const second = await createRepository();
    await first.initGit();
    await second.initGit();
    await first.writeBytes("tracked.txt", Buffer.from("tracked\n"));
    const firstObjects = join(first.root, ".git", "objects");
    const displacedObjects = `${firstObjects}-displaced`;
    const secondObjects = join(second.root, ".git", "objects");
    const before = readdirSync(secondObjects).slice().sort();
    await rename(firstObjects, displacedObjects);
    try {
      await symlink(secondObjects, firstObjects, "dir");
    } catch (error) {
      await rename(displacedObjects, firstObjects);
      expect(["EACCES", "ENOTSUP", "EPERM"]).toContain(
        (error as NodeJS.ErrnoException).code,
      );
      return;
    }
    try {
      await expect(first.gitAdd(["tracked.txt"])).rejects.toMatchObject({
        code: "external_change",
      });
      expect(readdirSync(secondObjects).slice().sort()).toEqual(before);
    } finally {
      await rm(firstObjects, { force: false });
      await rename(displacedObjects, firstObjects);
    }
  });

  it("rejects Git common-directory redirection before spawning Git", async () => {
    const first = await createRepository();
    const second = await createRepository();
    await first.initGit();
    await second.initGit();
    await first.writeBytes("tracked.txt", Buffer.from("tracked\n"));
    const secondObjects = join(second.root, ".git", "objects");
    const before = readdirSync(secondObjects).slice().sort();
    await writeFile(
      join(first.root, ".git", "commondir"),
      `${join(second.root, ".git")}\n`,
    );

    await expect(first.gitAdd(["tracked.txt"])).rejects.toMatchObject({
      code: "external_change",
    });
    expect(readdirSync(secondObjects).slice().sort()).toEqual(before);
  });

  it("rejects Git object alternates before spawning Git", async () => {
    const first = await createRepository();
    const second = await createRepository();
    await first.initGit();
    await second.initGit();
    await first.writeBytes("tracked.txt", Buffer.from("tracked\n"));
    await writeFile(
      join(first.root, ".git", "objects", "info", "alternates"),
      `${join(second.root, ".git", "objects")}\n`,
    );

    await expect(first.gitAdd(["tracked.txt"])).rejects.toMatchObject({
      code: "external_change",
    });
  });

  it("rejects in-place local Git configuration changes", async () => {
    const repository = await createRepository();
    await repository.initGit();
    const configPath = join(repository.root, ".git", "config");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, `${config}\n[core]\n\tworktree = /outside\n`);

    await expect(repository.gitStatus()).rejects.toMatchObject({
      code: "external_change",
    });
  });
});
