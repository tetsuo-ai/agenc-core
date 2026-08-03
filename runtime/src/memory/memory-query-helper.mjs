#!/usr/bin/env node

import { Buffer } from "node:buffer";
import process from "node:process";

import Database from "better-sqlite3";

const PROTOCOL_VERSION = 1;
const FRAME_HEADER_BYTES = 4;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_CANDIDATES = 200;
const TITLE_WEIGHT = 5.0;
const DESCRIPTION_WEIGHT = 2.0;

let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  if (input.byteLength > FRAME_HEADER_BYTES + MAX_REQUEST_BYTES) {
    writeResponse(
      errorResponse("invalid_request", "request frame exceeds limit"),
    );
    process.exitCode = 2;
    break;
  }
}

if (process.exitCode === undefined) {
  try {
    writeResponse(runQuery(decodeRequest(input)));
  } catch (error) {
    writeResponse(
      errorResponse(
        sqliteCapabilityError(error)
          ? "capability_unavailable"
          : "query_failed",
        error instanceof Error ? error.message : String(error),
      ),
    );
    process.exitCode = 1;
  }
}

function decodeRequest(frame) {
  if (frame.byteLength < FRAME_HEADER_BYTES) {
    throw new Error("request frame is truncated");
  }
  const payloadLength = frame.readUInt32BE(0);
  if (
    payloadLength > MAX_REQUEST_BYTES ||
    payloadLength !== frame.byteLength - FRAME_HEADER_BYTES
  ) {
    throw new Error("request frame length does not match payload");
  }
  const request = JSON.parse(
    frame.subarray(FRAME_HEADER_BYTES).toString("utf8"),
  );
  if (
    request === null ||
    typeof request !== "object" ||
    request.protocolVersion !== PROTOCOL_VERSION ||
    typeof request.databasePath !== "string" ||
    typeof request.rootId !== "string" ||
    !Number.isSafeInteger(request.generationId) ||
    (request.rootRole !== "global" && request.rootRole !== "project") ||
    typeof request.match !== "string" ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_CANDIDATES
  ) {
    throw new Error("request fields are invalid");
  }
  return request;
}

function runQuery(request) {
  const database = new Database(request.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma("query_only = ON");
    database.pragma("trusted_schema = OFF");
    const rows = database
      .prepare(
        `SELECT e.memory_id AS memoryId,
                e.canonical_path AS canonicalPath,
                e.title,
                e.description,
                e.memory_type AS type,
                e.mtime_ms AS mtimeMs,
                e.file_size AS size,
                e.fingerprint,
                e.root_id AS rootId,
                bm25(memory_fts, 0.0, 0.0, 0.0, ${TITLE_WEIGHT}, ${DESCRIPTION_WEIGHT}) AS bm25Score
           FROM memory_fts
           JOIN memory_index_entries e
             ON e.root_id = memory_fts.root_id
            AND e.generation_id = memory_fts.generation_id
            AND e.memory_id = memory_fts.memory_id
          WHERE memory_fts MATCH ?
            AND e.root_id = ?
            AND e.generation_id = ?
          ORDER BY bm25Score ASC,
                   CAST(e.canonical_path AS BLOB) ASC,
                   CAST(e.memory_id AS BLOB) ASC
          LIMIT ?`,
      )
      .all(request.match, request.rootId, request.generationId, request.limit);
    return {
      protocolVersion: PROTOCOL_VERSION,
      kind: "ok",
      candidates: rows.map((row) => ({
        ...row,
        rootRole: request.rootRole,
      })),
    };
  } finally {
    database.close();
  }
}

function writeResponse(response) {
  let payload = Buffer.from(JSON.stringify(response), "utf8");
  if (payload.byteLength > MAX_RESULT_BYTES) {
    payload = Buffer.from(
      JSON.stringify(
        errorResponse("query_resource_limited", "query result exceeds limit"),
      ),
      "utf8",
    );
    process.exitCode = 3;
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  process.stdout.write(frame);
}

function errorResponse(code, message) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "error",
    code,
    message,
  };
}

function sqliteCapabilityError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fts5|no such module|malformed MATCH/iu.test(message);
}
