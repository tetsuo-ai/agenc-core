import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import {
  decodeFatalUtf8,
  MAX_BOUNDED_FILE_PATH_UTF8_BYTES,
  readBoundedRegularFile,
} from "./bounded-file-io.js";
import {
  assertEqualFndFixtureInventories,
  assertFndFixtureRootUnchanged,
  assertFndInventoryMatchesManifest,
  inspectFndFixtureRoot,
  inventoryFndFixtureRoot,
  resolveFndFixturePath,
} from "./fnd-fixture-inventory.js";
import {
  type FixtureMaterialization,
  snapshotFixtureMaterializations,
} from "./fnd-fixture-materialization.js";
import {
  type FndFixtureEntry,
  type FndFixtureManifest,
  parseFndFixtureManifest,
} from "./fnd-fixture-manifest.js";
import {
  FND_FIXTURE_AUDITED_SHA,
  FND_FIXTURE_MANIFEST_FILE,
  FND_FIXTURE_MANIFEST_SHA256,
  MAX_FND_FIXTURE_BYTES,
  MAX_FND_FIXTURE_MANIFEST_BYTES,
  MAX_FND_FIXTURE_MATERIALIZATION_BYTES,
} from "./fnd-fixture-policy.js";
import {
  isWellFormedUnicode,
  portablePathIdentity,
} from "./portable-repository-path.js";

export type { FixtureMaterialization } from "./fnd-fixture-materialization.js";
export type { FndFixtureEntry } from "./fnd-fixture-manifest.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../fnd/fixtures/", import.meta.url),
);
const AUDIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const FIXTURE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAX_FIXTURE_ID_INPUT_UTF8_BYTES = 1_024;
const CATALOG_TEST_HOOK_KEYS = Object.freeze(["beforeManifestReread"] as const);

export interface FndFixtureCatalog {
  readonly auditSha: string;
  readonly entries: readonly FndFixtureEntry[];

  get(id: string): FndFixtureEntry;
  bytes(id: string): Promise<Buffer>;
  text(id: string): Promise<string>;
  materialize(
    repository: FndFixtureMaterializationRepository,
    requests: readonly FixtureMaterialization[],
  ): Promise<void>;
}

export interface FndFixtureMaterializationWrite {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface FndFixtureMaterializationRepository {
  resolve(relativePath: string): string;
  writeBytesBatch(
    writes: readonly FndFixtureMaterializationWrite[],
  ): Promise<void>;
}

export interface FndFixtureCatalogTestHooks {
  beforeManifestReread(): void | Promise<void>;
}

class FndFixtureCatalogImplementation implements FndFixtureCatalog {
  readonly auditSha: string;
  readonly entries: readonly FndFixtureEntry[];

  readonly #entriesById: ReadonlyMap<string, FndFixtureEntry>;
  readonly #bytesById: ReadonlyMap<string, Buffer>;

  constructor(
    manifest: FndFixtureManifest,
    bytesById: ReadonlyMap<string, Buffer>,
  ) {
    this.auditSha = manifest.auditSha;
    this.entries = Object.freeze(manifest.fixtures.slice());
    this.#entriesById = new Map(
      this.entries.map((entry) => [entry.id, entry] as const),
    );
    this.#bytesById = new Map(bytesById);
    Object.freeze(this);
  }

