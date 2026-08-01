import { createHash } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_BOUNDED_FILE_PATH_UTF8_BYTES } from "../helpers/bounded-file-io.js";
import {
  openFndFixtureCatalog,
  openFndFixtureCatalogForTest,
  type FndFixtureMaterializationRepository,
  type FndFixtureMaterializationWrite,
} from "../helpers/fnd-fixtures.js";
import { parseFndFixtureManifest } from "../helpers/fnd-fixture-manifest.js";
import { snapshotFixtureMaterializations } from "../helpers/fnd-fixture-materialization.js";
import {
  MAX_FND_FIXTURE_COUNT,
  MAX_FND_FIXTURE_MANIFEST_BYTES,
} from "../helpers/fnd-fixture-policy.js";

const AUDITED_SHA = "d2b228e87ea63bd6a5d93e6f599f36bce88d672b";
const EXPECTED_FIXTURE_COUNT = 48;
const EXPECTED_FIRST_FIXTURE = "admission.legacy-v14-state-v16.v1";
const EXPECTED_LAST_FIXTURE = "patch.no-final-newline.source.v1";
const OVER_DEEP_DIRECTORY_SEGMENTS = 33;
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { force: true, recursive: true });
      roots.delete(root);
    }),
  );
});

async function copyFixtureCatalog(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "agenc-fnd-fixtures-test-"));
  roots.add(parent);
  const copyRoot = join(parent, "fixtures");
  await cp(FIXTURE_ROOT, copyRoot, { recursive: true });
  return copyRoot;
}

function fakeRepository(): {
  readonly repository: FndFixtureMaterializationRepository;
  readonly writes: Array<readonly FndFixtureMaterializationWrite[]>;
} {
  const writes: Array<readonly FndFixtureMaterializationWrite[]> = [];
  const repository = {
    resolve: (path: string) => `/unused/${path}`,
    writeBytesBatch: async (
      batch: readonly FndFixtureMaterializationWrite[],
    ) => {
      writes.push(batch);
    },
  } satisfies FndFixtureMaterializationRepository;
  return { repository, writes };
}

