#!/usr/bin/env node
// Senior-engineer reviewer gate for a PORT_CHECKLIST.md item.
//
// Usage:
//   node scripts/goal/review.mjs <item-id>
//
// branding-scan: allow names the reviewer CLI binary that this script invokes
// Spawns a fresh reviewer subagent (via the codex exec review CLI) against
// the changes on the current port/<item-id> branch, with structured prompt
// including the item spec and the operating discipline. Reads the final
// reviewer message and parses a VERDICT line.
//
// Exit 0 only when the reviewer returns VERDICT: APPROVED.
// On NEEDS_REVISION / BLOCKED / parse failure, exit 1 with the issue list.
//
// Skip with env AGENC_SKIP_REVIEW=1 (escape hatch for emergencies).
// Override the reviewer model with env AGENC_REVIEW_MODEL=<model>.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { findItem, mainCheckoutRoot, repoRoot } from "./checklist-utils.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

function usage() {
  process.stderr.write(`Usage: node scripts/goal/review.mjs <item-id>\n`);
  process.exit(2);
}

const id = process.argv[2];
if (!id) usage();

if (process.env.AGENC_SKIP_REVIEW === "1") {
  const reason = (process.env.AGENC_SKIP_REVIEW_REASON || "").trim();
  if (!reason) {
    process.stderr.write(`${BOLD}${RED}✗${RESET} AGENC_SKIP_REVIEW=1 set but AGENC_SKIP_REVIEW_REASON is empty. ` +
      `Skipping review without recording why is forbidden.\n`);
    process.exit(2);
  }
  const markerDir = path.join(mainCheckoutRoot(), ".goal-review-skipped");
  try { mkdirSync(markerDir, { recursive: true }); } catch {}
  const marker = {
    id,
    skipped_at: new Date().toISOString(),
    reason,
    user: process.env.USER || "unknown",
  };
  writeFileSync(path.join(markerDir, `${id}.json`), JSON.stringify(marker, null, 2) + "\n", "utf8");
  process.stdout.write(`${YELLOW}!${RESET} reviewer SKIPPED for ${id} (audit marker written: .goal-review-skipped/${id}.json)\n`);
  process.stdout.write(`${YELLOW}!${RESET} reason: ${reason}\n`);
  process.exit(0);
}

const root = repoRoot();
const { item } = await findItem(id);

const disciplinePath = path.join(root, "GOAL_DISCIPLINE.md");
const discipline = existsSync(disciplinePath) ? readFileSync(disciplinePath, "utf8") : "";
const crossRepoEvidence = collectCrossRepoEvidence(`${item.title}\n${item.body}`);
const itemScopedReviewNotes = id === "PE-09"
  ? "PE-09 intentionally carries the local goal-harness worktree migration in scripts/goal/*.mjs because the user directed that harness change to merge with this item. Review those files for correctness, but do not reject PE-09 solely because those harness files are present in the diff."
  : id === "ZC-12"
    ? "ZC-12 must not rename or add files inside runtime/src/agenc/upstream/. Pre-existing donor-named tracked paths under that frozen mirror are resolved for this item by deferral to the upstream-mirror deletion items. Reject donor-named tracked paths outside that mirror, stale references to deleted port artifacts, or any new/renamed upstream mirror target."
  : "No item-specific review notes.";

