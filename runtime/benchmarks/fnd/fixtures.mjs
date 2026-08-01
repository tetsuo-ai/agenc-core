import { BENCHMARK_PLAN, canonicalJson, sha256Hex } from "./contract.mjs";

const GENERATOR_VERSION = 1;
const CSV_HEADER = "source_id,task\n";
const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const REGEX_PATTERN = "(a+)+$";

export function buildFixture(caseId, pointIndex) {
  const definition = caseDefinition(caseId);
  const point = definition.inputSeries[pointIndex];
  if (point === undefined) {
    throw new Error(`unknown point ${pointIndex} for benchmark case ${caseId}`);
  }

  let generated;
  switch (caseId) {
    case "csv_scheduler_progress_scan":
      generated = buildCsvFixture(point);
      break;
    case "patch_delete_parser_suffix_slicing":
      generated = buildPatchFixture(point);
      break;
    case "regex_fallback_catastrophic_backtracking":
      generated = buildRegexFixture(point);
      break;
    case "fuzzy_daemon_recursive_scaling":
      generated = buildDaemonFuzzyFixture(point);
      break;
    case "fuzzy_tui_query_truncation":
      generated = buildTuiFuzzyFixture(point);
      break;
    default:
      throw new Error(`no fixture generator for benchmark case ${caseId}`);
  }

  const input = Object.freeze({
    ...point,
    generatedUtf8Bytes: generated.generatedUtf8Bytes,
  });
  const descriptor = Object.freeze({
    caseId,
    generatorVersion: GENERATOR_VERSION,
    input,
    payload: generated.descriptor,
  });
  const fixtureDigest = sha256Hex(canonicalJson(descriptor));
  return Object.freeze({
    definition,
    descriptor,
    fixtureDigest,
    input,
    operations: Object.freeze(generated.operations),
    payload: Object.freeze(generated.payload),
  });
}

export function describeFixture(caseId, pointIndex) {
  const fixture = buildFixture(caseId, pointIndex);
  return Object.freeze({
    descriptor: fixture.descriptor,
    fixtureDigest: fixture.fixtureDigest,
    operations: fixture.operations,
  });
}

function buildCsvFixture(point) {
  const width = String(point.rowCount - 1).length;
  const lines = new Array(point.rowCount + 1);
  lines[0] = CSV_HEADER.slice(0, -1);
  for (let index = 0; index < point.rowCount; index += 1) {
    const id = String(index).padStart(width, "0");
    lines[index + 1] = `row-${id},synthetic-${id}`;
  }
  const content = `${lines.join("\n")}\n`;
  return {
    generatedUtf8Bytes: Buffer.byteLength(content),
    descriptor: {
      contentSha256: sha256Hex(content),
      dataRows: point.rowCount,
      header: CSV_HEADER.trimEnd(),
    },
    operations: {
      progress_item_visits: point.rowCount * (point.rowCount + 2),
      queue_shift_moved_slots: (point.rowCount * (point.rowCount - 1)) / 2,
      worker_spawns: point.rowCount,
    },
    payload: { content },
  };
}

function buildPatchFixture(point) {
  const width = String(point.hunkCount - 1).length;
  const lines = new Array(point.hunkCount + 2);
  lines[0] = PATCH_BEGIN;
  for (let index = 0; index < point.hunkCount; index += 1) {
    lines[index + 1] =
      `*** Delete File: generated/file-${String(index).padStart(width, "0")}.txt`;
  }
  lines[lines.length - 1] = PATCH_END;
  const patch = lines.join("\n");
  return {
    generatedUtf8Bytes: Buffer.byteLength(patch),
    descriptor: {
      contentSha256: sha256Hex(patch),
      hunkCount: point.hunkCount,
      inputLineCount: lines.length,
      kind: "delete_only",
    },
    operations: {
      parsed_hunks: point.hunkCount,
      remaining_suffix_references_copied:
        (point.hunkCount * (point.hunkCount - 1)) / 2,
      source_lines: lines.length,
    },
    payload: { patch },
  };
}

function buildRegexFixture(point) {
  const hostileLine = `${"a".repeat(point.repeatedCharacters)}!\n`;
  const generatedUtf8Bytes =
    Buffer.byteLength(hostileLine) + Buffer.byteLength(REGEX_PATTERN);
  return {
    generatedUtf8Bytes,
    descriptor: {
      contentSha256: sha256Hex(hostileLine),
      patternSha256: sha256Hex(REGEX_PATTERN),
      terminalMismatch: true,
    },
    operations: {
      backtracking_input_code_units: hostileLine.trimEnd().length,
      files_scanned: point.fileCount,
      pattern_code_units: REGEX_PATTERN.length,
    },
    payload: { content: hostileLine, pattern: REGEX_PATTERN },
  };
}

function buildDaemonFuzzyFixture(point) {
  const width = String(point.candidateCount - 1).length;
  const stem = "ax"
    .repeat(Math.ceil(point.pathStemCodeUnits / 2))
    .slice(0, point.pathStemCodeUnits);
  const paths = new Array(point.candidateCount);
  for (let index = 0; index < point.candidateCount; index += 1) {
    paths[index] = `${stem}-${String(index).padStart(width, "0")}.txt`;
  }
  const query = "a".repeat(point.queryCodeUnits);
  const generatedUtf8Bytes = paths.reduce(
    (total, path) => total + Buffer.byteLength(path) + 2,
    Buffer.byteLength(query),
  );
  const candidatePathCodeUnits = paths[0]?.length ?? 0;
  return {
    generatedUtf8Bytes,
    descriptor: {
      candidatePathListSha256: sha256Hex(paths.join("\n")),
      fileContentSha256: sha256Hex("x\n"),
      querySha256: sha256Hex(query),
    },
    operations: {
      candidate_query_code_unit_pairs:
        point.candidateCount * point.queryCodeUnits * candidatePathCodeUnits,
      filesystem_entries: point.candidateCount,
      recursive_comparison_upper_bound:
        2 *
        point.candidateCount *
        point.queryCodeUnits *
        candidatePathCodeUnits *
        candidatePathCodeUnits,
    },
    payload: { fileContent: "x\n", paths, query },
  };
}

function buildTuiFuzzyFixture(point) {
  const prefix = "a".repeat(point.indexedQueryCodeUnits);
  const query = `${prefix}RIGHT`;
  const wrongPath = `${prefix}WRONG`;
  const rightPath = `${prefix}RIGHT`;
  const paths = [wrongPath, rightPath];
  const generatedUtf8Bytes =
    Buffer.byteLength(query) +
    paths.reduce((total, path) => total + Buffer.byteLength(path), 0);
  return {
    generatedUtf8Bytes,
    descriptor: {
      pathListSha256: sha256Hex(paths.join("\n")),
      querySha256: sha256Hex(query),
      rightPathSha256: sha256Hex(rightPath),
      wrongPathSha256: sha256Hex(wrongPath),
    },
    operations: {
      candidate_query_code_unit_pairs:
        point.candidateCount * point.indexedQueryCodeUnits,
      discarded_query_code_units:
        point.queryCodeUnits - point.indexedQueryCodeUnits,
      indexed_candidates: point.candidateCount,
    },
    payload: { paths, query, rightPath, wrongPath },
  };
}

function caseDefinition(caseId) {
  const definition = BENCHMARK_PLAN.cases.find((entry) => entry.id === caseId);
  if (definition === undefined)
    throw new Error(`unknown benchmark case ${caseId}`);
  return definition;
}