describe("FND fixture catalog", () => {
  it("opens the complete digest-verified catalog in code-point order", async () => {
    const catalog = await openFndFixtureCatalog();
    const ids = catalog.entries.map((entry) => entry.id);

    expect(catalog.auditSha).toBe(AUDITED_SHA);
    expect(catalog.entries).toHaveLength(EXPECTED_FIXTURE_COUNT);
    expect(ids[0]).toBe(EXPECTED_FIRST_FIXTURE);
    expect(ids.at(-1)).toBe(EXPECTED_LAST_FIXTURE);
    expect(ids).toEqual(
      ids
        .slice()
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    expect(
      (await catalog.bytes("journal.interrupted-tail.v1")).byteLength,
    ).toBe(catalog.get("journal.interrupted-tail.v1").byteLength);
  });

  it("publishes deeply immutable metadata with inert parameter keys", async () => {
    const catalog = await openFndFixtureCatalog();
    const entry = catalog.get("csv.blank-source-id.v1");
    const entries = catalog.entries;

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.tasks)).toBe(true);
    expect(Object.isFrozen(entry.parameters)).toBe(true);
    expect(Object.getPrototypeOf(entry.parameters)).toBe(null);
    expect(entry.parameters).toEqual({ idColumn: "source_id" });
    expect(() => {
      (catalog as unknown as { auditSha: string }).auditSha = "0".repeat(40);
    }).toThrow(TypeError);
    expect(() => {
      (catalog as unknown as { entries: readonly (typeof entry)[] }).entries =
        [];
    }).toThrow(TypeError);
    expect(catalog.auditSha).toBe(AUDITED_SHA);
    expect(catalog.entries).toBe(entries);
    expect(catalog.get(entry.id)).toBe(entry);
    expect(await catalog.bytes(entry.id)).toHaveLength(entry.byteLength);
  });

  it("serves private verified snapshots after source mutation and deletion", async () => {
    const copyRoot = await copyFixtureCatalog();
    const catalog = await openFndFixtureCatalogForTest(copyRoot, AUDITED_SHA);
    const id = "csv.blank-source-id.v1";
    const original = await catalog.bytes(id);
    original.fill(0xff);
    await writeFile(
      join(copyRoot, "csv", "blank-source-id-v1.csv"),
      "changed\n",
    );
    await rm(join(copyRoot, "csv", "extra-field-v1.csv"));

    const second = await catalog.bytes(id);
    expect(second).not.toEqual(original);
    expect(second.byteLength).toBe(catalog.get(id).byteLength);
    expect(second).toEqual(
      await readFile(join(FIXTURE_ROOT, "csv", "blank-source-id-v1.csv")),
    );
  });

  it("detects a manifest change after payload verification", async () => {
    const copyRoot = await copyFixtureCatalog();
    const manifestPath = join(copyRoot, "manifest.json");

    await expect(
      openFndFixtureCatalogForTest(copyRoot, AUDITED_SHA, {
        async beforeManifestReread() {
          const bytes = await readFile(manifestPath);
          const lastIndex = bytes.byteLength - 1;
          bytes[lastIndex] = bytes[lastIndex] === 0x0a ? 0x20 : 0x0a;
          await writeFile(manifestPath, bytes);
        },
      }),
    ).rejects.toThrow(/manifest changed while the catalog was opened/u);
  });

  it("snapshots test hooks and rejects dynamic shapes without invoking them", async () => {
    let accessorCalls = 0;
    const accessorHooks = Object.defineProperty(
      Object.create(null) as object,
      "beforeManifestReread",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return () => {};
        },
      },
    );
    await expect(
      openFndFixtureCatalogForTest(
        FIXTURE_ROOT,
        AUDITED_SHA,
        accessorHooks as Parameters<typeof openFndFixtureCatalogForTest>[2],
      ),
    ).rejects.toThrow(/must be a non-proxy data function/u);
    expect(accessorCalls).toBe(0);

    let proxyReads = 0;
    const proxyHooks = new Proxy(
      { beforeManifestReread() {} },
      {
        get(target, property, receiver) {
          proxyReads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    await expect(
      openFndFixtureCatalogForTest(FIXTURE_ROOT, AUDITED_SHA, proxyHooks),
    ).rejects.toThrow(/must be a plain object/u);
    expect(proxyReads).toBe(0);

    await expect(
      openFndFixtureCatalogForTest(FIXTURE_ROOT, AUDITED_SHA, {
        beforeManifestReread() {},
        unexpected: true,
      } as Parameters<typeof openFndFixtureCatalogForTest>[2]),
    ).rejects.toThrow(/unsupported key/u);

    let originalCalls = 0;
    let replacementCalls = 0;
    const mutableHooks = {
      beforeManifestReread() {
        originalCalls += 1;
      },
    };
    const opening = openFndFixtureCatalogForTest(
      FIXTURE_ROOT,
      AUDITED_SHA,
      mutableHooks,
    );
    mutableHooks.beforeManifestReread = () => {
      replacementCalls += 1;
    };
    await opening;
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  });

  it("rejects malformed and oversized fixture roots before filesystem access", async () => {
    const malformedRoot = join(
      tmpdir(),
      `malformed-${String.fromCharCode(0xd800)}`,
    );
    const oversizedRoot = join(
      tmpdir(),
      "x".repeat(MAX_BOUNDED_FILE_PATH_UTF8_BYTES + 1),
    );

    await expect(
      openFndFixtureCatalogForTest(malformedRoot, AUDITED_SHA),
    ).rejects.toThrow(/well-formed path within its byte limit/u);
    await expect(
      openFndFixtureCatalogForTest(oversizedRoot, AUDITED_SHA),
    ).rejects.toThrow(/well-formed path within its byte limit/u);
  });

  it("detects digest corruption, duplicate manifest keys, and extra payloads", async () => {
    const digestRoot = await copyFixtureCatalog();
    const digestPath = join(digestRoot, "csv", "blank-source-id-v1.csv");
    const changedBytes = await readFile(digestPath);
    changedBytes[0] = changedBytes[0]! ^ 1;
    await writeFile(digestPath, changedBytes);
    await expect(
      openFndFixtureCatalogForTest(digestRoot, AUDITED_SHA),
    ).rejects.toThrow(/digest changed/u);

    const coordinatedRoot = await copyFixtureCatalog();
    const coordinatedPath = join(
      coordinatedRoot,
      "csv",
      "blank-source-id-v1.csv",
    );
    const coordinatedBytes = await readFile(coordinatedPath);
    coordinatedBytes[0] = coordinatedBytes[0]! ^ 1;
    await writeFile(coordinatedPath, coordinatedBytes);
    const coordinatedManifestPath = join(coordinatedRoot, "manifest.json");
    const coordinatedManifest = JSON.parse(
      await readFile(coordinatedManifestPath, "utf8"),
    ) as {
      fixtures: Array<{ path: string; sha256: string }>;
    };
    const coordinatedEntry = coordinatedManifest.fixtures.find(
      (entry) => entry.path === "csv/blank-source-id-v1.csv",
    );
    if (coordinatedEntry === undefined)
      throw new Error("fixture entry missing");
    coordinatedEntry.sha256 = createHash("sha256")
      .update(coordinatedBytes)
      .digest("hex");
    await writeFile(
      coordinatedManifestPath,
      `${JSON.stringify(coordinatedManifest, null, 2)}\n`,
    );
    await expect(
      openFndFixtureCatalogForTest(coordinatedRoot, AUDITED_SHA),
    ).rejects.toThrow(/manifest digest changed/u);

    const duplicateRoot = await copyFixtureCatalog();
    const manifestPath = join(duplicateRoot, "manifest.json");
    const manifest = await readFile(manifestPath, "utf8");
    const duplicateManifest = manifest.replace(
      '"schemaVersion": 1,',
      '"schemaVersion": 1, "schemaVersion": 1,',
    );
    await writeFile(manifestPath, duplicateManifest);
    await expect(
      openFndFixtureCatalogForTest(duplicateRoot, AUDITED_SHA),
    ).rejects.toThrow(/manifest digest changed/u);
    expect(() =>
      parseFndFixtureManifest(Buffer.from(duplicateManifest), AUDITED_SHA),
    ).toThrow(/duplicate object key/u);

    const extraRoot = await copyFixtureCatalog();
    await writeFile(join(extraRoot, "csv", "unmanifested.bin"), "extra\n");
    await expect(
      openFndFixtureCatalogForTest(extraRoot, AUDITED_SHA),
    ).rejects.toThrow(/payload set/u);
  });

  it("rejects syntactically shaped but impossible audit dates", async () => {
    const manifest = await readFile(
      join(FIXTURE_ROOT, "manifest.json"),
      "utf8",
    );
    const impossibleDate = manifest.replace(
      '"auditDate": "2026-07-31"',
      '"auditDate": "2026-99-99"',
    );
    expect(impossibleDate).not.toBe(manifest);
    expect(() =>
      parseFndFixtureManifest(Buffer.from(impossibleDate), AUDITED_SHA),
    ).toThrow(/auditDate is invalid/u);
  });

  it("enforces the manifest byte limit at the parser boundary", async () => {
    const manifest = await readFile(join(FIXTURE_ROOT, "manifest.json"));
    expect(manifest.byteLength).toBeLessThan(MAX_FND_FIXTURE_MANIFEST_BYTES);

    const atLimit = Buffer.alloc(MAX_FND_FIXTURE_MANIFEST_BYTES, 0x20);
    manifest.copy(atLimit);
    expect(parseFndFixtureManifest(atLimit, AUDITED_SHA).auditSha).toBe(
      AUDITED_SHA,
    );

    const overLimit = Buffer.alloc(MAX_FND_FIXTURE_MANIFEST_BYTES + 1, 0x20);
    manifest.copy(overLimit);
    expect(() => parseFndFixtureManifest(overLimit, AUDITED_SHA)).toThrow(
      /exceeds its 262144-byte limit/u,
    );
  });

  it("rejects empty directories, links, and over-deep inventory", async () => {
    const emptyRoot = await copyFixtureCatalog();
    await mkdir(join(emptyRoot, "empty"));
    await expect(
      openFndFixtureCatalogForTest(emptyRoot, AUDITED_SHA),
    ).rejects.toThrow(/empty directory/u);

    const linkedRoot = await copyFixtureCatalog();
    const target = join(linkedRoot, "csv", "blank-source-id-v1.csv");
    try {
      await link(target, join(linkedRoot, "csv", "hard-link.bin"));
      await expect(
        openFndFixtureCatalogForTest(linkedRoot, AUDITED_SHA),
      ).rejects.toThrow(/singly linked/u);
    } catch (error) {
      expect(["EACCES", "ENOTSUP", "EPERM"]).toContain(
        (error as NodeJS.ErrnoException).code,
      );
    }

    const symbolicRoot = await copyFixtureCatalog();
    try {
      await symlink(
        join(symbolicRoot, "csv"),
        join(symbolicRoot, "linked-csv"),
        "dir",
      );
      await expect(
        openFndFixtureCatalogForTest(symbolicRoot, AUDITED_SHA),
      ).rejects.toThrow(/symlink/u);
    } catch (error) {
      expect(["EACCES", "ENOTSUP", "EPERM"]).toContain(
        (error as NodeJS.ErrnoException).code,
      );
    }

    const deepRoot = await copyFixtureCatalog();
    let deepPath = deepRoot;
    for (let index = 0; index < OVER_DEEP_DIRECTORY_SEGMENTS; index += 1) {
      deepPath = join(deepPath, "d");
    }
    await mkdir(deepPath, { recursive: true });
    await expect(
      openFndFixtureCatalogForTest(deepRoot, AUDITED_SHA),
    ).rejects.toThrow(/maxDepth/u);
  });

  it("detects fixture-root timestamp mutation during catalog opening", async () => {
    const copyRoot = await copyFixtureCatalog();
    const before = await lstat(copyRoot, { bigint: true });
    const primaryTimestampMs = Date.UTC(2000, 0, 1);
    const alternateTimestampMs = Date.UTC(2001, 0, 1);
    const primaryTimestampNs = BigInt(primaryTimestampMs) * 1_000_000n;
    const changedTimestamp = new Date(
      before.mtimeNs === primaryTimestampNs
        ? alternateTimestampMs
        : primaryTimestampMs,
    );

    await expect(
      openFndFixtureCatalogForTest(copyRoot, AUDITED_SHA, {
        async beforeManifestReread() {
          await utimes(copyRoot, changedTimestamp, changedTimestamp);
        },
      }),
    ).rejects.toThrow(/fixture root changed while it was opened/u);
    expect((await lstat(copyRoot, { bigint: true })).mtimeNs).not.toBe(
      before.mtimeNs,
    );
  });

  it("bounds materialization counts before inspecting array elements", () => {
    const request = Object.freeze({
      fixtureId: "patch.lf.source.v1",
      destination: "fixture.bin",
    });
    const atLimit = Array.from(
      { length: MAX_FND_FIXTURE_COUNT },
      () => request,
    );
    expect(
      snapshotFixtureMaterializations(atLimit, MAX_FND_FIXTURE_COUNT),
    ).toHaveLength(MAX_FND_FIXTURE_COUNT);

    let getterCalls = 0;
    const overLimit = new Array<FixtureMaterialization>(
      MAX_FND_FIXTURE_COUNT + 1,
    );
    Object.defineProperty(overLimit, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return request;
      },
    });
    expect(() =>
      snapshotFixtureMaterializations(overLimit, MAX_FND_FIXTURE_COUNT),
    ).toThrow(/exceeds catalog size/u);
    expect(getterCalls).toBe(0);

    for (const invalidMaximum of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_FND_FIXTURE_COUNT + 1,
    ]) {
      expect(() => snapshotFixtureMaterializations([], invalidMaximum)).toThrow(
        /maximum must be a safe integer/u,
      );
    }
  });

  it("preflights hostile and colliding materialization requests atomically", async () => {
    const catalog = await openFndFixtureCatalog();
    const { repository, writes } = fakeRepository();

    await catalog.materialize(repository, [
      {
        fixtureId: "patch.crlf.source.v1",
        destination: "case/source.bin",
      },
      {
        fixtureId: "patch.crlf.expected.v1",
        destination: "case/expected.bin",
      },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((write) => write.relativePath)).toEqual([
      "case/source.bin",
      "case/expected.bin",
    ]);

    await expect(
      catalog.materialize(repository, [
        { fixtureId: "patch.lf.source.v1", destination: "Case/File.bin" },
        { fixtureId: "patch.lf.expected.v1", destination: "case/file.BIN" },
      ]),
    ).rejects.toThrow(/duplicate portable fixture destination/u);
    expect(writes).toHaveLength(1);

    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "fixtureId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "patch.lf.source.v1";
      },
    });
    Object.defineProperty(hostile, "destination", {
      enumerable: true,
      value: "hostile.bin",
    });
    await expect(
      catalog.materialize(repository, [hostile] as FixtureMaterialization[]),
    ).rejects.toThrow(/data property/u);
    expect(getterCalls).toBe(0);
    expect(writes).toHaveLength(1);

    const sparse = new Array<FixtureMaterialization>(1);
    await expect(catalog.materialize(repository, sparse)).rejects.toThrow(
      /sparse/u,
    );
    expect(writes).toHaveLength(1);
  });
});

interface FixtureMaterialization {
  readonly fixtureId: string;
  readonly destination: string;
}
