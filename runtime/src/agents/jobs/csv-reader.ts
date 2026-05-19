/**
 * CSV reader for agent-jobs (reference parity).
 *
 * Hand-written RFC-4180-style parser. The reference agent-jobs surface
 * (`tools/src/agent_job_tool.rs:6-64`) accepts a CSV with a header
 * row and produces one job item per data row.
 *
 * Returns an array of records keyed by header column name. Empty
 * trailing fields are preserved as empty strings.
 *
 * @module
 */

import { readFile } from "node:fs/promises";

export interface CsvRow {
  readonly [column: string]: string;
}

export interface CsvDocument {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<CsvRow>;
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = "CsvParseError";
  }
}

export async function readCsvFile(path: string): Promise<CsvDocument> {
  const text = await readFile(path, "utf8");
  return parseCsv(text);
}

export function parseCsv(text: string): CsvDocument {
  const records = parseRecords(text);
  if (records.length === 0) {
    return { headers: [], rows: [] };
  }
  const [headerRecord, ...dataRecords] = records;
  const headers: string[] = [...headerRecord!];
  // Strip UTF-8 BOM from the first header cell (matches reference
  // agent_jobs.rs:1128-1130).
  if (headers.length > 0) {
    headers[0] = headers[0]!.replace(/^﻿/, "");
  }
  const rows: CsvRow[] = [];
  for (const record of dataRecords) {
    // Skip rows where every field is empty (matches reference
    // agent_jobs.rs:1135-1138).
    if (record.every((cell) => cell.length === 0)) continue;
    const row: { [column: string]: string } = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]!] = record[i] ?? "";
    }
    rows.push(row);
  }
  return { headers, rows };
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.length !== 0) {
        throw new CsvParseError("unexpected `\"` mid-field", line);
      }
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      current.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    if (ch === "\n") {
      current.push(field);
      records.push(current);
      current = [];
      field = "";
      line += 1;
      continue;
    }
    field += ch;
  }
  if (inQuotes) {
    throw new CsvParseError("unterminated quoted field", line);
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    records.push(current);
  }
  return records;
}

export function writeCsv(document: CsvDocument): string {
  const lines: string[] = [];
  lines.push(document.headers.map(escapeCell).join(","));
  for (const row of document.rows) {
    lines.push(
      document.headers.map((header) => escapeCell(row[header] ?? "")).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/gu, '""')}"`;
  }
  return value;
}
