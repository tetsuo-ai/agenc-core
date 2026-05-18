#!/usr/bin/env node
// _deps/ real-vs-stub regression check.
//
// Each runtime subsystem owns a `_deps/` folder with a mix of REAL ports,
// REAL re-exports, parity stubs, and intentional no-ops. The convention is
// that a file literally named `no-op.ts` exports the neutral/shim variant
// of a symbol; if a same-named non-no-op alternative exists somewhere else,
// importing the no-op variant is almost always a regression — the real
// behavior is silently dropped (the symbol still type-checks fine).
//
// Named past incident: `runPostCompactCleanup` was wired to
// `compact/_deps/no-op.ts::getUserContext` for a long time, leaving project
// memory + date stale after every auto-compact. Real impl lived at
// `session/_deps/system-prompt.ts::getUserContext`. Fixed in commit
// f531504, gotcha recorded in agenc-core/.agenc/notes/gotchas.md.
//
// This script catches the same class of regression statically.
//
// Usage:
//   node scripts/check-deps-stubs.mjs                    # scan all source
//   node scripts/check-deps-stubs.mjs --staged           # only staged files
//   node scripts/check-deps-stubs.mjs --changed          # only files that
//                                                          differ from HEAD
//
// Exit 0 on clean, 1 on findings.
//
// Override (only when intentional): add a same-line or previous-line
// comment containing `deps-audit: allow-no-op` next to the import.

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SOURCE_ROOT = path.join(RUNTIME_ROOT, "src");
const REPO_ROOT = path.resolve(RUNTIME_ROOT, "..");
const SOURCE_FILE_RE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_FILE_RE = /\.test\.(?:ts|tsx|mts|cts)$/;
const ALLOW_OVERRIDE_RE = /deps-audit:\s*allow-no-op/i;

function log(msg) {
  process.stdout.write(`[check:deps-stubs] ${msg}\n`);
}
function err(msg) {
  process.stderr.write(`[check:deps-stubs] ${msg}\n`);
}

function parseArgs(argv) {
  const args = { mode: "all" };
  for (const a of argv) {
    if (a === "--staged") args.mode = "staged";
    else if (a === "--changed") args.mode = "changed";
    else if (a === "--all") args.mode = "all";
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      yield* walk(full);
    } else if (SOURCE_FILE_RE.test(entry.name)) {
      yield full;
    }
  }
}

async function findDepsFiles() {
  const out = [];
  for await (const file of walk(SOURCE_ROOT)) {
    if (file.includes(`${path.sep}_deps${path.sep}`) && !TEST_FILE_RE.test(file)) {
      out.push(file);
    }
  }
  return out;
}

// Extract exported symbol names from a TS file. Captures common forms:
//   export function name(...)
//   export async function name(...)
//   export const name = ...
//   export let name = ...
//   export class Name
//   export interface Name
//   export type Name
//   export enum Name
//   export { a, b as c, default as d }
//   (does NOT capture `export default ...` since defaults aren't named)
const EXPORT_PATTERNS = [
  /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/gm,
];

function parseExports(source) {
  const names = new Set();
  for (const re of EXPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  // export { a, b as c } [from "..."]
  const braceRe = /export\s*\{([^}]+)\}/g;
  let m;
  while ((m = braceRe.exec(source)) !== null) {
    const body = m[1];
    for (const part of body.split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      // `name`, `name as alias`, `default as alias`
      const asMatch = piece.match(/(?:^|\s)as\s+([A-Za-z_$][\w$]*)\s*$/);
      const exportedName = asMatch
        ? asMatch[1]
        : piece.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (exportedName) names.add(exportedName);
    }
  }
  return names;
}

const IMPORT_LINE_RE =
  /^\s*import\s+(?:type\s+)?(?:(\*\s+as\s+[A-Za-z_$][\w$]*)|(\{[^}]*\})|([A-Za-z_$][\w$]*(?:\s*,\s*\{[^}]*\})?))\s+from\s+['"]([^'"]+)['"]/;

function parseImports(source) {
  const out = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(IMPORT_LINE_RE);
    if (!m) continue;
    const namespaceImport = m[1];
    const namedImports = m[2];
    const defaultPart = m[3];
    const fromPath = m[4];
    const symbols = [];
    if (namespaceImport) {
      // import * as ns from "..." — symbols are accessed via ns.X, hard to track
      // statically. Skip; our interest is named imports.
    }
    if (namedImports) {
      const inner = namedImports.replace(/[{}]/g, "");
      for (const part of inner.split(",")) {
        const piece = part.trim();
        if (!piece) continue;
        const asMatch = piece.match(/^([A-Za-z_$][\w$]*)\s+as\s+/);
        const name = asMatch ? asMatch[1] : piece.match(/^([A-Za-z_$][\w$]*)/)?.[1];
        if (name) symbols.push(name);
      }
    }
    if (defaultPart && !defaultPart.includes("{")) {
      // default import — not in scope, default-exporting modules aren't
      // typically the no-op pattern.
    }
    if (symbols.length === 0) continue;
    // Look for an allow-override comment on this line or the previous line.
    const prevLine = i > 0 ? lines[i - 1] : "";
    const allowed = ALLOW_OVERRIDE_RE.test(line) || ALLOW_OVERRIDE_RE.test(prevLine);
    out.push({
      lineNumber: i + 1,
      raw: line,
      from: fromPath,
      symbols,
      allowed,
    });
  }
  return out;
}

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts"];

