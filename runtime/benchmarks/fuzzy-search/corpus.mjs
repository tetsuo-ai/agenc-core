import { createHash } from "node:crypto";

export const D2_CORPUS_GENERATOR_VERSION = "agenc-d2-fuzzy-corpus-v1";

const TAGS = Object.freeze([
  "d2alpha",
  "d2bravo",
  "d2charlie",
  "d2delta",
  "d2echo",
  "d2foxtrot",
  "d2golf",
  "d2hotel",
  "d2india",
  "d2juliet",
  "d2kilo",
  "d2lima",
  "d2mike",
  "d2november",
  "d2oscar",
  "d2papa",
  "d2quebec",
  "d2romeo",
  "d2sierra",
  "d2tango",
]);

export function fuzzyBenchmarkQueryPairs() {
  return TAGS.map((tag) =>
    Object.freeze({
      base: tag.slice(0, 3),
      extension: tag.slice(0, 4),
      tag,
    }),
  );
}

export function generateFuzzyCorpus(size, options = {}) {
  assertCorpusSize(size);
  const includeEntries = options.includeEntries === true;
  const includePaths = options.includePaths !== false;
  const width = Math.max(4, (size - 1).toString(36).length);
  const paths = includePaths ? new Array(size) : undefined;
  const entries = includeEntries ? new Array(size) : undefined;
  const digest = createHash("sha256");
  digest.update(`${D2_CORPUS_GENERATOR_VERSION}\0${size}\0`, "utf8");
  let pathBytes = 0;

  for (let index = 0; index < size; index += 1) {
    const path = fuzzyBenchmarkCorpusPath(size, index, width);
    const bytes = Buffer.from(path, "utf8");
    if (paths !== undefined) paths[index] = path;
    if (entries !== undefined) {
      entries[index] = Object.freeze({
        matchType: "file",
        pathBytes: bytes,
        relativePath: path,
      });
    }
    pathBytes += bytes.byteLength;
    digest.update(bytes);
    digest.update("\0", "utf8");
  }

  return Object.freeze({
    digest: digest.digest("hex"),
    entries: entries === undefined ? undefined : Object.freeze(entries),
    generatorVersion: D2_CORPUS_GENERATOR_VERSION,
    pathBytes,
    paths: paths === undefined ? undefined : Object.freeze(paths),
    queryPairs: Object.freeze(fuzzyBenchmarkQueryPairs()),
    size,
  });
}

export function fuzzyBenchmarkCorpusPath(size, index, knownWidth) {
  assertCorpusSize(size);
  if (!Number.isSafeInteger(index) || index < 0 || index >= size) {
    throw new RangeError(
      `fuzzy benchmark corpus index must be in [0, ${size})`,
    );
  }
  const width = knownWidth ?? Math.max(4, (size - 1).toString(36).length);
  const tag = TAGS[index % TAGS.length];
  const id = index.toString(36).padStart(width, "0");
  const shard = id.slice(0, 2);
  return index < TAGS.length
    ? `src/${tag}/${tag}-exact-${id}.ts`
    : `src/${tag}/${shard}/component-${id}.ts`;
}

export function fuzzyBenchmarkInvalidationPath(size) {
  assertCorpusSize(size);
  return `src/000-d2invalidated/d2invalidated-exact-${size}.ts`;
}

export function fuzzyBenchmarkFinalPathBytes(size, initialPathBytes) {
  assertCorpusSize(size);
  if (!Number.isSafeInteger(initialPathBytes) || initialPathBytes <= 0) {
    throw new RangeError("initial fuzzy benchmark path bytes must be positive");
  }
  return (
    initialPathBytes -
    Buffer.byteLength(fuzzyBenchmarkCorpusPath(size, 0), "utf8") +
    Buffer.byteLength(fuzzyBenchmarkInvalidationPath(size), "utf8")
  );
}

export function isFullQuerySubsequence(candidate, query) {
  let queryIndex = 0;
  const foldedCandidate = candidate.toLowerCase();
  const foldedQuery = query.toLowerCase();
  for (const character of foldedCandidate) {
    if (character === foldedQuery[queryIndex]) queryIndex += 1;
    if (queryIndex === foldedQuery.length) return true;
  }
  return foldedQuery.length === 0;
}

function assertCorpusSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 1_000_000) {
    throw new RangeError(
      "fuzzy benchmark corpus size must be in [1, 1,000,000]",
    );
  }
}