const reviewerInstructions = `You are a senior software engineer reviewing one work item from an AgenC port checklist.

ITEM ID: ${id}
ITEM TITLE: ${item.title}
ITEM PHASE: ${item.phase}
ITEM SPEC (verbatim from PORT_CHECKLIST.md):
${item.body}

Your job: read the diff against main on the current port/${id} branch and judge whether the implementation is correct, complete, and well-tested for what the item asks for. Look for:

1. Behavioral correctness — does the code actually do what the item says, not just have the right shape?
2. Edge cases — what's missing? What inputs would break this?
3. Test quality — do the tests exercise real behavior, or only assert structure / file existence? Are there fuzz / property-style checks where appropriate?
4. Naming and branding — any leaks of forbidden upstream-donor identifier roots in AgenC-owned files? Real provider/model identifiers are allowed.
5. Domain hygiene — no invented domains in code (URN form or omit). The only AgenC-owned domain is agenc.tech.
6. Scope discipline — did the agent expand beyond the item, or shrink it too aggressively? If the agent narrowed scope due to a missing dependency, did it document the gap clearly?
7. Architecture — anything in this change that will bite a downstream item?

8. HARD REJECTS (CRITICAL — verify gates should have caught these; if they passed, ALSO flag verify.mjs as broken):

   Before writing the verdict, run \`git diff main...HEAD --name-status\` mentally over the diff in front of you. Reject the item with VERDICT: NEEDS_REVISION if you see ANY of:

   a. New file added under \`runtime/src/agenc/upstream/\`. That tree is frozen scaffolding scheduled for deletion at Z-02. ${'' /* branding-scan: allow rule explainer references the upstream mirror dir */}
   b. New file matching shim-suffix pattern outside the two legitimate dirs:
        suffixes: -shim, -adapter, -compat, -legacy, -bridge, -wrapper, -facade,
                  -proxy, -glue, -forwarder, -passthrough, -stub, -indirect,
                  -dispatch, -barrel
        extensions: .ts .tsx .mts .cts .mjs .cjs .js .jsx
        legitimate dirs: runtime/src/tui/bridges/ , runtime/src/mcp-client/
   c. New directory whose name is openclaude, codex, claude, OpenClaude, Codex, or Claude in any AgenC-owned tree. ${'' /* branding-scan: allow rule explainer enumerates the banned donor dir names */}
   d. New directory whose name is a donor-evasion alias: donor, mirror, vendored, external, _oc, _cx, _donor, _mirror, _vendored, _external. (No legitimate AgenC code uses these names.)
   e. New module whose body is overwhelmingly forwarders — all of \`export * from\`, \`export { foo } from\`, \`export type * from\`, \`export default X\`, single-line wrapper functions, or bare \`import\` + \`export\`. A barrel file or index.ts that only re-exports counts. Threshold: <40 significant lines AND >80% forward-pattern lines.
   f. Wrapper left at the old location when porting agenc/upstream/X → runtime/src/Y. All callers must be migrated in the same item; the old path must be deleted.
   g. Net-positive line growth in any existing file under \`runtime/src/agenc/upstream/\`. Only deletions are allowed there.

   If verify.mjs Gates 2/2.5/2.6/3 should have caught any of (a)–(g) and didn't, escalate as a SECOND CRITICAL: "verify-gate hole — pattern <X> must be enforced upstream of the reviewer".

Operating discipline that the implementing agent was bound by:
${discipline}

Cross-repo review evidence:
${crossRepoEvidence}

Item-specific review notes:
${itemScopedReviewNotes}

Some checklist items explicitly name sibling repositories such as
\`agenc-sdk/\`, \`agenc-protocol/\`, or \`agenc-plugin-kit/\`. For those
items, evaluate the named sibling repository state and evidence above as part
of the item. The agenc-core diff may carry only the local contract gate for
that sibling deliverable. Still reject the item if the sibling evidence is
missing, unmerged locally, untested, or does not satisfy the item.
Ignore unrelated dirty sibling files that do not touch the named item paths.

You are NOT permitted to edit code in this run. Read-only review.

EXHAUSTIVE-PASS REQUIREMENT — load-bearing for the whole pipeline:

This review costs real money, and every NEEDS_REVISION you return triggers a full re-implementation cycle. If you find ONE issue, stop, and return NEEDS_REVISION, the implementer fixes that one issue, re-runs verify, you re-review, find a SECOND issue, return NEEDS_REVISION again — and we burn N round trips when one pass should have surfaced everything. THIS IS THE FAILURE MODE TO AVOID.

Procedure (mandatory — do NOT shortcut):

1. Read EVERY changed file end-to-end before writing any issue. Do not stop reading at the first defect.
2. Maintain a running list of every issue you encounter as you read. Do not pre-filter for severity. Capture LOW issues even if you would otherwise ignore them — the implementer might as well fix them in this pass.
3. After the file pass, do a CROSS-CUTTING pass:
   - Are there APIs/types referenced in one file that don't match the producing file?
   - Are there tests that don't exercise the actual error paths the new code introduces?
   - Are there obvious-but-missing test cases (boundary, empty, very-large, unicode, concurrent)?
   - Did the implementer add new error/state types that callers don't handle?
   - Are there dead branches the type system should catch but the diff hides under \`as any\` / \`@ts-ignore\` / \`unknown\`?
4. After cross-cutting, do a SECURITY/SUPPLY-CHAIN pass:
   - Command injection: any \`spawnSync\`, \`exec\`, \`shell: true\`, child-process call passing user-influenced args without an array form?
   - Path traversal: any file-system path built from user input without normalization/jail check?
   - Eval surfaces: \`eval\`, \`Function(...)\`, \`vm.runIn*\`, dynamic \`require\`/\`import\` of attacker-influenced specifiers?
   - Secrets in code/logs: hardcoded API keys, tokens, passwords; \`console.log\` of auth headers, env vars, or rollout payloads without going through the secrets sanitizer?
   - Prototype pollution: \`Object.assign\` / spread into untrusted objects, \`__proto__\` access?
   - Unsanitized HTML/MDX/JSON rendered to TUI without escape?
   - New npm dependencies added: do they look real (well-known publisher, recent maintenance)? Or typosquats? Are licenses compatible (MIT/Apache/ISC/BSD)?
5. After security, do a PERFORMANCE/RESOURCE-LEAK pass:
   - Sync I/O on the event loop, catastrophic regex backtracking, O(n²) loops on user data, missing pagination on disk reads?
   - File handles, child processes, AbortControllers, timers, listeners cleaned up on error?
   - Memory: are large structures bounded? Caches with eviction? Mailboxes/queues with backpressure?
6. After performance, do a SCOPE pass: did the implementer touch files outside the item's stated scope? Did they cite donor sources for items with a Donor: clause?
7. Only after all 6 passes, write the structured report. The list must contain EVERY issue you found, not just the ones that justify your verdict.

If you would rate the item APPROVED, still list any LOW-severity follow-ups you noticed — the implementer can clean them up before merge in the same pass.
If you would rate the item NEEDS_REVISION, your list MUST include every issue at every severity, not just one CRITICAL. The implementer reads your full list and fixes everything in one revision pass.

Required output format. Your FINAL line must be exactly one of:

  VERDICT: APPROVED
  VERDICT: NEEDS_REVISION
  VERDICT: BLOCKED

Before that line, write a structured report:
- 1-3 sentence summary of the diff
- "Files reviewed:" — explicit list of every changed file path you read in full. The runner WILL grep-verify this list against \`git diff main...HEAD --name-only\`; if your list omits a changed source file, the run is rejected.
- "Issues:" — numbered list, each with severity (CRITICAL / HIGH / MEDIUM / LOW), file path + line if known, and the specific change needed. Include EVERY issue you found at EVERY severity. If no issues at a severity, write "  CRITICAL: none" / etc.
  The Issues section MUST include all four severity markers exactly once even when empty, using this shape:
    CRITICAL: none
    HIGH: none
    MEDIUM: none
    LOW: none
  Replace "none" with the findings for that severity when findings exist.
- "Cross-cutting:" — issues that span multiple files or aren't tied to one location
- "Security/supply-chain:" — findings from pass 4. If no findings, write exactly:
  "Security/supply-chain: none".
- "Performance/resource-leak:" — findings from pass 5. If no findings, write exactly:
  "Performance/resource-leak: none".
- "Scope check:" — confirm whether the diff stayed inside the item's stated scope
- "Test coverage gaps:" — specific test cases that should exist but don't
- if APPROVED, the issues list may be all LOW-severity follow-ups
- if NEEDS_REVISION, the issues list contains the full set of fixes for one revision pass
- if BLOCKED, explain why the work cannot proceed without user input

Do not chat. Do not propose unrelated changes. Stick to this item, but be exhaustive within it.`;