function resolveImportPath(importingFile, importPath) {
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;
  const dir = path.dirname(importingFile);
  let base;
  if (importPath.startsWith("/")) base = importPath;
  else base = path.resolve(dir, importPath);
  // Strip a trailing .js extension (TS-style import that points at the
  // emitted .js but sources still live as .ts).
  if (base.endsWith(".js")) base = base.slice(0, -3);
  for (const ext of ["", ...RESOLVE_EXTS]) {
    const candidate = ext ? base + ext : base;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const ext of RESOLVE_EXTS) {
    const candidate = path.join(base, "index" + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isNoOpFile(filePath) {
  return path.basename(filePath) === "no-op.ts";
}

async function buildSymbolMap() {
  const depsFiles = await findDepsFiles();
  const map = new Map(); // symbol -> { noop: Set<path>, real: Set<path> }
  for (const file of depsFiles) {
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const exports = parseExports(source);
    if (exports.size === 0) continue;
    const noop = isNoOpFile(file);
    for (const name of exports) {
      let entry = map.get(name);
      if (!entry) {
        entry = { noop: new Set(), real: new Set() };
        map.set(name, entry);
      }
      if (noop) entry.noop.add(file);
      else entry.real.add(file);
    }
  }
  return map;
}

async function listSourceFiles(mode) {
  if (mode === "all") {
    const out = [];
    for await (const file of walk(SOURCE_ROOT)) {
      if (TEST_FILE_RE.test(file)) continue;
      if (file.includes(`${path.sep}_deps${path.sep}`)) continue;
      out.push(file);
    }
    return out;
  }
  // staged or changed — use git to get the list
  const args =
    mode === "staged"
      ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
      : ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"];
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    err(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
    process.exit(2);
  }
  const out = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const abs = path.resolve(REPO_ROOT, trimmed);
    if (!abs.startsWith(SOURCE_ROOT + path.sep)) continue;
    if (!SOURCE_FILE_RE.test(abs)) continue;
    if (TEST_FILE_RE.test(abs)) continue;
    if (abs.includes(`${path.sep}_deps${path.sep}`)) continue;
    if (existsSync(abs)) out.push(abs);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    err(e.message);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(
      `Usage: check-deps-stubs.mjs [--staged | --changed | --all]\n\n` +
        `Default is --all. Use --staged from a pre-commit hook for speed.\n` +
        `Override an intentional no-op import with a same- or previous-line\n` +
        `comment containing 'deps-audit: allow-no-op'.\n`,
    );
    process.exit(0);
  }

  const symbolMap = await buildSymbolMap();
  const sources = await listSourceFiles(args.mode);
  if (args.mode !== "all" && sources.length === 0) {
    log(`no relevant source files in ${args.mode} set; skipping`);
    process.exit(0);
  }

  const findings = [];
  for (const file of sources) {
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const imports = parseImports(source);
    for (const imp of imports) {
      const resolved = resolveImportPath(file, imp.from);
      if (!resolved) continue;
      if (!isNoOpFile(resolved)) continue;
      // The import path lands on a no-op file. For each symbol the importer
      // pulls in, check whether a non-no-op file also exports the same name.
      for (const symbol of imp.symbols) {
        const entry = symbolMap.get(symbol);
        if (!entry || entry.real.size === 0) continue;
        // The symbol has a real alternative somewhere. Verify the no-op file
        // we resolved to actually exports the symbol (otherwise the import
        // would already be a TS error and isn't our concern).
        if (!entry.noop.has(resolved)) continue;
        if (imp.allowed) continue; // explicit override
        findings.push({
          callsite: file,
          line: imp.lineNumber,
          symbol,
          noopPath: resolved,
          realPaths: [...entry.real],
        });
      }
    }
  }

  if (findings.length === 0) {
    log(
      `clean (mode=${args.mode}, scanned ${sources.length} source file${sources.length === 1 ? "" : "s"}, ${symbolMap.size} symbols indexed across _deps/)`,
    );
    process.exit(0);
  }

  err(`FAIL: ${findings.length} no-op import${findings.length === 1 ? "" : "s"} have a real alternative`);
  for (const f of findings) {
    const cs = path.relative(REPO_ROOT, f.callsite);
    const np = path.relative(REPO_ROOT, f.noopPath);
    err(`  ${cs}:${f.line}: imports ${f.symbol} from ${np} (no-op)`);
    for (const real of f.realPaths) {
      err(`    real impl: ${path.relative(REPO_ROOT, real)}`);
    }
    err(
      `    if this is intentional, add a 'deps-audit: allow-no-op' comment on the import line.`,
    );
  }
  process.exit(1);
}

await main();