  get(id: string): FndFixtureEntry {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_FIXTURE_ID_INPUT_UTF8_BYTES ||
      !isWellFormedUnicode(id) ||
      Buffer.byteLength(id, "utf8") > MAX_FIXTURE_ID_INPUT_UTF8_BYTES ||
      !FIXTURE_ID_PATTERN.test(id)
    ) {
      throw new TypeError(
        "FND fixture ID is invalid or exceeds its byte limit",
      );
    }
    const entry = this.#entriesById.get(id);
    if (entry === undefined) throw new Error(`unknown FND fixture: ${id}`);
    return entry;
  }

  async bytes(id: string): Promise<Buffer> {
    this.get(id);
    const bytes = this.#bytesById.get(id);
    if (bytes === undefined) {
      throw new Error(`verified bytes are missing for FND fixture: ${id}`);
    }
    return Buffer.from(bytes);
  }

  async text(id: string): Promise<string> {
    return decodeFatalUtf8(await this.bytes(id), `FND fixture ${id}`);
  }

  async materialize(
    repository: FndFixtureMaterializationRepository,
    requests: readonly FixtureMaterialization[],
  ): Promise<void> {
    if (nodeUtilTypes.isProxy(repository)) {
      throw new TypeError("fixture repository must not be a proxy");
    }
    const snapshot = snapshotFixtureMaterializations(
      requests,
      this.entries.length,
    );
    const destinations = new Set<string>();
    const writes = new Array<{
      readonly relativePath: string;
      readonly bytes: Buffer;
    }>(snapshot.length);
    let aggregateBytes = 0;
    for (let index = 0; index < snapshot.length; index += 1) {
      const request = snapshot[index]!;
      const entry = this.get(request.fixtureId);
      const destinationIdentity = portablePathIdentity(request.destination);
      if (destinations.has(destinationIdentity)) {
        throw new Error(
          `duplicate portable fixture destination: ${request.destination}`,
        );
      }
      destinations.add(destinationIdentity);
      repository.resolve(request.destination);
      const bytes = this.#bytesById.get(entry.id);
      if (bytes === undefined) {
        throw new Error(
          `verified bytes are missing for FND fixture: ${entry.id}`,
        );
      }
      if (
        aggregateBytes >
        MAX_FND_FIXTURE_MATERIALIZATION_BYTES - bytes.byteLength
      ) {
        throw new Error(
          "fixture materialization exceeds its aggregate byte limit",
        );
      }
      aggregateBytes += bytes.byteLength;
      writes[index] = Object.freeze({
        relativePath: request.destination,
        bytes: Buffer.from(bytes),
      });
    }
    await repository.writeBytesBatch(Object.freeze(writes));
  }
}

export function openFndFixtureCatalog(): Promise<FndFixtureCatalog> {
  return openCatalog(FIXTURE_ROOT, FND_FIXTURE_AUDITED_SHA, undefined);
}

/** Test-only seam for proving that corrupted or redirected catalogs fail closed. */
export function openFndFixtureCatalogForTest(
  fixtureRoot: string,
  expectedAuditSha: string,
  hooks?: FndFixtureCatalogTestHooks,
): Promise<FndFixtureCatalog> {
  return openCatalog(fixtureRoot, expectedAuditSha, hooks);
}

async function openCatalog(
  fixtureRoot: string,
  expectedAuditSha: string,
  hooks: FndFixtureCatalogTestHooks | undefined,
): Promise<FndFixtureCatalog> {
  validateCatalogArguments(fixtureRoot, expectedAuditSha);
  const beforeManifestReread = snapshotCatalogTestHook(hooks);
  const rootIdentity = await inspectFndFixtureRoot(fixtureRoot);
  const manifestBytes = await readBoundedRegularFile(
    join(fixtureRoot, FND_FIXTURE_MANIFEST_FILE),
    {
      byteLimit: MAX_FND_FIXTURE_MANIFEST_BYTES,
      label: "FND fixture manifest",
    },
  );
  const manifestDigest = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  if (manifestDigest !== FND_FIXTURE_MANIFEST_SHA256) {
    throw new Error("FND fixture manifest digest changed");
  }
  const manifest = parseFndFixtureManifest(manifestBytes, expectedAuditSha);

  const inventoryBefore = await inventoryFndFixtureRoot(fixtureRoot);
  await assertFndFixtureRootUnchanged(fixtureRoot, rootIdentity);
  assertFndInventoryMatchesManifest(inventoryBefore, manifest);
  const bytesById = await readFixturePayloads(
    fixtureRoot,
    rootIdentity.realPath,
    manifest,
  );
  const inventoryAfter = await inventoryFndFixtureRoot(fixtureRoot);
  assertEqualFndFixtureInventories(inventoryBefore, inventoryAfter);
  await beforeManifestReread?.();
  const manifestAfter = await readBoundedRegularFile(
    join(fixtureRoot, FND_FIXTURE_MANIFEST_FILE),
    {
      byteLimit: MAX_FND_FIXTURE_MANIFEST_BYTES,
      label: "FND fixture manifest",
    },
  );
  if (!manifestAfter.equals(manifestBytes)) {
    throw new Error(
      "FND fixture manifest changed while the catalog was opened",
    );
  }
  await assertFndFixtureRootUnchanged(fixtureRoot, rootIdentity);
  return new FndFixtureCatalogImplementation(manifest, bytesById);
}