const tmp = mkdtempSync(path.join(tmpdir(), `agenc-review-${id}-`));
const outFile = path.join(tmp, "verdict.txt");
const promptFile = path.join(tmp, "prompt.md");
writeFileSync(promptFile, reviewerInstructions, "utf8");

process.stdout.write(`\n${BOLD}━━ reviewer subagent: ${id}${RESET}\n`);
// branding-scan: allow names the reviewer CLI binary that this script invokes
process.stdout.write(`${DIM}spawning codex exec reviewer against main (this takes 30–90 seconds)...${RESET}\n`);

const reviewArgs = [
  "exec",
  "--ephemeral",
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
  "-o",
  outFile,
];
// Allowlist of acceptable reviewer models. The reviewer pass is the
// last quality gate before merge; substituting a weak model (mini /
// haiku / turbo / older variants) silently degrades the entire harness.
// branding-scan: allow allow-list contains real frontier provider model IDs
const REVIEWER_MODEL_ALLOWLIST = [
  "gpt-5.5",
  // branding-scan: allow real OpenAI codex-family model identifier
  "gpt-5.5-codex",
  "claude-opus-4-7",
  "claude-sonnet-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];
if (process.env.AGENC_REVIEW_MODEL) {
  const requested = process.env.AGENC_REVIEW_MODEL.trim();
  if (!REVIEWER_MODEL_ALLOWLIST.includes(requested)) {
    process.stderr.write(`${BOLD}${RED}✗${RESET} model ${requested} not in allowlist; reviewer requires one of [${REVIEWER_MODEL_ALLOWLIST.join(", ")}]\n`);
    process.exit(2);
  }
  reviewArgs.push("-m", requested);
}
reviewArgs.push("-");

// branding-scan: allow real binary name of the reviewer CLI
const result = spawnSync("codex", reviewArgs, {
  cwd: root,
  encoding: "utf8",
  input: reviewerInstructions,
  stdio: ["pipe", "pipe", "pipe"],
  // Reviewer transcripts can be large (full diff + reasoning + per-file
  // analysis). Default 1MB stderr buffer kills the subprocess before
  // verdict.txt is written, leading to misleading "missing VERDICT line"
  // errors. 256MB is enough for any plausible review.
  maxBuffer: 256 * 1024 * 1024,
});

if (result.status !== 0) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer subprocess failed (exit ${result.status})\n`);
  if (result.stderr) process.stderr.write(`stderr: ${result.stderr.slice(0, 2000)}\n`);
  if (result.stdout) process.stderr.write(`stdout: ${result.stdout.slice(0, 2000)}\n`);
  process.exit(1);
}

const finalMsg = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
if (!finalMsg.trim()) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer produced no output\n`);
  process.exit(1);
}

