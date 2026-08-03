import { BENCHMARK_PLAN, canonicalJson, sha256Hex } from "./contract.mjs";

const GENERATOR_VERSION = 1;
const CSV_HEADER = "source_id,task\n";
const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";

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

function caseDefinition(caseId) {
  const definition = BENCHMARK_PLAN.cases.find((entry) => entry.id === caseId);
  if (definition === undefined)
    throw new Error(`unknown benchmark case ${caseId}`);
  return definition;
}
