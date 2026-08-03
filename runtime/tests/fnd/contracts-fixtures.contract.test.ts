import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const AUDITED_SHA = "d2b228e87ea63bd6a5d93e6f599f36bce88d672b";
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FIXTURE_ROOT_REAL = realpathSync(FIXTURE_ROOT);
const MANIFEST_PATH = fileURLToPath(
  new URL("./fixtures/manifest.json", import.meta.url),
);
const CRITICAL_PATH_DOC_ROOT = fileURLToPath(
  new URL("../../../docs/design/critical-path/", import.meta.url),
);
const DOCS_INDEX_PATH = fileURLToPath(
  new URL("../../../docs/INDEX.md", import.meta.url),
);
const CONTROL_FILES = Object.freeze([
  ".gitattributes",
  "README.md",
  "manifest.json",
]);
const CONTROL_FILE_SET = new Set<string>(CONTROL_FILES);
const EXPECTED_PUBLICATION = "unpublished-synthetic-test-data";
const EXPECTED_DATA_CLASSIFICATION = "synthetic-no-user-data";
const MAX_MANIFEST_BYTE_LENGTH = 262_144;
const MAX_CONTROL_FILE_BYTE_LENGTH = 65_536;
const MAX_INTEGRITY_JSON_DEPTH = 128;
const MAX_FIXTURE_BYTE_LENGTH = 65_536;
const MAX_FIXTURE_CORPUS_BYTE_LENGTH = 1_048_576;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FIXTURE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const WINDOWS_DRIVE_PATTERN = /^[a-z]:/iu;
const EXPECTED_CRITICAL_PATH_ADRS = Object.freeze([
  {
    id: "CP-0001",
    file: "0001-effect-outcome-separation.md",
    status: "Accepted target; implementation pending",
  },
  {
    id: "CP-0002",
    file: "0002-strict-recovery-quarantine.md",
    status: "Implemented",
  },
  {
    id: "CP-0003",
    file: "0003-versioned-durable-checkpoints.md",
    status: "Accepted target; implementation pending",
  },
  {
    id: "CP-0004",
    file: "0004-csv-identity-and-replay.md",
    status: "Implemented",
  },
  {
    id: "CP-0005",
    file: "0005-derived-index-freshness.md",
    status: "Accepted target; implementation pending",
  },
  {
    id: "CP-0006",
    file: "0006-compaction-transaction.md",
    status: "Accepted target; implementation pending",
  },
  {
    id: "CP-0007",
    file: "0007-workflow-handoff-artifact.md",
    status: "B3a artifact contract and B3b event-driven scheduler implemented",
  },
  {
    id: "CP-0008",
    file: "0008-agent-invocation-envelope.md",
    status: "Accepted target; implementation pending",
  },
]);
const EXPECTED_CRITICAL_PATH_DOC_FILES = Object.freeze([
  ...EXPECTED_CRITICAL_PATH_ADRS.map((entry) => entry.file),
  "README.md",
]);
const INTENTIONAL_DUPLICATE_KEY_FORMATS = new Set([
  "agenc.rollout-jsonl.v1-duplicate-key",
  "raw-json-with-duplicate-keys",
]);
const INTENTIONAL_UNSAFE_JSONL_FORMATS = new Set([
  "agenc.rollout-jsonl.v1-duplicate-key",
  "agenc.rollout-jsonl.v1-interrupted-tail",
  "agenc.rollout-jsonl.v1-malformed-interior",
]);
const PRIVACY_SCAN_RULES = Object.freeze([
  {
    label: "private key material",
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/iu,
  },
  {
    label: "credential assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[a-z0-9_-]{12,}/iu,
  },
  {
    label: "personal home path",
    pattern: /(?:^|[\s"'(])\/(?:home|Users)\/[a-z0-9._-]+/iu,
  },
  {
    label: "email address",
    pattern: /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/iu,
  },
]);

const EXPECTED_FIXTURE_IDS = Object.freeze([
  "admission.legacy-v14-state-v16.v1",
  "checkpoint.legacy-v1.result-a.v1",
  "checkpoint.legacy-v1.result-substitution.v1",
  "csv.blank-source-id.v1",
  "csv.duplicate-headers.v1",
  "csv.duplicate-source-id.v1",
  "csv.extra-field.v1",
  "csv.legacy-v2-state-v16.v1",
  "csv.no-id-column.v1",
  "csv.prototype-headers.v1",
  "csv.quoted-crlf.v1",
  "csv.reserved-output-headers.v1",
  "csv.short-row-padding.v1",
  "csv.unicode-whitespace-source-id.v1",
  "filesystem.index-freshness.v1",
  "journal.duplicate-canonical-id.v1",
  "journal.duplicate-json-key.v1",
  "journal.duplicate-sequence.v1",
  "journal.interrupted-tail.v1",
  "journal.legacy-repeated-id.v1",
  "journal.malformed-interior.v1",
  "journal.mixed-lanes.v1",
  "journal.sequence-gap.v1",
  "journal.sequence-rewind.v1",
  "journal.sequenced-valid.v1",
  "journal.started-unsealed.v1",
  "mailbox.boundary-recipes.v1",
  "mailbox.depth-64.v1",
  "mailbox.depth-65.v1",
  "mailbox.duplicate-key.v1",
  "mailbox.generated-hostile.v1",
  "mailbox.inert-keys.v1",
  "patch.crlf.case.v1",
  "patch.crlf.expected.v1",
  "patch.crlf.input.v1",
  "patch.crlf.source.v1",
  "patch.lf.case.v1",
  "patch.lf.expected.v1",
  "patch.lf.input.v1",
  "patch.lf.source.v1",
  "patch.mixed.case.v1",
  "patch.mixed.expected.v1",
  "patch.mixed.input.v1",
  "patch.mixed.source.v1",
  "patch.no-final-newline.case.v1",
  "patch.no-final-newline.expected.v1",
  "patch.no-final-newline.input.v1",
  "patch.no-final-newline.source.v1",
]);

interface FixtureEntry {
  readonly id: string;
  readonly tasks: readonly string[];
  readonly path: string;
  readonly mediaType: string;
  readonly format: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly byteLength: number;
  readonly sha256: string;
  readonly auditedObservation: string;
  readonly targetContract: string;
}

interface FixtureManifest {
  readonly schemaVersion: number;
  readonly auditSha: string;
  readonly auditDate: string;
  readonly publication: string;
  readonly dataClassification: string;
  readonly controlFiles: readonly string[];
  readonly fixtureCount: number;
  readonly fixtures: readonly FixtureEntry[];
}

function readBoundedRegularFile(
  path: string,
  maximumByteLength: number,
  label: string,
): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (stat.size > maximumByteLength) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  return readFileSync(path);
}

function assertNoDuplicateObjectKeys(bytes: Buffer, label: string): void {
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new Error(`${label} is not valid UTF-8`);
  }

  let offset = 0;
  const skipWhitespace = (): void => {
    while (
      source[offset] === " " ||
      source[offset] === "\t" ||
      source[offset] === "\r" ||
      source[offset] === "\n"
    ) {
      offset += 1;
    }
  };
  const parseString = (): string => {
    if (source[offset] !== '"') {
      throw new Error(`${label} expected a JSON string at byte ${offset}`);
    }
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const character = source[offset]!;
      if (character === "\\") {
        offset += 2;
        continue;
      }
      if (character === '"') {
        offset += 1;
        const parsed = JSON.parse(source.slice(start, offset)) as unknown;
        if (typeof parsed !== "string") {
          throw new Error(`${label} contains an invalid JSON object key`);
        }
        return parsed;
      }
      if (character.charCodeAt(0) < 0x20) {
        throw new Error(`${label} contains an unescaped control character`);
      }
      offset += 1;
    }
    throw new Error(`${label} contains an unterminated JSON string`);
  };
  const parseScalar = (): void => {
    const start = offset;
    while (offset < source.length) {
      const character = source[offset]!;
      if (
        character === "," ||
        character === "]" ||
        character === "}" ||
        character === " " ||
        character === "\t" ||
        character === "\r" ||
        character === "\n"
      ) {
        break;
      }
      offset += 1;
    }
    if (offset === start) {
      throw new Error(`${label} expected a JSON value at byte ${offset}`);
    }
    JSON.parse(source.slice(start, offset)) as unknown;
  };
  const parseValue = (depth: number): void => {
    if (depth > MAX_INTEGRITY_JSON_DEPTH) {
      throw new Error(`${label} exceeds the control JSON depth limit`);
    }
    skipWhitespace();
    if (source[offset] === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) {
          throw new Error(`${label} contains duplicate object key ${key}`);
        }
        keys.add(key);
        skipWhitespace();
        if (source[offset] !== ":") {
          throw new Error(`${label} expected ':' at byte ${offset}`);
        }
        offset += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") {
          throw new Error(`${label} expected ',' at byte ${offset}`);
        }
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON object`);
    }
    if (source[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") {
          throw new Error(`${label} expected ',' at byte ${offset}`);
        }
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON array`);
    }
    if (source[offset] === '"') {
      parseString();
      return;
    }
    parseScalar();
  };

  parseValue(1);
  skipWhitespace();
  if (offset !== source.length) {
    throw new Error(`${label} contains trailing JSON data`);
  }
}