// Verdict must be the last non-empty line — prevents false positives from
// VERDICT strings quoted in evidence or example blocks earlier in the report.
const nonEmptyLines = finalMsg.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
const lastLine = nonEmptyLines[nonEmptyLines.length - 1] || "";
const verdictMatch = /^VERDICT:\s*(APPROVED|NEEDS_REVISION|BLOCKED)\s*$/.exec(lastLine);
if (!verdictMatch) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer output missing valid VERDICT as last non-empty line\n`);
  process.stderr.write(`(last line was: ${JSON.stringify(lastLine.slice(0, 200))})\n`);
  process.stderr.write(`--- reviewer output ---\n${finalMsg}\n--- end ---\n`);
  process.exit(1);
}

const verdict = verdictMatch[1];

// Structural section verification — the reviewer prompt asks for six
// passes (cross-cutting, security/supply-chain, performance/resource-leak,
// scope, test coverage) and a per-severity issue breakdown. Without
// checking that these sections actually appear, the reviewer can write
// "Security: none" implicitly by skipping the pass entirely. Require
// every section header to be present case-sensitively. For the per-pass
// findings sections, also require non-empty content (either an explicit
// "none" line or at least one bulleted/numbered item).
const REQUIRED_SECTIONS = [
  "Files reviewed:",
  "Issues:",
  "Cross-cutting:",
  "Security/supply-chain:",
  "Performance/resource-leak:",
  "Scope check:",
  "Test coverage gaps:",
];
const missingSections = REQUIRED_SECTIONS.filter((s) => !finalMsg.includes(s));
if (missingSections.length > 0) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer output missing required section header(s): ${missingSections.join(", ")}\n`);
  process.stderr.write(`Each pass in the reviewer prompt must produce a labeled section so we can verify it actually ran.\n`);
  process.stderr.write(`--- reviewer output ---\n${finalMsg}\n--- end ---\n`);
  process.exit(1);
}

// Per-severity sub-headers under "Issues:" must each appear at least
// once. Each may explicitly say "none" to indicate no findings at that
// severity, but the marker itself cannot be missing — that would mean
// the reviewer never considered that severity at all.
// Issues body capture: same fix as sectionBody — the previous regex
// required a newline after "Issues:", which made inline "Issues: none"
// parse as empty.
const REQUIRED_SEVERITIES = ["CRITICAL:", "HIGH:", "MEDIUM:", "LOW:"];
const issuesSectionMatch = /Issues:([\s\S]*?)(?:\n\s*(?:Cross-cutting:|Security\/supply-chain:|Performance\/resource-leak:|Scope check:|Test coverage gaps:|VERDICT:))/i.exec(finalMsg);
if (!issuesSectionMatch) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer output has "Issues:" header but no parseable body before the next section\n`);
  process.exit(1);
}
const issuesBody = issuesSectionMatch[1];
// Severity-marker check: the original requirement that all 4 markers
// appear individually was too strict. A reviewer that legitimately found
// no issues writes "Issues: none" or similar without listing each
// severity — that's a valid signal of "checked all severities, found
// nothing". Accept either form: (a) all 4 markers present (with "none"
// or items per severity), OR (b) the body explicitly says "none" /
// "no issues" indicating a blanket no-findings result.
const sayNoneAtAll = /\b(none|no issues|no findings)\b/i.test(issuesBody);
const missingSeverities = REQUIRED_SEVERITIES.filter((s) => {
  const severity = s.replace(/:$/, "");
  return !new RegExp(`\\b${severity}\\b\\s*[:,-]?`, "i").test(issuesBody);
});
if (missingSeverities.length > 0 && !sayNoneAtAll) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer's "Issues:" section is missing per-severity marker(s): ${missingSeverities.join(", ")}\n`);
  process.stderr.write(`Either each severity must appear (with "none" if no findings), or the body must explicitly say "none" / "no issues" to indicate a blanket no-findings result.\n`);
  process.exit(1);
}

