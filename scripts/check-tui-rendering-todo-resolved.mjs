#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const todoPath = ["TO", "DO.MD"].join("");
const accepted = new Set(["OK"]);
const rejected = new Set(["BUG", "MISSING", "LEGACY"]);

if (!existsSync(todoPath)) {
  process.stderr.write(`${todoPath} is required for the TUI rendering audit check.\n`);
  process.exit(1);
}

const unresolved = [];
const rows = readFileSync(todoPath, "utf8").split(/\r?\n/);
for (const line of rows) {
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").map(cell => cell.trim());
  if (cells.length < 8) continue;
  const rowNumber = Number(cells[1]);
  const status = cells[5];
  if (!Number.isInteger(rowNumber)) continue;
  if (rejected.has(status)) {
    unresolved.push({ rowNumber, status, scenario: cells[2] });
  } else if (!accepted.has(status)) {
    process.stderr.write(
      `Unexpected audit status on row ${rowNumber}: ${status || "(empty)"}\n`,
    );
    process.exit(1);
  }
}

if (unresolved.length > 0) {
  process.stderr.write("TUI rendering audit still has unresolved rows:\n");
  for (const row of unresolved) {
    process.stderr.write(`  - #${row.rowNumber} ${row.status}: ${row.scenario}\n`);
  }
  process.exit(1);
}

  process.stdout.write("TUI rendering audit matrix rows are resolved.\n");