function manifest(): FixtureManifest {
  const bytes = readBoundedRegularFile(
    MANIFEST_PATH,
    MAX_MANIFEST_BYTE_LENGTH,
    "fixture manifest",
  );
  assertNoDuplicateObjectKeys(bytes, "fixture manifest");
  return JSON.parse(bytes.toString("utf8")) as FixtureManifest;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertContained(base: string, candidate: string, label: string): void {
  const displacement = relative(base, candidate);
  if (
    displacement.length === 0 ||
    displacement === ".." ||
    displacement.startsWith(`..${sep}`) ||
    isAbsolute(displacement)
  ) {
    throw new Error(`${label} escapes the fixture root`);
  }
}

function canonicalRelativeSegments(path: string, label: string): string[] {
  if (path.length === 0) {
    throw new Error(`${label} is empty`);
  }
  if (path.includes("\0")) {
    throw new Error(`${label} contains NUL`);
  }
  if (path.includes("\\")) {
    throw new Error(`${label} contains a non-POSIX separator`);
  }
  if (
    posix.isAbsolute(path) ||
    path.startsWith("//") ||
    WINDOWS_DRIVE_PATTERN.test(path)
  ) {
    throw new Error(`${label} is absolute`);
  }

  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    ) ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`${label} is not a canonical POSIX relative path`);
  }
  return segments;
}

