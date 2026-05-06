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
  //
  // NOTE: agent-tool config dotfile paths and standard agent-instruction
  // markdown filenames are intentionally NOT in this list. Those refer to
  // the AI assistants that work on the codebase, not to the product. A
  // gate that wires implementer-tool config is legitimate. The donor
  // product names as identifiers in code are still banned via the
  // patterns below.
  { name: "Claude (identifier)", re: /\bClaude\w*/g }, // branding-scan: allow pattern
  { name: "claude (identifier)", re: /\bclaude\w*/g }, // branding-scan: allow pattern
  { name: "Codex (identifier)", re: /\bCodex\w*/g }, // branding-scan: allow pattern
  { name: "codex (identifier)", re: /\bcodex\w*/g }, // branding-scan: allow pattern
  { name: "OpenClaude", re: /\bOpenClaude\w*/gi }, // branding-scan: allow pattern
  { name: ".openclaude/ path", re: /\.openclaude\//g }, // branding-scan: allow pattern
  // Competitor / donor-organization names. Real product/org names that
  // should never appear as bare identifiers in AgenC user-facing strings
  // or module names. Real provider/model identifiers and lowercase npm
  // package names ARE allowed via ALLOW_LINE_PATTERNS / per-line override
  // comments.
  { name: "Anthropic (identifier)", re: /\bAnthropic\b/g }, // branding-scan: allow pattern
  { name: "OpenAI (identifier)", re: /\bOpenAI\b/g }, // branding-scan: allow pattern
  { name: "Cursor (identifier)", re: /\bCursor\b/g }, // branding-scan: allow pattern
  { name: "Cline (identifier)", re: /\bCline\b/g }, // branding-scan: allow pattern
  { name: "Aider (identifier)", re: /\bAider\b/g }, // branding-scan: allow pattern
  { name: "Devin (identifier)", re: /\bDevin\b/g }, // branding-scan: allow pattern
  { name: "Replit (identifier)", re: /\bReplit\b/g }, // branding-scan: allow pattern
  // Cyrillic homoglyph evasion: a token that mixes Cyrillic with Latin
  // letters is either an accidental unicode-paste artifact or a deliberate
  // evasion. Either way it's a bug.
  { name: "Latin/Cyrillic homoglyph token", re: /\b\w*[А-Яа-я]+\w*\b/g }, // branding-scan: allow pattern
  // Full-width Latin used to spoof identifiers (e.g. F-U-L-L-W-I-D-T-H
  // C-l-a-u-d-e). Anything 3+ full-width Latin chars in a row in source
  // code is suspicious.
  { name: "Full-width Latin in identifier", re: /[Ａ-Ｚａ-ｚ]{3,}/g }, // branding-scan: allow pattern
];

