import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBoundedTempRepositoryForTest,
  type BoundedRepositoryTestHooks,
  type BoundedTempRepository,
} from "../helpers/bounded-temp-repository.js";

const TRANSACTION_PREFIX = "transaction-";
const QUARANTINE_PREFIX = "quarantine-";
const CONTROL_DIRECTORY = "control";
const BACKUP_DIRECTORY = "backup";
const ORIGINAL_BYTES = Buffer.from("old");
const REPLACEMENT_BYTES = Buffer.from("new");
const SECRET_BYTES = Buffer.from("secret");
const INVENTORY_OVERFLOW_ENTRIES = 3;
const repositories = new Set<BoundedTempRepository>();

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
    throw new AggregateError(
      errors,
      "bounded repository transaction-race cleanup failed",
    );
  }
});

describe("bounded repository transaction races", () => {
  it("never overwrites a raced transaction backup pathname", async () => {
    let armed = false;
    let repository!: BoundedTempRepository;
    repository = await createRepository({
      hit(checkpoint) {
        if (!armed || checkpoint !== "batch:before-backup:0") return;
        writeFileSync(
          join(findTransactionRoot(repository), BACKUP_DIRECTORY, "0"),
          "racer",
        );
      },
    });
    await repository.writeBytes("owned.bin", ORIGINAL_BYTES);
    armed = true;

    await expect(
      repository.writeBytes("owned.bin", REPLACEMENT_BYTES),
    ).rejects.toMatchObject({ name: "AggregateError" });

    expect(readFileSync(repository.resolve("owned.bin"))).toEqual(
      ORIGINAL_BYTES,
    );
    const quarantine = findControlEntry(repository, QUARANTINE_PREFIX);
    expect(readFileSync(join(quarantine, BACKUP_DIRECTORY, "0"), "utf8")).toBe(
      "racer",
    );
    await expect(
      repository.writeBytes("later.bin", Buffer.from("later")),
    ).rejects.toMatchObject({ code: "poisoned" });
  });

  it("detects extra hard links during rollback and poisons mutation", async () => {
    let injected = false;
    let repository!: BoundedTempRepository;
    repository = await createRepository({
      hit(checkpoint) {
        if (injected || checkpoint !== "batch:after-link:0") return;
        injected = true;
        linkSync(
          repository.resolve("target.bin"),
          repository.resolve("survivor.bin"),
        );
        throw new Error("injected after extra hard link");
      },
    });

    await expect(
      repository.writeBytes("target.bin", SECRET_BYTES),
    ).rejects.toMatchObject({ name: "AggregateError" });

    expect(readFileSync(repository.resolve("target.bin"))).toEqual(
      SECRET_BYTES,
    );
    expect(readFileSync(repository.resolve("survivor.bin"))).toEqual(
      SECRET_BYTES,
    );
    expect(lstatSync(repository.resolve("target.bin")).nlink).toBeGreaterThan(
      1,
    );
    expect(repository.usage().entries).toBe(0);
    await expect(
      repository.writeBytes("later.bin", Buffer.from("later")),
    ).rejects.toMatchObject({ code: "poisoned" });
  });

  it("rechecks restored backup content after its final link transition", async () => {
    let armed = false;
    let repository!: BoundedTempRepository;
    repository = await createRepository({
      hit(checkpoint) {
        if (!armed) return;
        if (checkpoint === "batch:before-install:0") {
          throw new Error("injected replacement failure");
        }
        if (checkpoint === "batch:rollback:before-verify-restored:0") {
          writeFileSync(repository.resolve("owned.bin"), "evil");
        }
      },
    });
    await repository.writeBytes("owned.bin", Buffer.from("safe"));
    armed = true;

    await expect(
      repository.writeBytes("owned.bin", Buffer.from("new!")),
    ).rejects.toMatchObject({ name: "AggregateError" });

    expect(readFileSync(repository.resolve("owned.bin"), "utf8")).toBe("evil");
    await expect(
      repository.writeBytes("later.bin", Buffer.from("later")),
    ).rejects.toMatchObject({ code: "poisoned" });
  });

  it("revalidates the complete created-directory set before publication", async () => {
    let injected = false;
    let repository!: BoundedTempRepository;
    repository = await createRepository({
      hit(checkpoint) {
        if (injected || checkpoint !== "directory:after-mkdir:1") return;
        injected = true;
        renameSync(
          repository.resolve("parent"),
          repository.resolve("parent-moved"),
        );
        mkdirSync(repository.resolve("parent"));
      },
    });

    await expect(
      repository.makeDirectory("parent/child"),
    ).rejects.toMatchObject({ name: "AggregateError" });

    expect(repository.usage().entries).toBe(0);
    expect(readdirSync(repository.resolve("parent"))).toEqual([]);
    expect(readdirSync(repository.resolve("parent-moved"))).toEqual(["child"]);
    await expect(
      repository.writeBytes("later.bin", Buffer.from("later")),
    ).rejects.toMatchObject({ code: "poisoned" });
  });

  it("preserves a same-name scaffold file with the wrong identity", async () => {
    let armed = false;
    let repository!: BoundedTempRepository;
    repository = await createRepository({
      hit(checkpoint) {
        if (!armed || checkpoint !== "batch:after-backup:0") return;
        const backup = join(
          findTransactionRoot(repository),
          BACKUP_DIRECTORY,
          "0",
        );
        unlinkSync(backup);
        writeFileSync(backup, "racer");
      },
    });
    await repository.writeBytes("owned.bin", ORIGINAL_BYTES);
    armed = true;

    await expect(
      repository.writeBytes("owned.bin", REPLACEMENT_BYTES),
    ).rejects.toMatchObject({
      code: "committed_cleanup",
      committed: true,
    });

    expect(readFileSync(repository.resolve("owned.bin"))).toEqual(
      REPLACEMENT_BYTES,
    );
    const quarantine = findControlEntry(repository, QUARANTINE_PREFIX);
    expect(readFileSync(join(quarantine, BACKUP_DIRECTORY, "0"), "utf8")).toBe(
      "racer",
    );
  });

  it("bounds unexpected scaffold inventory without recursively deleting it", async () => {
    let repository!: BoundedTempRepository;
    repository = await createRepository(
      {
        hit(checkpoint) {
          if (checkpoint !== "batch:after-install:0") return;
          const backup = join(
            findTransactionRoot(repository),
            BACKUP_DIRECTORY,
          );
          for (let index = 0; index < INVENTORY_OVERFLOW_ENTRIES; index += 1) {
            writeFileSync(join(backup, `unexpected-${index}`), String(index));
          }
        },
      },
      { maxEntries: 1 },
    );

    let failure: unknown;
    try {
      await repository.writeBytes("target.bin", Buffer.from("x"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "committed_cleanup",
      committed: true,
    });
    expect(String((failure as Error).cause)).toMatch(/too many entries/u);

    const quarantine = findControlEntry(repository, QUARANTINE_PREFIX);
    expect(readdirSync(join(quarantine, BACKUP_DIRECTORY)).sort()).toEqual(
      Array.from(
        { length: INVENTORY_OVERFLOW_ENTRIES },
        (_, index) => `unexpected-${index}`,
      ),
    );
    expect(readFileSync(repository.resolve("target.bin"), "utf8")).toBe("x");
    expect(repository.usage().entries).toBe(1);
  });
});

async function createRepository(
  hooks: BoundedRepositoryTestHooks,
  limits: Parameters<typeof createBoundedTempRepositoryForTest>[0] = {},
): Promise<BoundedTempRepository> {
  const repository = await createBoundedTempRepositoryForTest(limits, hooks);
  repositories.add(repository);
  return repository;
}

function findTransactionRoot(repository: BoundedTempRepository): string {
  return findControlEntry(repository, TRANSACTION_PREFIX);
}

function findControlEntry(
  repository: BoundedTempRepository,
  prefix: string,
): string {
  const control = join(dirname(repository.root), CONTROL_DIRECTORY);
  const names = readdirSync(control).filter((name) => name.startsWith(prefix));
  if (names.length !== 1) {
    throw new Error(
      `expected one repository control entry beginning with ${prefix}`,
    );
  }
  return join(control, names[0]!);
}