// Security/supply-chain and Performance/resource-leak sections must each
// have substantive content — either explicit "none" or at least one
// bulleted/numbered finding. An empty body means the pass was skipped.
//
// Body capture: anything between the section header (which already ends in
// a colon) and the next terminator section header or the VERDICT line.
// Accepts both inline content ("Security/supply-chain: none") and
// multi-line bodies. The previous regex required `\s*\n` after the header,
// which made inline "none" answers parse as empty.
function sectionBody(name, terminators) {
  const re = new RegExp(`${name.replace(/[/.]/g, "\\$&")}([\\s\\S]*?)(?:\\n\\s*(?:${terminators.map((t) => t.replace(/[/.]/g, "\\$&")).join("|")}|VERDICT:))`, "i");
  const m = re.exec(finalMsg);
  return m ? m[1].trim() : "";
}
const passSections = [
  { name: "Security/supply-chain:", terminators: ["Performance/resource-leak:", "Scope check:", "Test coverage gaps:"] },
  { name: "Performance/resource-leak:", terminators: ["Scope check:", "Test coverage gaps:"] },
];
for (const { name, terminators } of passSections) {
  const body = sectionBody(name, terminators);
  const hasItem = /(^|\n)\s*[-*•\d]/.test(body);
  const sayNone =
    /\bnone\b/i.test(body) ||
    /\bno\s+(?:new\s+)?(?:findings?|issues?|npm dependencies|dependencies|shell invocation|command injection surface|leaks?|resource leaks?)\b/i.test(
      body,
    ) ||
    /\bno[\s\S]{0,80}\b(?:found|findings?|issues?|leaks?)\b/i.test(body);
  if (!hasItem && !sayNone) {
    process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer's "${name}" section is empty — must say "none" or list at least one finding.\n`);
    process.stderr.write(`An empty pass section means the reviewer did not actually perform the pass.\n`);
    process.exit(1);
  }
}