// Lines or substrings that legitimately contain a forbidden token. The
// scanner skips a finding when the surrounding line matches any of these.
// Keep this list curated and small; bias toward the override comment for
// one-off cases.
// branding-scan: allow allow-list patterns for legitimate external identifiers
const ALLOW_LINE_PATTERNS = [
  // Anthropic API model IDs (e.g. claude-opus-4-7, claude-sonnet-4-6)
  /claude-(?:opus|sonnet|haiku)-[\d.-]+/i, // branding-scan: allow allow-list pattern
  /claude-\d+(?:[-.@]\w+)+/i, // branding-scan: allow documented Anthropic model identifier
  // Provider-defined env vars
  /\bANTHROPIC_API_KEY\b/,
  /\bANTHROPIC_/,
  /\bVERTEX_AI_/,
  /\bAWS_BEDROCK_/,
  // branding-scan: allow allow-list pattern doc
  // OpenAI's codex model family identifier (the model, not the project)
  /\bcodex-(?:mini|small|medium|large|davinci|001|002)\b/i, // branding-scan: allow allow-list pattern
  /\bgpt-[\w.-]*codex[\w.-]*\b/i, // branding-scan: allow documented OpenAI model identifier
  // npm package names that legitimately contain these strings
  /["'@][\w-]*claude[\w-]*["']/i, // branding-scan: allow allow-list pattern
  /["']codex[-/][\w@/-]+["']/i, // branding-scan: allow allow-list pattern
];

const ALLOW_FILE_LINE_PATTERNS = [
  {
    file: /(^|\/)PARITY\.md$/,
    line: /\b(?:OpenClaude\w*|openclaude|Claude\w*|claude|Codex\w*|codex|Anthropic)\b|\.openclaude\//, // branding-scan: allow source citation files
  },
  {
    // .gitignore must literally name the external assistant/IDE config
    // dirs and files it is keeping out of the repo.
    file: /(^|\/)\.gitignore$/,
    line: /\b(?:OpenClaude\w*|openclaude|Claude\w*|claude|Codex\w*|codex|Cursor)\b|\.openclaude\//, // branding-scan: allow gitignore exception pattern
  },
  {
    // Provider-management UI needs to render real provider names and
    // ChatGPT credential labels. Keep this scoped to the provider
    // setup surfaces instead of allowing these identifiers globally.
    file: /(^|\/)runtime\/src\/tui\/components\/(?:ProviderManager(?:\.test)?|ConsoleOAuthFlow(?:\.test)?|useCodexOAuthFlow(?:\.test)?)\.(?:ts|tsx)$/,
    line: /\b(?:Anthropic|OpenAI|Codex\w*|codex\w*)\b|chatgpt\.com\/(?:backend-api\/)?codex|CODEX_/, // branding-scan: allow scanner allow-list regex
  },
  {
    // Usage and effort UI may refer to the real provider family.
    file: /(^|\/)runtime\/src\/tui\/components\/(?:EffortPicker|Settings\/CodexUsage)\.(?:ts|tsx)$/, // branding-scan: allow scanner allow-list regex
    line: /\b(?:OpenAI|Codex\w*|codex\w*)\b/, // branding-scan: allow scanner allow-list regex
  },
  {
    // OpenAI/Codex provider transport internals necessarily refer to // branding-scan: allow scanner allow-list comment
    // provider-defined names, env vars, auth files, and wire transports.
    file: /(^|\/)runtime\/src\/agenc\/upstream\/services\/api\/(?:codexUsage|openaiShim|providerConfig(?:\.[^.]+)*?)\.ts$/, // branding-scan: allow scanner allow-list regex
    line: /\b(?:Anthropic|OpenAI|Codex\w*|codex\w*|claude\w*)\b|CODEX_|CHATGPT_|\.codex|chatgpt\.com\/backend-api\/codex|codex_responses/, // branding-scan: allow scanner allow-list regex
  },
  {
    // Text input internals use a caret utility type, not as an
    // editor/product reference.
    file: /(^|\/)runtime\/src\/tui\/(?:hooks\/(?:useTextInput|useSearchInput|useVimInput)|components\/TextInput(?:\.test)?)\.(?:ts|tsx)$/,
    line: /\bCursor\b/, // branding-scan: allow text-caret utility identifier
  },
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

function isAbsorbImportRewriteLine(line, rel) {
  if (line === "") return true;
  if (isCommentOnlyLine(line)) return true;
  if (
    /promptSuggestionEnabled:\s*shouldEnablePromptSuggestion\((?:getInitialSettings\(\)|\{.*getInitialSettings\(\).*\})?\),/.test(line) ||
    /void executePromptSuggestion\(stopHookContext(?:,|\))/.test(line)
  ) {
    return true;
  }
  if (
    UPSTREAM_MIRROR_RE.test(rel) &&
    // branding-scan: allow scanner regex enumerates credential symbol rewrite names
    /(?:\b(?:read|refresh|is)(?:Codex|Agenc)(?:Credentials(?:Async)?|AccessTokenIfNeeded|RefreshFailureCoolingDown)\b|\b(?:Codex|Agenc)CredentialBlob\b)/.test(line)
  ) {
    return true;
  }
  if (!/(?:^import\b|^export\b|from\s+|import\s*\(|require\s*\()/.test(line)) {
    return false;
  }
  if (
    UPSTREAM_MIRROR_RE.test(rel) &&
    /(?:^|['"`(])(?:[./]+|src\/)(?:utils|constants)\/[\w@./?&=-]+(?:\.js)?/.test(line)
  ) {
    return true;
  }
  const commonAbsorbImportPatterns = [
    /(?:^|[./])utils\/(?:config|cwd)(?:\.js)?/,
    /(?:^|[./])ink(?:\.js|\/)/,
    /(?:^|[./])(?:tui\/)?state\/(?:AppState|AppStateStore|store)(?:\.js)?/,
    /(?:^|[./])(?:tui\/)?keybindings\//,
    /(?:^|[./])(?:tui\/)?components\/permissions\/PermissionRequest(?:\.js)?/,
    /(?:^|[./])PermissionRequest(?:\.js)?/,
    /(?:^|[./])(?:tui\/)?components\/PromptInput\//,
    /(?:^|[./])PromptInput\//,
    /(?:^|[./])(?:tui\/)?components\/Messages(?:\.js)?/,
    /(?:^|[./])Messages(?:\.js)?/,
    /(?:^|[./])tui\/components\/App(?:\.js)?/,
    /(?:^|[./])components\/App(?:\.js)?/,
    /(?:^|[./])tools\/AgentTool\/(?:loadAgentsDir|agentColorManager|constants|prompt)(?:\.js)?/,
    /(?:^|[./])tools\/AskUserQuestionTool\/(?:AskUserQuestionTool|prompt)(?:\.js)?/,
    /(?:^|[./])tools\/BriefTool\/prompt(?:\.js)?/,
    /(?:^|[./])AgentTool\/(?:loadAgentsDir|agentColorManager|constants|prompt)(?:\.js)?/,
    /(?:^|[./])AskUserQuestionTool\/(?:AskUserQuestionTool|prompt)(?:\.js)?/,
    /(?:^|[./])BriefTool\/prompt(?:\.js)?/,
    /(?:^|[./])slash\/(?:argument-substitution|slash-command-parsing)(?:\.js)?/,
    /(?:^|[./])(?:utils\/)?(?:argumentSubstitution|slashCommandParsing)(?:\.js)?/,
    /(?:^|[./])(?:tui\/)?history\/(?:history|HistorySearchDialog|ResumeConversation|transcriptSearch)(?:\.js)?/,
    /(?:^|[./])history(?:\.js)?/,
    /(?:^|[./])components\/HistorySearchDialog(?:\.js)?/,
    /(?:^|[./])screens\/ResumeConversation(?:\.js)?/,
    /(?:^|[./])utils\/transcriptSearch(?:\.js)?/,
    /(?:^|[./])(?:tui\/)?cost\/(?:Stats|TokenWarning|MemoryUsageIndicator|tokenAnalytics)(?:\.js)?/,
    /(?:^|[./])components\/(?:Stats|TokenWarning|MemoryUsageIndicator)(?:\.js)?/,
    /(?:^|[./])utils\/tokenAnalytics(?:\.js)?/,
    /(?:^|[./])(?:tui\/)?components\/spinner\/(?:Spinner|FlashingChar|GlimmerMessage|ShimmerChar|SpinnerAnimationRow|SpinnerGlyph|TeammateSpinnerLine|TeammateSpinnerTree|teammateSelectHint|types|useShimmerAnimation|useStalledAnimation|utils)(?:\.js)?/,
    /(?:^|[./])components\/Spinner(?:\/(?:FlashingChar|GlimmerMessage|ShimmerChar|SpinnerAnimationRow|SpinnerGlyph|TeammateSpinnerLine|TeammateSpinnerTree|index|teammateSelectHint|types|useShimmerAnimation|useStalledAnimation|utils))?(?:\.js)?/,
    /(?:^|[./])Spinner(?:\.js|\/(?:FlashingChar|GlimmerMessage|ShimmerChar|SpinnerAnimationRow|SpinnerGlyph|TeammateSpinnerLine|TeammateSpinnerTree|index|teammateSelectHint|types|useShimmerAnimation|useStalledAnimation|utils)(?:\.js)?)/,
    /(?:^|[./])(?:tui\/)?components\/markdown\/(?:Markdown|MarkdownTable|HighlightedCode|HighlightedCodeFallback)(?:\.js)?/,
    /(?:^|[./])components\/(?:Markdown|MarkdownTable|HighlightedCode)(?:\.js|\/Fallback(?:\.js)?)?/,
    /(?:^|[./])(?:Markdown|MarkdownTable|HighlightedCode)(?:\.js|\/Fallback(?:\.js)?)?/,
    /(?:^|[./])(?:tui\/)?components\/dialogs\/(?:CostThresholdDialog|RateLimitMessage)(?:\.js)?/,
    /(?:^|[./])(?:tui\/)?components\//,
    /(?:^|[./])(?:tui\/)?hooks\//,
    /(?:^|[./])(?:tui\/)?context\//,
    /(?:^|[./])components\/(?:CostThresholdDialog|messages\/RateLimitMessage)(?:\.js)?/,
    /(?:^|[./])(?:CostThresholdDialog|RateLimitMessage)(?:\.js)?/,
    /(?:^|[./])services\/PromptSuggestion\/(?:promptSuggestion|speculation)(?:\.js)?/,
    /(?:^|[./])components\/CustomSelect\/(?:index|select|SelectMulti)(?:\.js)?/,
    /(?:^|[./])CustomSelect\/(?:index|select|SelectMulti)(?:\.js)?/,
    /(?:^|[./])commands(?:\.js)?/,
  ];
  if (commonAbsorbImportPatterns.some((pattern) => pattern.test(line))) {
    return true;
  }
  if (/^runtime\/src\/agenc\/upstream\/tools\/AgentTool\//.test(rel)) {
    return /(?:^|[./])(?:loadAgentsDir|agentColorManager|constants|prompt)(?:\.js)?/.test(line);
  }
  if (/^runtime\/src\/agenc\/upstream\/tools\/BriefTool\//.test(rel)) {
    return /(?:^|[./])prompt(?:\.js)?/.test(line);
  }
  return false;
}

function isMirrorAbsorbImportRewriteOnly(root, rel, mode) {
  if (!UPSTREAM_MIRROR_RE.test(rel)) return false;
  const changed = changedLinesForPath(root, rel, mode);
  return changed.length > 0 && changed.every((line) => isAbsorbImportRewriteLine(line, rel));
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

function isLineAllowed(line, prevLine, relPath) {
  // Same-line override always counts.
  if (OVERRIDE_RE.test(line)) return true;
  // Previous-line override only counts when the previous line is a
  // comment-only line — otherwise an override on a separate code line
  // would leak through to unrelated code below it.
  if (OVERRIDE_RE.test(prevLine) && isCommentOnlyLine(prevLine)) return true;
  for (const pattern of ALLOW_LINE_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  for (const { file, line: linePattern } of ALLOW_FILE_LINE_PATTERNS) {
    if (file.test(relPath) && linePattern.test(line)) return true;
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
  const root = gitRoot() || process.cwd();
  const rel = path.relative(root, filePath).replaceAll("\\", "/");
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
        if (isLineAllowed(line, prevLine, rel)) continue;
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
  // CLAUDE.md and AGENTS.md are agent-tool instruction files and explicitly
  // allowed — they are not product-brand leaks.
  const baseName = path.basename(filePath);
  // branding-scan: allow filename pattern enumerates the upstream roots
  if (/\b(?:CLAUDE|claude|codex|openclaude|OpenClaude|Codex|Claude)\b/.test(baseName)) {
    // Check if the filename is allowed via the package-name patterns above.
    const allowed =
      baseName === "CLAUDE.md" ||
      baseName === "AGENTS.md" ||
      rel === "runtime/src/agenc/upstream/services/api/claude.ts" || // branding-scan: allow existing upstream provider API filename
      ALLOW_LINE_PATTERNS.some((p) => p.test(baseName));
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
  // Directory-path check: flag any directory in the path that is donor-named OR
  // uses a known donor-evasion alias (donor/mirror/vendored/external/_oc/_cx).
  // The only allowed donor-named location is the upstream mirror while it
  // exists. Everywhere else is a leak.
  const dirComponents = path.dirname(rel).split("/").filter(Boolean);
  for (const comp of dirComponents) {
    const isDonorName = /^(?:openclaude|codex|claude|OpenClaude|Codex|Claude)$/i.test(comp); // branding-scan: allow regex enumerates the banned donor dir names
    const isEvasionName = /^(?:donor|mirror|vendored|external|_oc|_cx|_donor|_mirror|_vendored|_external)$/i.test(comp);
    if (isDonorName || isEvasionName) {
      const inUpstreamMirror = rel.startsWith("runtime/src/agenc/upstream/");
      if (isDonorName && inUpstreamMirror) continue;
      findings.push({
        file: filePath,
        line: 0,
        column: 0,
        rule: isDonorName
          ? "donor-named directory in AgenC-owned path"
          : "donor-evasion directory name (donor/mirror/vendored/external/_oc/_cx alias)",
        matchedText: comp + "/",
        context: rel,
      });
      break;
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