function resolveFixturePath(manifestPath: string): string {
  const segments = canonicalRelativeSegments(manifestPath, "fixture path");

  const candidate = resolve(FIXTURE_ROOT, ...segments);
  assertContained(FIXTURE_ROOT, candidate, manifestPath);

  let current = FIXTURE_ROOT;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${manifestPath} traverses a symbolic link`);
    }
    const isFinal = index === segments.length - 1;
    if (isFinal ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`${manifestPath} is not a regular fixture file`);
    }
  }

  const resolvedRealPath = realpathSync(candidate);
  assertContained(FIXTURE_ROOT_REAL, resolvedRealPath, manifestPath);
  return candidate;
}

function resolveEmbeddedFixtureReference(
  ownerPath: string,
  reference: string,
): { readonly absolutePath: string; readonly manifestPath: string } {
  canonicalRelativeSegments(reference, `${ownerPath} embedded reference`);
  const ownerDirectory = posix.dirname(ownerPath);
  const manifestPath =
    ownerDirectory === "." ? reference : posix.join(ownerDirectory, reference);
  canonicalRelativeSegments(manifestPath, `${ownerPath} resolved reference`);
  return {
    absolutePath: resolveFixturePath(manifestPath),
    manifestPath,
  };
}

function listPayloadPaths(
  directory = FIXTURE_ROOT,
  relativeDirectory = "",
): string[] {
  const payloads: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath =
      relativeDirectory.length === 0
        ? entry.name
        : posix.join(relativeDirectory, entry.name);
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${relativePath} is a symbolic link`);
    }
    if (entry.isDirectory()) {
      payloads.push(...listPayloadPaths(absolutePath, relativePath));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`${relativePath} is not a regular file`);
    }
    if (
      relativeDirectory.length === 0 &&
      CONTROL_FILE_SET.has(entry.name)
    ) {
      continue;
    }
    payloads.push(relativePath);
  }
  return payloads.sort();
}

function entryById(fixtureManifest: FixtureManifest, id: string): FixtureEntry {
  const entry = fixtureManifest.fixtures.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`missing fixture ${id}`);
  return entry;
}

const PREFLIGHTED_MANIFESTS = new WeakSet<FixtureManifest>();

function assertPayloadSizeBounds(fixtureManifest: FixtureManifest): void {
  if (PREFLIGHTED_MANIFESTS.has(fixtureManifest)) return;
  let aggregateByteLength = 0;
  for (const entry of fixtureManifest.fixtures) {
    const path = resolveFixturePath(entry.path);
    const byteLength = lstatSync(path).size;
    if (byteLength > MAX_FIXTURE_BYTE_LENGTH) {
      throw new Error(`${entry.id} exceeds the per-fixture byte limit`);
    }
    aggregateByteLength += byteLength;
  }
  if (aggregateByteLength > MAX_FIXTURE_CORPUS_BYTE_LENGTH) {
    throw new Error("fixture corpus exceeds the aggregate byte limit");
  }
  PREFLIGHTED_MANIFESTS.add(fixtureManifest);
}

function bytesByEntry(
  fixtureManifest: FixtureManifest,
  entry: FixtureEntry,
): Buffer {
  assertPayloadSizeBounds(fixtureManifest);
  const bytes = readFileSync(resolveFixturePath(entry.path));
  if (
    entry.path.endsWith(".json") &&
    !INTENTIONAL_DUPLICATE_KEY_FORMATS.has(entry.format)
  ) {
    assertNoDuplicateObjectKeys(bytes, entry.id);
    JSON.parse(bytes.toString("utf8")) as unknown;
  }
  if (
    entry.format.startsWith("agenc.rollout-jsonl.") &&
    !INTENTIONAL_UNSAFE_JSONL_FORMATS.has(entry.format)
  ) {
    for (const [index, line] of jsonLineBuffers(bytes).entries()) {
      assertNoDuplicateObjectKeys(line, `${entry.id} line ${index + 1}`);
      JSON.parse(line.toString("utf8")) as unknown;
    }
  }
  return bytes;
}

function bytesById(fixtureManifest: FixtureManifest, id: string): Buffer {
  return bytesByEntry(fixtureManifest, entryById(fixtureManifest, id));
}

function jsonLineBuffers(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let lineStart = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.subarray(lineStart, index));
    lineStart = index + 1;
  }
  if (lineStart < bytes.length) lines.push(bytes.subarray(lineStart));
  return lines;
}

function parseJsonLines(bytes: Buffer): unknown[] {
  return jsonLineBuffers(bytes).map(
    (line) => JSON.parse(line.toString("utf8")) as unknown,
  );
}

function countNewlineKinds(bytes: Buffer): {
  readonly crlf: number;
  readonly bareCr: number;
  readonly bareLf: number;
} {
  let crlf = 0;
  let bareCr = 0;
  let bareLf = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      if (bytes[index + 1] === 0x0a) crlf += 1;
      else bareCr += 1;
    } else if (bytes[index] === 0x0a && bytes[index - 1] !== 0x0d) {
      bareLf += 1;
    }
  }
  return { crlf, bareCr, bareLf };
}

function maximumContainerDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const pending: Array<{ readonly value: object; readonly depth: number }> = [
    { value, depth: 1 },
  ];
  let maximum = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    maximum = Math.max(maximum, current.depth);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      if (child !== null && typeof child === "object") {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return maximum;
}

