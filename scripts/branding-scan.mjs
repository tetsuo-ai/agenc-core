#!/usr/bin/env node
// branding-scan: allow scanner doc references the patterns it detects
// Branding scan for AgenC-owned ported files. Flags upstream-donor
// identifiers in AgenC-owned content. Real external identifiers (provider
// model IDs, env vars, packages, wire-defined protocol fields) are allowed
// via a curated allow-list defined below.
//
// Override an unavoidable real-identifier match with a same-line or
// previous-line comment containing `branding-scan: allow <reason>`.
//
// Usage:
//   node branding-scan.mjs <file...>
//   node branding-scan.mjs --staged       # scan only files staged in git
//   node branding-scan.mjs --changed      # scan diff vs HEAD
//
// Exit 0 on clean, 1 on findings.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

// branding-scan: allow scanner pattern definitions reference the upstream identifier roots
const FORBIDDEN = [
  // Identifier patterns. `\w*` after the keyword catches camelCase
  // upstream-identifier prefixes; upstream tends to embed the brand
  // inside compound names. Real external identifiers (model IDs, env
  // vars, package names) are skipped via ALLOW_LINE_PATTERNS below.
  { name: "Claude (identifier)", re: /\bClaude\w*/g }, // branding-scan: allow pattern
  { name: "claude (identifier)", re: /\bclaude\w*/g }, // branding-scan: allow pattern
  { name: "Codex (identifier)", re: /\bCodex\w*/g }, // branding-scan: allow pattern
  { name: "codex (identifier)", re: /\bcodex\w*/g }, // branding-scan: allow pattern
  { name: "OpenClaude", re: /\bOpenClaude\w*/gi }, // branding-scan: allow pattern
  { name: ".claude/ path", re: /\.claude\//g }, // branding-scan: allow pattern
  { name: ".codex/ path", re: /\.codex\//g }, // branding-scan: allow pattern
  { name: ".openclaude/ path", re: /\.openclaude\//g }, // branding-scan: allow pattern
  { name: "CLAUDE.md filename", re: /\bCLAUDE\.md\b/g }, // branding-scan: allow pattern
];

// Lines or substrings that legitimately contain a forbidden token. The
// scanner skips a finding when the surrounding line matches any of these.
// Keep this list curated and small; bias toward the override comment for
// one-off cases.
// branding-scan: allow allow-list patterns for legitimate external identifiers
const ALLOW_LINE_PATTERNS = [
  // Anthropic API model IDs (e.g. claude-opus-4-7, claude-sonnet-4-6)
  /claude-(?:opus|sonnet|haiku)-[\d.-]+/i, // branding-scan: allow allow-list pattern
  // Provider-defined env vars
  /\bANTHROPIC_API_KEY\b/,
  /\bANTHROPIC_/,
  /\bVERTEX_AI_/,
  /\bAWS_BEDROCK_/,
  // branding-scan: allow allow-list pattern doc
  // OpenAI's codex model family identifier (the model, not the project)
  /\bcodex-(?:mini|small|medium|large|davinci|001|002)\b/i, // branding-scan: allow allow-list pattern
  // npm package names that legitimately contain these strings
  /["'@][\w-]*claude[\w-]*["']/i, // branding-scan: allow allow-list pattern
  /["']codex[-/][\w@/-]+["']/i, // branding-scan: allow allow-list pattern
  /^check-openclaude-tui-replacement\.mjs$/i, // branding-scan: allow existing parity-contract filename
];

const OVERRIDE_RE = /branding-scan:\s*allow\b/i;

function parseArgs(argv) {
  const args = { mode: "files", files: [] };
  for (const a of argv) {
    if (a === "--staged") args.mode = "staged";
    else if (a === "--changed") args.mode = "changed";
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else args.files.push(a);
  }
  return args;
}

function gitRoot(start) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: start || process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

const UPSTREAM_MIRROR_RE = /^runtime\/src\/agenc\/upstream\//;

function changedLinesForPath(root, rel, mode) {
  const args = mode === "staged"
    ? ["diff", "--cached", "--unified=0", "--", rel]
    : ["diff", "--unified=0", "--", rel];
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  const changed = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      changed.push(line.slice(1).trim());
    }
  }
  return changed;
}

function isAbsorbImportRewriteLine(line) {
  if (line === "") return true;
  return (
    /(?:^import\b|^export\b|from\s+|import\s*\(|require\s*\()/.test(line) &&
    /(?:^|[./])(?:ink(?:\.js|\/)|(?:tui\/)?state\/(?:AppState|AppStateStore|store)(?:\.js)?)/.test(line)
  );
}

function isMirrorAbsorbImportRewriteOnly(root, rel, mode) {
  if (!UPSTREAM_MIRROR_RE.test(rel)) return false;
  const changed = changedLinesForPath(root, rel, mode);
  return changed.length > 0 && changed.every(isAbsorbImportRewriteLine);
}

function listFromGit(mode) {
  const root = gitRoot();
  if (!root) {
    process.stderr.write("[branding-scan] not inside a git repo; pass file paths directly\n");
    process.exit(2);
  }
  const args =
    mode === "staged"
      ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
      : ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"];
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`[branding-scan] git ${args.join(" ")} failed\n`);
    process.exit(2);
  }
  const out = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const abs = path.resolve(root, trimmed);
    if (!existsSync(abs)) continue;
    const rel = path.relative(root, abs).replaceAll("\\", "/");
    if (isMirrorAbsorbImportRewriteOnly(root, rel, mode)) continue;
    out.push(abs);
  }
  return out;
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function isLineAllowed(line, prevLine) {
  // Same-line override always counts.
  if (OVERRIDE_RE.test(line)) return true;
  // Previous-line override only counts when the previous line is a
  // comment-only line — otherwise an override on a separate code line
  // would leak through to unrelated code below it.
  if (OVERRIDE_RE.test(prevLine) && isCommentOnlyLine(prevLine)) return true;
  for (const pattern of ALLOW_LINE_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

async function scanFile(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const findings = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : "";
    for (const { name, re } of FORBIDDEN) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const matchedText = m[0];
        // Per-match allow check: rebuild a "virtual line" that contains
        // just enough context so that ALLOW_LINE_PATTERNS can decide.
        // Cheap heuristic — the patterns are all designed to match
        // line-level context.
        if (isLineAllowed(line, prevLine)) continue;
        findings.push({
          file: filePath,
          line: i + 1,
          column: m.index + 1,
          rule: name,
          matchedText,
          context: line.length > 200 ? line.slice(0, 200) + "..." : line,
        });
      }
    }
  }
  // Filename check: flag if the path itself contains a banned token.
  const baseName = path.basename(filePath);
  // branding-scan: allow filename pattern enumerates the upstream roots
  if (/\b(?:CLAUDE|claude|codex|openclaude|OpenClaude|Codex|Claude)\b/.test(baseName)) {
    // Check if the filename is allowed via the package-name patterns above.
    const allowed = ALLOW_LINE_PATTERNS.some((p) => p.test(baseName));
    if (!allowed) {
      findings.push({
        file: filePath,
        line: 0,
        column: 0,
        rule: "filename contains banned identifier",
        matchedText: baseName,
        context: filePath,
      });
    }
  }
  return findings;
}

function reportFindings(findings) {
  if (findings.length === 0) return;
  const root = gitRoot() || process.cwd();
  const byFile = new Map();
  for (const f of findings) {
    const rel = path.relative(root, f.file);
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push(f);
  }
  for (const [file, items] of byFile) {
    process.stderr.write(`\n${BOLD}${RED}✗ ${file}${RESET} ${DIM}(${items.length})${RESET}\n`);
    for (const item of items) {
      const loc = item.line ? `:${item.line}:${item.column}` : "";
      process.stderr.write(
        `  ${YELLOW}${item.rule}${RESET} → ${BOLD}${item.matchedText}${RESET}${loc}\n`
      );
      if (item.line) {
        process.stderr.write(`    ${DIM}${item.context}${RESET}\n`);
      }
    }
  }
  process.stderr.write(
    `\n${DIM}Override an unavoidable real-identifier match with a same-line or previous-line comment containing 'branding-scan: allow <reason>'.${RESET}\n`
  );
  process.stderr.write(
    `${DIM}Curated allow-list lives in references/branding-rules.md.${RESET}\n`
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  if (args.help || (args.mode === "files" && args.files.length === 0)) {
    process.stdout.write(
      `Usage: branding-scan.mjs <file...> | --staged | --changed\n\n` +
        `Scans files for upstream-donor identifiers in AgenC-owned content.\n` +
        `Override real-identifier matches with a 'branding-scan: allow <reason>' comment.\n`,
    );
    process.exit(args.help ? 0 : 2);
  }

  const files =
    args.mode === "files"
      ? args.files.map((f) => path.resolve(f)).filter((f) => existsSync(f))
      : listFromGit(args.mode);

  if (files.length === 0) {
    process.stdout.write(`[branding-scan] no files to scan\n`);
    process.exit(0);
  }

  const allFindings = [];
  for (const file of files) {
    const findings = await scanFile(file);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    process.stdout.write(
      `[branding-scan] clean (${files.length} file${files.length === 1 ? "" : "s"} scanned)\n`
    );
    process.exit(0);
  }

  process.stderr.write(
    `[branding-scan] ${BOLD}${RED}${allFindings.length} finding${allFindings.length === 1 ? "" : "s"}${RESET} across ${files.length} file${files.length === 1 ? "" : "s"}\n`
  );
  reportFindings(allFindings);
  process.exit(1);
}

await main();