// "Files reviewed:" sanity check — verify the reviewer actually claimed to
// read the changed source files. The reviewer prompt requires a
// "Files reviewed:" section listing every file the reviewer read in full;
// here we cross-check that list against the actual diff. If a changed
// source file is missing from the review's list, the verdict is rejected
// regardless of whether it was APPROVED — we don't trust hallucinated
// coverage.
const filesReviewedSection = /Files reviewed:([\s\S]*?)(?:\n\s*(?:Issues:|Cross-cutting:|Security|Performance|Scope check:|Test coverage gaps:|VERDICT:))/i.exec(finalMsg);
if (!filesReviewedSection) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer output missing required "Files reviewed:" section\n`);
  process.stderr.write(`The reviewer prompt requires this section. Treating absence as hallucinated coverage.\n`);
  process.stderr.write(`--- reviewer output ---\n${finalMsg}\n--- end ---\n`);
  process.exit(1);
}
const filesReviewedRaw = filesReviewedSection[1];
const filesReviewedClaim = new Set(
  filesReviewedRaw
    .split("\n")
    .map((l) => l.trim().replace(/^[-*•\d.\s)]+/, "").replace(/^`|`$/g, "").trim())
    .filter((l) => l.length > 0 && !/^none$/i.test(l) && /[/.]/.test(l)),
);

const diffNamesRes = spawnSync("git", ["diff", "--name-only", "main...HEAD"], {
  cwd: root, encoding: "utf8",
});
const actualChanged = (diffNamesRes.stdout || "")
  .split("\n").map((s) => s.trim()).filter(Boolean)
  .filter((p) => /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(p))
  .filter((p) => !p.startsWith("runtime/src/agenc/upstream/"));

// Match each claim against actual changed files. A claim is acceptable
// only when it uniquely identifies one changed file. A bare basename like
// "helpers.ts" is rejected as ambiguous when more than one changed file
// shares that basename — the reviewer must give a more specific path
// suffix in that case. This prevents one "I read helpers.ts" claim from
// silently covering tools/foo/helpers.ts AND tools/bar/helpers.ts when
// the reviewer only opened one.
const ambiguousClaims = [];
const claimsCovering = new Map(); // path -> claim that covered it
for (const claim of filesReviewedClaim) {
  const matches = actualChanged.filter((p) => claim === p || p.endsWith("/" + claim) || p === claim);
  if (matches.length > 1) {
    ambiguousClaims.push({ claim, matches });
  } else if (matches.length === 1) {
    claimsCovering.set(matches[0], claim);
  }
}

if (ambiguousClaims.length > 0) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer's "Files reviewed:" list contains ${ambiguousClaims.length} ambiguous claim(s):\n`);
  for (const { claim, matches } of ambiguousClaims.slice(0, 10)) {
    process.stderr.write(`  - "${claim}" matches ${matches.length} changed files: ${matches.slice(0, 5).join(", ")}\n`);
  }
  process.stderr.write(`Each claim must uniquely identify one changed file. Use a longer path suffix (e.g. "tools/foo/helpers.ts" instead of bare "helpers.ts").\n`);
  process.exit(1);
}

const missingFromReview = actualChanged.filter((p) => !claimsCovering.has(p));

if (missingFromReview.length > 0) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer's "Files reviewed:" list is missing ${missingFromReview.length} changed source file(s):\n`);
  for (const p of missingFromReview.slice(0, 30)) process.stderr.write(`  - ${p}\n`);
  if (missingFromReview.length > 30) process.stderr.write(`  ... +${missingFromReview.length - 30} more\n`);
  process.stderr.write(`Reviewer must explicitly claim to have read every changed source file. Verdict rejected as untrusted.\n`);
  process.exit(1);
}

process.stdout.write(`\n${DIM}--- reviewer report ---${RESET}\n`);
process.stdout.write(finalMsg.trim() + "\n");
process.stdout.write(`${DIM}--- end ---${RESET}\n`);

if (verdict === "APPROVED") {
  process.stdout.write(`\n${GREEN}✓${RESET} reviewer APPROVED ${id}\n`);
  process.exit(0);
}

process.stderr.write(`\n${BOLD}${RED}✗${RESET} reviewer ${verdict} ${id}\n`);
process.stderr.write(`Address the issues above and re-run scripts/goal/complete.mjs ${id}.\n`);
process.exit(1);

function collectCrossRepoEvidence(body) {
  const repos = [];
  if (body.includes("agenc-sdk")) repos.push("agenc-sdk");
  if (body.includes("agenc-protocol")) repos.push("agenc-protocol");
  if (body.includes("agenc-plugin-kit")) repos.push("agenc-plugin-kit");
  if (repos.length === 0) return "(none)";

  return repos.map((repo) => summarizeSiblingRepo(repo)).join("\n\n");
}

function summarizeSiblingRepo(repo) {
  const siblingRoot = path.resolve(root, "..", repo);
  if (!existsSync(siblingRoot)) {
    return `- ${repo}: missing at ${siblingRoot}`;
  }

  const status = runQuiet("git", ["status", "--short", "--branch"], siblingRoot);
  const log = runQuiet(
    "git",
    ["log", "--oneline", "--decorate", "--max-count=8"],
    siblingRoot,
  );
  const examplesDir = path.join(siblingRoot, "examples");
  const exampleFiles = existsSync(examplesDir)
    ? walkFiles(examplesDir).map((file) => path.relative(siblingRoot, file))
    : [];

  return [
    `- ${repo}: ${siblingRoot}`,
    "  status:",
    indent(status || "(no status output)", "    "),
    "  recent commits:",
    indent(log || "(no git log output)", "    "),
    "  examples:",
    indent(exampleFiles.slice(0, 80).join("\n") || "(no examples found)", "    "),
  ].join("\n");
}

function runQuiet(cmd, argv, cwd) {
  const result = spawnSync(cmd, argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return (result.stderr || result.stdout || "").trim();
  }
  return result.stdout.trim();
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walkFiles(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