async function readFixturePayloads(
  fixtureRoot: string,
  rootRealPath: string,
  manifest: FndFixtureManifest,
): Promise<ReadonlyMap<string, Buffer>> {
  const bytesById = new Map<string, Buffer>();
  for (const entry of manifest.fixtures) {
    const path = await resolveFndFixturePath(
      fixtureRoot,
      rootRealPath,
      entry.path,
    );
    const bytes = await readBoundedRegularFile(path, {
      byteLimit: MAX_FND_FIXTURE_BYTES,
      label: `FND fixture ${entry.id}`,
    });
    if (bytes.byteLength !== entry.byteLength) {
      throw new Error(`FND fixture ${entry.id} byte length changed`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(`FND fixture ${entry.id} digest changed`);
    }
    bytesById.set(entry.id, Buffer.from(bytes));
  }
  return bytesById;
}

function validateCatalogArguments(
  fixtureRoot: string,
  expectedAuditSha: string,
): void {
  if (
    typeof fixtureRoot !== "string" ||
    fixtureRoot.length === 0 ||
    fixtureRoot.length > MAX_BOUNDED_FILE_PATH_UTF8_BYTES ||
    fixtureRoot.includes("\0") ||
    !isWellFormedUnicode(fixtureRoot) ||
    Buffer.byteLength(fixtureRoot, "utf8") > MAX_BOUNDED_FILE_PATH_UTF8_BYTES ||
    !isAbsolute(fixtureRoot)
  ) {
    throw new Error(
      "FND fixture root must be an absolute, well-formed path within its byte limit",
    );
  }
  if (
    typeof expectedAuditSha !== "string" ||
    expectedAuditSha.length !== 40 ||
    !AUDIT_SHA_PATTERN.test(expectedAuditSha)
  ) {
    throw new Error("expected FND audit SHA is invalid");
  }
}

function snapshotCatalogTestHook(
  hooks: FndFixtureCatalogTestHooks | undefined,
): (() => void | Promise<void>) | undefined {
  if (hooks === undefined) return undefined;
  if (
    hooks === null ||
    typeof hooks !== "object" ||
    nodeUtilTypes.isProxy(hooks)
  ) {
    throw new TypeError(
      "FND fixture catalog test hooks must be a plain object",
    );
  }
  const prototype = Object.getPrototypeOf(hooks) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      "FND fixture catalog test hooks must be a plain object",
    );
  }

  const descriptors = Object.getOwnPropertyDescriptors(hooks);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== CATALOG_TEST_HOOK_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !(CATALOG_TEST_HOOK_KEYS as readonly string[]).includes(key),
    )
  ) {
    throw new TypeError(
      "FND fixture catalog test hooks contain an unsupported key",
    );
  }

  const descriptor = descriptors.beforeManifestReread;
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function" ||
    nodeUtilTypes.isProxy(descriptor.value)
  ) {
    throw new TypeError(
      "FND fixture catalog beforeManifestReread hook must be a non-proxy data function",
    );
  }
  return descriptor.value as () => void | Promise<void>;
}