describe("foundation fixture contract", () => {
  it("freezes the complete manifest identity and on-disk payload inventory", () => {
    const fixtureManifest = manifest();
    expect(fixtureManifest.schemaVersion).toBe(1);
    expect(fixtureManifest.auditSha).toBe(AUDITED_SHA);
    expect(fixtureManifest.auditDate).toBe("2026-07-31");
    expect(fixtureManifest.publication).toBe(EXPECTED_PUBLICATION);
    expect(fixtureManifest.dataClassification).toBe(
      EXPECTED_DATA_CLASSIFICATION,
    );
    expect(fixtureManifest.controlFiles).toEqual(CONTROL_FILES);
    expect(fixtureManifest.fixtureCount).toBe(EXPECTED_FIXTURE_IDS.length);
    expect(fixtureManifest.fixtures).toHaveLength(EXPECTED_FIXTURE_IDS.length);

    const ids = fixtureManifest.fixtures.map((entry) => entry.id);
    const paths = fixtureManifest.fixtures.map((entry) => entry.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(ids.toSorted()).toEqual([...EXPECTED_FIXTURE_IDS]);
    expect(paths.toSorted()).toEqual(listPayloadPaths());

    const documentationEntries = readdirSync(CRITICAL_PATH_DOC_ROOT, {
      withFileTypes: true,
    });
    expect(documentationEntries.every((entry) => entry.isFile())).toBe(true);
    expect(documentationEntries.map((entry) => entry.name).toSorted()).toEqual(
      [...EXPECTED_CRITICAL_PATH_DOC_FILES].toSorted(),
    );

    const criticalPathReadme = readBoundedRegularFile(
      join(CRITICAL_PATH_DOC_ROOT, "README.md"),
      MAX_CONTROL_FILE_BYTE_LENGTH,
      "critical-path README",
    ).toString("utf8");
    expect(criticalPathReadme).toContain(
      "Status: accepted target architecture; implementation is pending.",
    );
    expect(criticalPathReadme).toContain(AUDITED_SHA);
    for (const decision of EXPECTED_CRITICAL_PATH_ADRS) {
      const decisionText = readBoundedRegularFile(
        join(CRITICAL_PATH_DOC_ROOT, decision.file),
        MAX_CONTROL_FILE_BYTE_LENGTH,
        decision.file,
      ).toString("utf8");
      expect(decisionText.startsWith(`# ${decision.id}:`), decision.file).toBe(
        true,
      );
      expect(decisionText, decision.file).toContain(
        `| Status | ${decision.status} |`,
      );
      expect(decisionText, decision.file).toContain(
        `| Audit snapshot | \`${AUDITED_SHA}\` |`,
      );
      expect(decisionText, decision.file).toContain(
        "| Audit date | 2026-07-31 |",
      );
      expect(
        criticalPathReadme.split(`(${decision.file})`).length - 1,
        `${decision.id} README link count`,
      ).toBe(1);
    }

    const docsIndex = readBoundedRegularFile(
      DOCS_INDEX_PATH,
      MAX_CONTROL_FILE_BYTE_LENGTH,
      "docs index",
    ).toString("utf8");
    expect(
      docsIndex.split("[design/critical-path/README.md](design/critical-path/README.md)")
        .length - 1,
    ).toBe(1);
    expect(docsIndex).toContain(
      "Accepted target decisions for critical-path remediation; implementation is pending",
    );
  });

  it("binds every regular payload to raw byte length and SHA-256", () => {
    const fixtureManifest = manifest();
    assertPayloadSizeBounds(fixtureManifest);
    for (const entry of fixtureManifest.fixtures) {
      expect(entry.id).toMatch(FIXTURE_ID_PATTERN);
      expect(entry.tasks.length, `${entry.id} tasks`).toBeGreaterThan(0);
      expect(entry.tasks.every((task) => task.length > 0)).toBe(true);
      expect(entry.mediaType.length, `${entry.id} mediaType`).toBeGreaterThan(0);
      expect(entry.format.length, `${entry.id} format`).toBeGreaterThan(0);
      expect(
        entry.auditedObservation.length,
        `${entry.id} auditedObservation`,
      ).toBeGreaterThan(0);
      expect(
        entry.targetContract.length,
        `${entry.id} targetContract`,
      ).toBeGreaterThan(0);
      expect(Number.isSafeInteger(entry.byteLength)).toBe(true);
      expect(entry.byteLength).toBeGreaterThanOrEqual(0);
      expect(entry.sha256).toMatch(SHA256_PATTERN);

      const bytes = bytesByEntry(fixtureManifest, entry);
      expect(bytes.byteLength, `${entry.id} byteLength`).toBe(entry.byteLength);
      expect(sha256(bytes), `${entry.id} sha256`).toBe(entry.sha256);
    }

    const csvEntries = fixtureManifest.fixtures.filter((entry) =>
      entry.id.startsWith("csv."),
    );
    for (const entry of csvEntries) {
      expect(entry.parameters).toHaveProperty("idColumn");
      const idColumn = entry.parameters?.idColumn;
      expect(idColumn === null || typeof idColumn === "string").toBe(true);
    }
  });

  it("rejects noncanonical or escaping manifest paths", () => {
    const rejected = [
      "",
      ".",
      "..",
      "../payload",
      "payload/..",
      "payload/../other",
      "./payload",
      "payload/./other",
      "payload//other",
      "payload/",
      "/absolute/payload",
      "//server/share/payload",
      "C:/payload",
      "C:\\payload",
      "payload\\other",
      "payload\0other",
    ];
    for (const manifestPath of rejected) {
      expect(() => resolveFixturePath(manifestPath), manifestPath).toThrow();
    }
  });

  it("validates every embedded materializer path and fixture reference", () => {
    const fixtureManifest = manifest();
    const manifestedPaths = new Set(
      fixtureManifest.fixtures.map((entry) => entry.path),
    );
    const assertManifestedReference = (
      owner: FixtureEntry,
      reference: string,
    ): void => {
      const resolved = resolveEmbeddedFixtureReference(owner.path, reference);
      expect(manifestedPaths.has(resolved.manifestPath), resolved.manifestPath).toBe(
        true,
      );
      expect(lstatSync(resolved.absolutePath).isFile()).toBe(true);
    };

    for (const entry of fixtureManifest.fixtures.filter(
      (candidate) => candidate.format === "agenc.patch-byte-case.v1",
    )) {
      const patchCase = JSON.parse(
        bytesByEntry(fixtureManifest, entry).toString("utf8"),
      ) as {
        readonly source: string;
        readonly patch: string;
        readonly expected: string;
      };
      assertManifestedReference(entry, patchCase.source);
      assertManifestedReference(entry, patchCase.patch);
      assertManifestedReference(entry, patchCase.expected);
    }

    const mailboxRecipeEntry = entryById(
      fixtureManifest,
      "mailbox.boundary-recipes.v1",
    );
    const mailboxRecipe = JSON.parse(
      bytesByEntry(fixtureManifest, mailboxRecipeEntry).toString("utf8"),
    ) as {
      readonly cases: readonly {
        readonly construct: { readonly fixture?: string };
      }[];
    };
    for (const fixtureCase of mailboxRecipe.cases) {
      if (fixtureCase.construct.fixture !== undefined) {
        assertManifestedReference(
          mailboxRecipeEntry,
          fixtureCase.construct.fixture,
        );
      }
    }

    const filesystemScenario = JSON.parse(
      bytesById(fixtureManifest, "filesystem.index-freshness.v1").toString(
        "utf8",
      ),
    ) as {
      readonly operations: readonly Readonly<Record<string, unknown>>[];
    };
    for (const [index, operation] of filesystemScenario.operations.entries()) {
      for (const field of ["path", "from", "to", "relativePath"] as const) {
        const value = operation[field];
        if (typeof value === "string") {
          canonicalRelativeSegments(
            value,
            `filesystem operation ${index + 1} ${field}`,
          );
        }
      }
      const expectedPaths = operation.expectedPaths;
      if (Array.isArray(expectedPaths)) {
        for (const expectedPath of expectedPaths) {
          if (typeof expectedPath !== "string") {
            throw new Error("filesystem expectedPaths contains a non-string");
          }
          canonicalRelativeSegments(
            expectedPath,
            `filesystem operation ${index + 1} expectedPaths`,
          );
        }
      }
      const expectedRecords = operation.expectedRecords;
      if (Array.isArray(expectedRecords)) {
        for (const expectedRecord of expectedRecords) {
          const relativePath = (expectedRecord as { readonly relativePath?: unknown })
            .relativePath;
          if (typeof relativePath !== "string") {
            throw new Error("filesystem expected record lacks relativePath");
          }
          canonicalRelativeSegments(
            relativePath,
            `filesystem operation ${index + 1} expected record`,
          );
        }
      }
    }

    for (const id of [
      "admission.legacy-v14-state-v16.v1",
      "csv.legacy-v2-state-v16.v1",
    ]) {
      const seed = JSON.parse(bytesById(fixtureManifest, id).toString("utf8")) as {
        readonly database: string;
        readonly pathFields?: Readonly<Record<string, string>>;
        readonly statements: readonly { readonly params: readonly unknown[] }[];
      };
      canonicalRelativeSegments(seed.database, `${id} database`);
      for (const [field, path] of Object.entries(seed.pathFields ?? {})) {
        canonicalRelativeSegments(path, `${id} ${field}`);
        expect(seed.statements.some((statement) => statement.params.includes(path))).toBe(
          true,
        );
      }
    }

    expect(() =>
      resolveEmbeddedFixtureReference(
        "patches/lf-preserve-v1/case.json",
        "../../escape.bin",
      ),
    ).toThrow();
    expect(() =>
      canonicalRelativeSegments("../escape.sqlite", "seed database"),
    ).toThrow();
  });

  it("preserves the audited byte-sensitive edge cases", () => {
    const fixtureManifest = manifest();
    const interruptedTail = bytesById(
      fixtureManifest,
      "journal.interrupted-tail.v1",
    );
    expect(interruptedTail.at(-1)).not.toBe(0x0a);
    const interruptedLines = interruptedTail.toString("utf8").split("\n");
    expect(() => JSON.parse(interruptedLines.at(-1)!)).toThrow();

    const malformedInterior = bytesById(
      fixtureManifest,
      "journal.malformed-interior.v1",
    );
    expect(malformedInterior.at(-1)).toBe(0x0a);
    const malformedLines = malformedInterior.toString("utf8").trimEnd().split("\n");
    expect(() => JSON.parse(malformedLines[1]!)).toThrow();

    const startedUnsealed = bytesById(
      fixtureManifest,
      "journal.started-unsealed.v1",
    );
    expect(startedUnsealed.at(-1)).toBe(0x0a);
    expect(parseJsonLines(startedUnsealed)).toHaveLength(2);

    const quotedCsv = bytesById(fixtureManifest, "csv.quoted-crlf.v1");
    const quotedNewlines = countNewlineKinds(quotedCsv);
    expect(quotedNewlines.crlf).toBeGreaterThan(0);
    expect(quotedNewlines.bareCr).toBeGreaterThan(0);
    expect(quotedNewlines.bareLf).toBeGreaterThan(0);
    expect(quotedCsv.includes(Buffer.from('""quote""', "utf8"))).toBe(true);

    const crlfSource = bytesById(fixtureManifest, "patch.crlf.source.v1");
    expect(countNewlineKinds(crlfSource)).toEqual({
      crlf: 3,
      bareCr: 0,
      bareLf: 0,
    });
    expect(bytesById(fixtureManifest, "patch.mixed.source.v1")).toEqual(
      Buffer.from("alpha\r\nbeta\ngamma\r\n", "utf8"),
    );
    expect(bytesById(fixtureManifest, "patch.mixed.expected.v1")).toEqual(
      Buffer.from("alpha\r\nBETA\r\ngamma\r\n", "utf8"),
    );
    expect(
      bytesById(fixtureManifest, "patch.no-final-newline.source.v1").at(-1),
    ).not.toBe(0x0a);
    expect(
      bytesById(fixtureManifest, "patch.no-final-newline.expected.v1").at(-1),
    ).not.toBe(0x0a);

    const depth64 = JSON.parse(
      bytesById(fixtureManifest, "mailbox.depth-64.v1").toString("utf8"),
    ) as unknown;
    const depth65 = JSON.parse(
      bytesById(fixtureManifest, "mailbox.depth-65.v1").toString("utf8"),
    ) as unknown;
    expect(Array.isArray(depth64)).toBe(false);
    expect(Array.isArray(depth65)).toBe(false);
    expect(maximumContainerDepth(depth64)).toBe(64);
    expect(maximumContainerDepth(depth65)).toBe(65);

    const duplicateKey = bytesById(
      fixtureManifest,
      "mailbox.duplicate-key.v1",
    ).toString("utf8");
    expect(duplicateKey.match(/"label"/gu)).toHaveLength(2);
    expect(JSON.parse(duplicateKey)).toEqual({
      label: "second synthetic metadata value",
    });

    const shortRows = bytesById(
      fixtureManifest,
      "csv.short-row-padding.v1",
    )
      .toString("utf8")
      .trimEnd()
      .split("\n");
    expect(shortRows[0]!.split(",")).toHaveLength(3);
    expect(shortRows[1]!.split(",")).toHaveLength(2);
    const extraRows = bytesById(fixtureManifest, "csv.extra-field.v1")
      .toString("utf8")
      .trimEnd()
      .split("\n");
    expect(extraRows[0]!.split(",")).toHaveLength(3);
    expect(extraRows[1]!.split(",")).toHaveLength(4);
    expect(
      bytesById(fixtureManifest, "csv.reserved-output-headers.v1")
        .toString("utf8")
        .split("\n", 1)[0],
    ).toContain("result_availability");
  });

  it("keeps the equal-length checkpoint substitution visible to future digest tests", () => {
    const fixtureManifest = manifest();
    const leftBytes = bytesById(
      fixtureManifest,
      "checkpoint.legacy-v1.result-a.v1",
    );
    const rightBytes = bytesById(
      fixtureManifest,
      "checkpoint.legacy-v1.result-substitution.v1",
    );
    expect(leftBytes.byteLength).toBe(rightBytes.byteLength);
    expect(leftBytes.equals(rightBytes)).toBe(false);

    const left = parseJsonLines(leftBytes) as Array<{
      readonly type?: string;
      readonly eventVersion?: number;
      readonly payload?: {
        readonly role?: string;
        readonly content?: unknown;
        readonly msg?: {
          readonly type?: string;
          readonly payload?: Readonly<Record<string, unknown>>;
        };
      };
    }>;
    const right = parseJsonLines(rightBytes) as typeof left;
    expect(left.every((item) => item.eventVersion === 1)).toBe(true);
    expect(right.every((item) => item.eventVersion === 1)).toBe(true);

    const toolBody = (items: typeof left): unknown =>
      items.find(
        (item) => item.type === "response_item" && item.payload?.role === "tool",
      )?.payload?.content;
    const checkpoint = (items: typeof left): Readonly<Record<string, unknown>> => {
      const payload = items.find(
        (item) => item.payload?.msg?.type === "turn_checkpoint",
      )?.payload?.msg?.payload;
      if (payload === undefined) throw new Error("checkpoint fixture is missing");
      return payload;
    };

    expect(toolBody(left)).toBe("alpha");
    expect(toolBody(right)).toBe("omega");
    expect(checkpoint(left).prefixHash).toBe(
      "68cb16728e869cd1b8392c333db38adf714d4eaaf1969e4e25617ecf634326ae",
    );
    expect(checkpoint(right).prefixHash).toBe(checkpoint(left).prefixHash);
    expect(checkpoint(left)).not.toHaveProperty("checkpointVersion");
    expect(checkpoint(right)).not.toHaveProperty("checkpointVersion");
  });

  it("parses and freezes every generated-hostile mailbox recipe shape", () => {
    const fixtureManifest = manifest();
    const hostileRecipe = JSON.parse(
      bytesById(fixtureManifest, "mailbox.generated-hostile.v1").toString(
        "utf8",
      ),
    ) as {
      readonly format: string;
      readonly validMessageInput: Readonly<Record<string, unknown>>;
      readonly constructionSemantics: Readonly<Record<string, unknown>>;
      readonly recipes: readonly {
        readonly id: string;
        readonly measurement: string;
        readonly construct: {
          readonly kind: string;
          readonly valueRecipe: Readonly<Record<string, unknown>>;
        };
      }[];
    };

    expect(Object.keys(hostileRecipe).toSorted()).toEqual([
      "constructionSemantics",
      "format",
      "recipes",
      "validMessageInput",
    ]);
    expect(hostileRecipe.format).toBe("agenc.hostile-value-recipe.v1");
    expect(hostileRecipe.validMessageInput).toEqual({
      author: "synthetic-worker",
      recipient: "synthetic-parent",
      content: "synthetic mailbox content",
      triggerTurn: false,
      direction: "up",
    });
    expect(hostileRecipe.constructionSemantics).toEqual({
      attach_value:
        "clone validMessageInput and assign the generated value to metadata.hostile",
      metadata_root:
        "use the generated value itself as metadata without constructing a message",
    });

    const expectedShapes = [
      ["broad-object", "full_message", "attach_value", "object", [
        "kind",
        "propertyCount",
        "value",
      ]],
      ["oversize-string", "full_message", "attach_value", "utf8_string", [
        "byteLength",
        "fill",
        "kind",
      ]],
      ["sparse-array", "full_message", "attach_value", "sparse_array", [
        "entries",
        "kind",
        "length",
      ]],
      ["undefined-leaf", "full_message", "attach_value", "object", [
        "kind",
        "properties",
      ]],
      ["self-cycle", "full_message", "attach_value", "cycle", [
        "edge",
        "kind",
      ]],
      ["throwing-getter", "metadata_only", "metadata_root", "accessor", [
        "getter",
        "kind",
        "property",
      ]],
      ["throwing-proxy", "metadata_only", "metadata_root", "proxy", [
        "behavior",
        "kind",
        "trap",
      ]],
    ] as const;

    expect(
      hostileRecipe.recipes.map((recipe) => {
        expect(Object.keys(recipe).toSorted()).toEqual([
          "construct",
          "id",
          "measurement",
        ]);
        expect(Object.keys(recipe.construct).toSorted()).toEqual([
          "kind",
          "valueRecipe",
        ]);
        return [
          recipe.id,
          recipe.measurement,
          recipe.construct.kind,
          recipe.construct.valueRecipe.kind,
          Object.keys(recipe.construct.valueRecipe).toSorted(),
        ];
      }),
    ).toEqual(expectedShapes);
  });

  it("freezes deterministic persistence seed-recipe structure", () => {
    const fixtureManifest = manifest();
    interface SeedStatement {
      readonly id?: string;
      readonly sql: string;
      readonly params: readonly unknown[];
    }
    interface SeedRecipe {
      readonly format: string;
      readonly database: string;
      readonly applyMigrationsThrough: number;
      readonly contractMigration: number;
      readonly scenarioOptions?: { readonly idColumn?: string | null };
      readonly pathFields?: Readonly<Record<string, string>>;
      readonly statements: readonly SeedStatement[];
    }
    const seedRecipe = (id: string): SeedRecipe =>
      JSON.parse(bytesById(fixtureManifest, id).toString("utf8")) as SeedRecipe;
    const admission = seedRecipe("admission.legacy-v14-state-v16.v1");
    const csv = seedRecipe("csv.legacy-v2-state-v16.v1");

    for (const recipe of [admission, csv]) {
      expect(recipe.format).toBe("agenc.sqlite-seed-recipe.v1");
      expect(recipe.database).toBe("state.sqlite");
      expect(recipe.applyMigrationsThrough).toBe(16);
      expect(recipe.statements.length).toBeGreaterThan(0);
      for (const statement of recipe.statements) {
        expect(statement.sql.match(/\?/gu) ?? []).toHaveLength(
          statement.params.length,
        );
      }
    }

    expect(admission.contractMigration).toBe(14);
    const requestJson = (statementId: string): string => {
      const statement = admission.statements.find(
        (candidate) => candidate.id === statementId,
      );
      const value = statement?.params.find(
        (parameter) =>
          typeof parameter === "string" && parameter.startsWith('{"step"'),
      );
      if (typeof value !== "string") {
        throw new Error(`missing input_json for ${statementId}`);
      }
      return value;
    };
    const legacyParentRequest = requestJson("legacy-parent-id");
    const missingIdentityRequest = requestJson("missing-budget-identity");
    expect(legacyParentRequest).toContain('"parentId"');
    expect(legacyParentRequest).not.toContain("budgetIdentity");
    expect(missingIdentityRequest).toContain('"parentScopeId"');
    expect(missingIdentityRequest).not.toContain("budgetIdentity");
    expect(admission).not.toHaveProperty("targetClassifications");
    expect(admission.statements.map((statement) => statement.id)).toContain(
      "held-unknown-without-effect-evidence-reservation",
    );
    expect(JSON.stringify(admission)).not.toContain("confirmed-effect");

    expect(csv.contractMigration).toBe(2);
    expect(csv.scenarioOptions).toEqual({ idColumn: "source_id" });
    expect(csv.pathFields).toEqual({
      inputCsvPath: "synthetic/input.csv",
      outputCsvPath: "synthetic/output.csv",
    });
  });

  it("freezes strict and legacy journal-lane defects as raw rollout envelopes", () => {
    const fixtureManifest = manifest();
    interface JournalRow {
      readonly type?: string;
      readonly eventVersion?: number;
      readonly payload?: {
        readonly eventId?: string;
        readonly id?: string;
        readonly seq?: number;
      };
    }
    const rows = (id: string): JournalRow[] =>
      parseJsonLines(bytesById(fixtureManifest, id)) as JournalRow[];
    const sequences = (id: string): Array<number | undefined> =>
      rows(id).map((row) => row.payload?.seq);
    const eventIds = (id: string): Array<string | undefined> =>
      rows(id).map((row) => row.payload?.eventId);

    const parseableJournalIds = [
      "journal.duplicate-canonical-id.v1",
      "journal.duplicate-json-key.v1",
      "journal.duplicate-sequence.v1",
      "journal.legacy-repeated-id.v1",
      "journal.mixed-lanes.v1",
      "journal.sequence-gap.v1",
      "journal.sequence-rewind.v1",
      "journal.sequenced-valid.v1",
      "journal.started-unsealed.v1",
    ];
    for (const id of parseableJournalIds) {
      for (const row of rows(id)) {
        expect(row.type, `${id} wrapper type`).toBe("event_msg");
        expect(row.eventVersion, `${id} eventVersion`).toBe(1);
        const eventId = row.payload?.eventId;
        const reservedMatch = /^event:(\d+)$/u.exec(eventId ?? "");
        if (reservedMatch !== null) {
          expect(row.payload?.seq, `${id} reserved event identity`).toBe(
            Number(reservedMatch[1]),
          );
        }
      }
    }

    expect(sequences("journal.sequenced-valid.v1")).toEqual([1, 2, 3]);
    expect(sequences("journal.sequence-gap.v1")).toEqual([1, 3]);
    expect(eventIds("journal.sequence-gap.v1")).toEqual(["event:1", "event:3"]);
    expect(sequences("journal.duplicate-sequence.v1")).toEqual([1, 2, 2]);
    const duplicateSequenceIds = eventIds("journal.duplicate-sequence.v1");
    expect(new Set(duplicateSequenceIds).size).toBe(3);
    expect(duplicateSequenceIds[2]).toBe("fixture:duplicate-sequence-terminal");
    expect(sequences("journal.sequence-rewind.v1")).toEqual([1, 2, 3, 2]);
    const rewindIds = eventIds("journal.sequence-rewind.v1");
    expect(new Set(rewindIds).size).toBe(4);
    expect(rewindIds[3]).toBe("fixture:sequence-rewind-terminal");
    expect(sequences("journal.mixed-lanes.v1")).toEqual([1, undefined]);
    expect(eventIds("journal.mixed-lanes.v1")).toEqual(["event:1", undefined]);
    expect(sequences("journal.duplicate-canonical-id.v1")).toEqual([1, 2]);
    expect(
      eventIds("journal.duplicate-canonical-id.v1"),
    ).toEqual(["event:duplicate", "event:duplicate"]);

    const legacyBytes = bytesById(
      fixtureManifest,
      "journal.legacy-repeated-id.v1",
    ).toString("utf8");
    const legacyLines = legacyBytes.trimEnd().split("\n");
    expect(legacyLines[0]).toBe(legacyLines[1]);
    expect(legacyLines[2]).not.toBe(legacyLines[1]);
    for (const row of rows("journal.legacy-repeated-id.v1")) {
      expect(row.payload).not.toHaveProperty("eventId");
      expect(row.payload).not.toHaveProperty("seq");
      expect(row.payload?.id).toBe("legacy-repeated");
    }

    const duplicateJsonKey = bytesById(
      fixtureManifest,
      "journal.duplicate-json-key.v1",
    ).toString("utf8");
    expect(duplicateJsonKey.match(/"seq"/gu)).toHaveLength(2);
    expect(sequences("journal.duplicate-json-key.v1")).toEqual([1]);

    const malformedLines = bytesById(
      fixtureManifest,
      "journal.malformed-interior.v1",
    )
      .toString("utf8")
      .trimEnd()
      .split("\n");
    expect((JSON.parse(malformedLines[0]!) as JournalRow).payload).toMatchObject({
      eventId: "event:1",
      seq: 1,
    });
    expect(malformedLines[1]).toContain('"eventId":"event:2"');
    expect(malformedLines[1]).toContain('"seq":2');
    expect(() => JSON.parse(malformedLines[1]!)).toThrow();
    expect((JSON.parse(malformedLines[2]!) as JournalRow).payload).toMatchObject({
      eventId: "event:3",
      seq: 3,
    });

    const interruptedLines = bytesById(
      fixtureManifest,
      "journal.interrupted-tail.v1",
    )
      .toString("utf8")
      .split("\n");
    expect((JSON.parse(interruptedLines[0]!) as JournalRow).payload).toMatchObject({
      eventId: "event:1",
      seq: 1,
    });
    expect(interruptedLines[1]).toContain('"eventId":"event:2"');
    expect(interruptedLines[1]).toContain('"seq":2');
    expect(() => JSON.parse(interruptedLines[1]!)).toThrow();
  });

  it("preflights byte caps and scans every payload for private data", () => {
    const fixtureManifest = manifest();
    assertPayloadSizeBounds(fixtureManifest);

    const fixtureReadme = readBoundedRegularFile(
      fileURLToPath(new URL("./fixtures/README.md", import.meta.url)),
      MAX_CONTROL_FILE_BYTE_LENGTH,
      "fixture README",
    ).toString("utf8");
    expect(fixtureReadme).toContain("synthetic");
    expect(fixtureReadme).toMatch(/no user or production\s+data/u);

    let scannedByteLength = 0;
    let syntheticMarkerCount = 0;
    for (const entry of fixtureManifest.fixtures) {
      const bytes = bytesByEntry(fixtureManifest, entry);
      scannedByteLength += bytes.byteLength;
      const text = bytes.toString("utf8");
      expect(Buffer.from(text, "utf8").equals(bytes), `${entry.id} UTF-8`).toBe(
        true,
      );
      if (text.toLowerCase().includes("synthetic")) syntheticMarkerCount += 1;
      for (const rule of PRIVACY_SCAN_RULES) {
        expect(rule.pattern.test(text), `${entry.id}: ${rule.label}`).toBe(false);
      }
    }
    expect(scannedByteLength).toBeLessThanOrEqual(
      MAX_FIXTURE_CORPUS_BYTE_LENGTH,
    );
    expect(syntheticMarkerCount).toBeGreaterThan(0);
  });

  it("keeps payload attributes binary-safe and manifest controls LF-normalized", () => {
    expect(() =>
      assertNoDuplicateObjectKeys(
        Buffer.from('{"outer":{"key":1},"other":[true,null]}', "utf8"),
        "valid control",
      ),
    ).not.toThrow();
    expect(() =>
      assertNoDuplicateObjectKeys(
        Buffer.from('{"key":1,"key":1}', "utf8"),
        "duplicate control",
      ),
    ).toThrow(/duplicate object key key/u);
    expect(() =>
      assertNoDuplicateObjectKeys(
        Buffer.from('{"id":1,"\\u0069d":1}', "utf8"),
        "escaped duplicate control",
      ),
    ).toThrow(/duplicate object key id/u);

    const attributes = readBoundedRegularFile(
      fileURLToPath(new URL("./fixtures/.gitattributes", import.meta.url)),
      MAX_CONTROL_FILE_BYTE_LENGTH,
      "fixture attributes",
    ).toString("utf8");
    expect(attributes).toBe(
      "** -text\n*.bin binary\n.gitattributes text eol=lf\nREADME.md text eol=lf\nmanifest.json text eol=lf\n",
    );
    const manifestBytes = readBoundedRegularFile(
      MANIFEST_PATH,
      MAX_MANIFEST_BYTE_LENGTH,
      "fixture manifest",
    );
    expect(manifestBytes.at(-1)).toBe(0x0a);
    expect(manifestBytes.includes(0x0d)).toBe(false);
  });
});
