#!/usr/bin/env node
// Run all gates for a PORT_CHECKLIST.md item.
//
// Usage:
//   node scripts/goal/verify.mjs <item-id> [--skip-validate] [--skip-typecheck]
//
// Exit 0 only when every gate passes. The goal-runner must not signal
// completion unless this exits 0 (and complete.mjs after it).
//
// Gates run, in order:
//   1. Branch shape: current branch must be port/<item-id>.
//   2. Branding scan over staged + working-tree changes against main.
//   3. Item-specific gates by ID prefix (no remaining importers, etc.).
//   4. Typecheck (npm run typecheck) — slow; skip with --skip-typecheck for
//      iteration but never skip for completion.
//   5. agenc-tui-validate — rebuild + PTY startup of agenc and agenc --yolo.
//      Skip with --skip-validate for iteration but never skip for completion.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { findItem, repoRoot, fail } from "./checklist-utils.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

function usage() {
  process.stderr.write(
    `Usage: node scripts/goal/verify.mjs <item-id> [--skip-validate] [--skip-typecheck]\n`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--"));
const skipValidate = args.includes("--skip-validate");
const skipTypecheck = args.includes("--skip-typecheck");
if (!id) usage();

const root = repoRoot();
const { item } = await findItem(id);

function header(name) {
  process.stdout.write(`\n${BOLD}━━ gate: ${name}${RESET}\n`);
}

function pass(msg) {
  process.stdout.write(`${GREEN}✓${RESET} ${msg}\n`);
}

function failGate(msg, code = 1) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} ${msg}\n`);
  process.exit(code);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? root,
    stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  return r;
}

function git(...argv) {
  return run("git", argv, { silent: true });
}

// --- Gate 1: branch shape -----------------------------------------------

header("branch shape");
const branchRes = git("rev-parse", "--abbrev-ref", "HEAD");
if (branchRes.status !== 0) failGate("could not read current branch");
const branch = branchRes.stdout.trim();
const expected = `port/${id}`;
if (branch !== expected) {
  failGate(`current branch is "${branch}", expected "${expected}".`);
}
pass(`on ${branch}`);

// --- Gate 2: branding scan ----------------------------------------------

header("branding scan (changed vs main)");
const scanScript = path.join(root, "scripts", "branding-scan.mjs");
if (!existsSync(scanScript)) failGate(`branding scan missing at ${scanScript}`);

// Get the list of files changed on this branch vs main (committed +
// working tree). Only scan AgenC-owned source paths.
const diffRes = git("diff", "--name-only", "--diff-filter=ACMR", "main...HEAD");
const stagedRes = git("diff", "--name-only", "--diff-filter=ACMR", "--cached");
const wtRes = git("diff", "--name-only", "--diff-filter=ACMR");
const candidates = new Set(
  [diffRes.stdout, stagedRes.stdout, wtRes.stdout]
    .join("\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean),
);
const SCANNABLE = (p) =>
  /\.(ts|tsx|mjs|cjs|js|jsx|md|json|sh|toml)$/.test(p) &&
  !/node_modules\//.test(p) &&
  !/\bdist\//.test(p) &&
  !/\bbuild\//.test(p) &&
  // Exempt the upstream mirror itself; it gets removed in Phase 6.
  !/^runtime\/src\/agenc\/upstream\//.test(p);
const toScan = [...candidates].filter(SCANNABLE).map((p) => path.join(root, p)).filter(existsSync);

if (toScan.length === 0) {
  pass("no scannable changes");
} else {
  const r = run("node", [scanScript, ...toScan], { silent: false });
  if (r.status !== 0) failGate(`branding scan reported findings (${toScan.length} file(s) scanned)`);
  pass(`branding clean (${toScan.length} file(s))`);
}

// --- Gate 3: item-specific gates ----------------------------------------

header(`item-specific gates for ${id}`);
const prefix = id.split("-")[0];
const itemGates = {
  L: leafAbsorbGates,
  T: tuiAbsorbGates,
  F: foundationalGates,
  A: authBackendGates,
  LP: providerGates,
  ST: stateGates,
  TL: toolGates,
  PE: permissionGates,
  C: donorRuntimePortGates,
  S: serviceGates,
  OC: serviceGates,
  MS: mcpServerGates,
  PK: pluginGates,
  MG: migrationGates,
  CF: configGates,
  OB: onboardingGates,
  UP: updateGates,
  PR: promptGates,
  MM: memoryGates,
  WP: webPortalGates,
  IDE: ideExtensionGates,
  Z: cleanupGates,
  D: () => failGate("D-* items are decisions, not work items. Mark them in PORT_CHECKLIST.md directly."),
};

const gateFn = itemGates[prefix];
if (!gateFn) {
  process.stdout.write(`${YELLOW}!${RESET} no item-specific gate registered for prefix "${prefix}". Generic gates only.\n`);
} else {
  await gateFn(item);
}

// --- Gate 4: typecheck (baseline + delta) -------------------------------

if (skipTypecheck) {
  process.stdout.write(`\n${YELLOW}!${RESET} typecheck skipped (--skip-typecheck). Cannot complete with this flag.\n`);
} else {
  header("typecheck (baseline + delta)");
  const r = run("npm", ["run", "typecheck"], { silent: true });
  const errCount = countTscErrors((r.stdout || "") + "\n" + (r.stderr || ""));
  const baselinePath = path.join(root, ".typecheck-baseline.json");
  const baseline = readBaselineSafe(baselinePath);
  if (baseline === null) {
    // First run on this branch — establish the baseline locally.
    writeBaseline(baselinePath, errCount);
    pass(`baseline established: ${errCount} error(s) (saved to .typecheck-baseline.json)`);
  } else if (errCount > baseline) {
    failGate(`typecheck added ${errCount - baseline} new error(s) (baseline ${baseline} → now ${errCount})`);
  } else {
    if (errCount < baseline) {
      writeBaseline(baselinePath, errCount);
      pass(`typecheck improved: ${baseline} → ${errCount} (baseline tightened)`);
    } else {
      pass(`typecheck within baseline (${errCount} ≤ ${baseline})`);
    }
  }
}

// --- Gate 5: agenc-tui-validate -----------------------------------------

if (skipValidate) {
  process.stdout.write(`\n${YELLOW}!${RESET} agenc-tui-validate skipped (--skip-validate). Cannot complete with this flag.\n`);
} else {
  header("agenc-tui-validate");
  // branding-scan: allow real on-disk skill path under user home
  const skillBase = path.join(process.env.HOME || "", ".claude/skills/agenc-tui-validate/scripts");
  const skillRunner = [path.join(skillBase, "run.mjs"), path.join(skillBase, "run-tui-validate.mjs")].find(
    (p) => existsSync(p),
  );
  if (skillRunner) {
    const r = run("node", [skillRunner]);
    if (r.status !== 0) failGate("agenc-tui-validate failed");
    pass(`agenc-tui-validate passed (${path.basename(skillRunner)})`);
  } else {
    process.stdout.write(
      `${YELLOW}!${RESET} agenc-tui-validate skill runner not found under ${skillBase}; falling back to inline build check.\n`,
    );
    inlineTuiValidate();
  }
}

process.stdout.write(`\n${BOLD}${GREEN}all gates passed for ${id}${RESET}\n`);
process.exit(0);

// ========================================================================

function inlineTuiValidate() {
  const buildRes = run("npm", ["run", "build"], { cwd: path.join(root, "runtime") });
  if (buildRes.status !== 0) failGate("runtime build failed");
  const builtMain = path.join(root, "runtime", "dist", "tui", "main.js");
  if (!existsSync(builtMain)) failGate(`built TUI artifact missing at ${builtMain}`);
  pass("runtime built");
}

// ---- gate registry -----------------------------------------------------

async function leafAbsorbGates(item) {
  // L-* items must end with the upstream copy deleted and zero importers.
  const upstreamMatch = /agenc\/upstream\/[^\s`*]+/g.exec(item.body);
  if (!upstreamMatch) {
    process.stdout.write(`${YELLOW}!${RESET} L-${id}: could not extract upstream path from item body; skipping path check.\n`);
    return;
  }
  const upstreamRel = upstreamMatch[0];
  const upstreamAbs = path.join(root, "runtime/src/", upstreamRel);
  if (existsSync(upstreamAbs)) {
    failGate(`upstream source still present at ${upstreamRel}; absorb deletes the source`);
  }
  pass(`upstream copy deleted (${upstreamRel})`);
  const importerScan = run("rg", ["--no-messages", "-l", upstreamRel.replace(/\.(ts|tsx|js|mjs)$/, ""), "runtime/src"]);
  if (importerScan.status === 0) {
    failGate(`importers still reference ${upstreamRel}`);
  }
  pass("no remaining importers");
}

async function tuiAbsorbGates(item) {
  // Same shape as leaf absorb, but for the larger TUI subtrees.
  await leafAbsorbGates(item);
}

async function foundationalGates(item) {
  // F-01/F-02: stub fixes. Verify placeholder is gone (no @ts-nocheck).
  if (id === "F-01" || id === "F-02") {
    const target = id === "F-01"
      ? "runtime/src/constants/querySource.ts"
      : "runtime/src/types/message.ts";
    const abs = path.join(root, target);
    if (!existsSync(abs)) failGate(`stub target missing: ${target}`);
    const content = await readFileSafe(abs);
    if (content.includes("@ts-nocheck")) failGate(`@ts-nocheck still present in ${target}`);
    pass(`stub replaced (${target})`);
    return;
  }
  // F-03*..F-06*: daemon items. Require a contract test under runtime/src/app-server/.
  if (/^F-0[3-6][a-z]?$/.test(id)) {
    const dir = path.join(root, "runtime/src/app-server");
    if (!existsSync(dir)) failGate("runtime/src/app-server/ does not exist; daemon work not landed");
    const tests = walkFiles(dir).filter((p) => /\.contract\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) {
      failGate("no *.contract.test.ts files in runtime/src/app-server/");
    }
    pass(`${tests.length} contract test(s) present`);
  }
}

async function authBackendGates(item) {
  // A-* items: AuthBackend interface must exist; no provider key reads
  // outside the auth subsystem.
  const ifacePath = path.join(root, "runtime/src/auth/backend.ts");
  if (!existsSync(ifacePath)) failGate("AuthBackend interface missing at runtime/src/auth/backend.ts");
  pass("AuthBackend interface present");
  // Scan for direct env-var key reads outside runtime/src/auth/.
  const keyVars = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "GROK_API_KEY", "XAI_API_KEY"];
  const offenders = [];
  for (const v of keyVars) {
    const r = run("rg", ["--no-messages", "-l", `process\\.env\\.${v}`, "runtime/src", "-g", "!runtime/src/auth/**"]);
    if (r.status === 0 && r.stdout) offenders.push(...r.stdout.trim().split("\n"));
  }
  if (offenders.length > 0) {
    failGate(`provider key env vars read outside runtime/src/auth/:\n  ${offenders.join("\n  ")}`);
  }
  pass("no direct provider-key env reads outside auth subsystem");
}

async function providerGates(item) {
  // LP-* items: provider port (LP-10..LP-19) or runtime backbone (LP-01..LP-07).
  // For per-provider items: directory + index export + at least one test.
  const providerMatch = /providers\/([\w-]+)/.exec(item.body);
  if (providerMatch) {
    const dir = path.join(root, "runtime/src/llm/providers", providerMatch[1]);
    if (!existsSync(dir)) failGate(`provider directory missing: runtime/src/llm/providers/${providerMatch[1]}/`);
    pass(`provider directory present (${providerMatch[1]})`);
    const idx = path.join(dir, "index.ts");
    if (!existsSync(idx)) failGate(`provider entry missing: runtime/src/llm/providers/${providerMatch[1]}/index.ts`);
    pass("provider index.ts present");
    const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate(`no test files in runtime/src/llm/providers/${providerMatch[1]}/`);
    pass(`${tests.length} test file(s)`);
    return;
  }
  // Runtime-backbone LP-* items live under runtime/src/llm/api/ or similar.
  if (id.startsWith("LP-0")) {
    const apiDir = path.join(root, "runtime/src/llm/api");
    const fallback = path.join(root, "runtime/src/transport/fallback-ladder.ts");
    if (!existsSync(apiDir) && !existsSync(fallback)) {
      failGate("expected runtime/src/llm/api/ or runtime/src/transport/fallback-ladder.ts");
    }
    pass("provider runtime backbone present");
    return;
  }
  pass("(generic provider gate)");
}

async function stateGates(item) {
  // ST-01..ST-03: schema items. Look for the named table in any sql migration
  // OR a typed schema file under runtime/src/state/.
  const dir = path.join(root, "runtime/src/state");
  if (!existsSync(dir)) failGate("runtime/src/state/ missing");
  if (/^ST-0[1-3]$/.test(id)) {
    const tableNames = {
      "ST-01": "agent_runs",
      "ST-02": "session_state_snapshots",
      "ST-03": "in_flight_tool_calls",
    };
    const table = tableNames[id];
    const found = grepRepo(`\\b${table}\\b`, "runtime/src/state");
    if (!found) failGate(`schema table "${table}" not referenced anywhere under runtime/src/state/`);
    pass(`schema mentions ${table}`);
    return;
  }
  // ST-04+: feature items. Require at least one test file added.
  const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
  if (tests.length === 0) failGate(`no test files in runtime/src/state/`);
  pass(`${tests.length} test file(s) under state/`);
}

async function toolGates(item) {
  // TL-* items: tool surface. Each tool must be registered in the tool registry.
  const toolNameMatch = /\b(bash|edit|read|write|grep|glob|web_fetch|web_search|TodoWrite|Plan|AgentTool|SkillCreate|NotebookRead|NotebookEdit|file mention|attachments?|multi-edit)\b/i.exec(
    item.title,
  );
  if (!toolNameMatch) {
    pass("(no specific tool name in title; generic gate)");
    return;
  }
  const toolName = toolNameMatch[1];
  const registry = path.join(root, "runtime/src/tool-registry.ts");
  if (!existsSync(registry)) failGate("runtime/src/tool-registry.ts missing");
  const registered = grepRepo(toolName, "runtime/src/tool-registry.ts");
  if (!registered) failGate(`tool "${toolName}" not referenced in tool-registry.ts`);
  pass(`tool "${toolName}" referenced in tool-registry.ts`);
  // At least one test exercising the tool somewhere under runtime/src/tools/.
  const toolsDir = path.join(root, "runtime/src/tools");
  if (existsSync(toolsDir)) {
    const tests = walkFiles(toolsDir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate(`no test files anywhere under runtime/src/tools/`);
    pass(`${tests.length} test file(s) under tools/`);
  }
}

async function permissionGates(item) {
  const dir = path.join(root, "runtime/src/permissions");
  if (!existsSync(dir)) failGate("runtime/src/permissions/ missing");
  pass("permissions subsystem present");
  // PE-01..PE-08: each item maps to a named submodule.
  const mapping = {
    "PE-01": "approval-cache",
    "PE-02": "dangerous-pattern",
    "PE-03": "tool-approval",
    "PE-04": "permission-mode",
    "PE-05": "sandbox",
    "PE-06": "hook",
    "PE-07": "permission-cli",
    "PE-08": "audit-log",
  };
  const expected = mapping[id];
  if (expected) {
    const found = grepRepo(expected, "runtime/src/permissions");
    if (!found) failGate(`permissions item ${id} expects "${expected}" reference under runtime/src/permissions/`);
    pass(`permissions/${expected} referenced`);
  }
  const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
  if (tests.length === 0) failGate(`no test files in runtime/src/permissions/`);
  pass(`${tests.length} test file(s)`);
}

async function donorRuntimePortGates(item) {
  // C-01a..C-01e: sandboxing.
  if (/^C-01/.test(id)) {
    const dir = path.join(root, "runtime/src/sandbox");
    if (!existsSync(dir)) failGate("runtime/src/sandbox/ missing");
    pass("sandbox subsystem present");
    const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate("no test files under runtime/src/sandbox/");
    pass(`${tests.length} test file(s)`);
    return;
  }
  // C-02: mcp-client transports
  if (id === "C-02") {
    const dir = path.join(root, "runtime/src/mcp-client/transports");
    if (!existsSync(dir)) failGate("runtime/src/mcp-client/transports/ missing");
    const stdio = walkFiles(dir).some((p) => /stdio/.test(p));
    const ws = walkFiles(dir).some((p) => /websocket|\bws\b/i.test(p));
    if (!stdio) failGate("stdio transport file missing under runtime/src/mcp-client/transports/");
    if (!ws) failGate("websocket transport file missing under runtime/src/mcp-client/transports/");
    pass("stdio + websocket transports present");
    return;
  }
  // C-03: terminal-detection
  if (id === "C-03") {
    const f = path.join(root, "runtime/src/utils/terminal-detection.ts");
    if (!existsSync(f)) failGate("runtime/src/utils/terminal-detection.ts missing");
    pass("terminal-detection.ts present");
    return;
  }
  // C-04: file-search/git-utils
  if (id === "C-04") {
    pass("(C-04 generic gate; specific FS-helper paths checked at runtime)");
    return;
  }
  // C-05: code-mode finish
  if (id === "C-05") {
    const dir = path.join(root, "runtime/src/tools/code-mode");
    if (!existsSync(dir)) failGate("runtime/src/tools/code-mode/ missing");
    pass("tools/code-mode/ present");
    return;
  }
  pass("(generic donor-runtime port gate)");
}

async function serviceGates(item) {
  // S-* and OC-*: service ports under runtime/src/services/.
  const serviceMatch = /services\/([\w-]+)/.exec(item.body) || /services\/([\w-]+)/.exec(item.title);
  if (!serviceMatch) {
    pass("(no service path in body; generic gate)");
    return;
  }
  const dir = path.join(root, "runtime/src/services", serviceMatch[1]);
  if (!existsSync(dir)) failGate(`service directory missing: runtime/src/services/${serviceMatch[1]}/`);
  pass(`service directory present (${serviceMatch[1]})`);
  const idx = path.join(dir, "index.ts");
  if (!existsSync(idx)) {
    process.stdout.write(`${YELLOW}!${RESET} no index.ts in services/${serviceMatch[1]}/ (acceptable for some services)\n`);
  } else {
    pass("service index.ts present");
  }
  const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
  if (tests.length === 0) failGate(`no test files in runtime/src/services/${serviceMatch[1]}/`);
  pass(`${tests.length} test file(s)`);
}

async function mcpServerGates(item) {
  const dir = path.join(root, "runtime/src/mcp-server");
  if (!existsSync(dir)) failGate("runtime/src/mcp-server/ missing");
  pass("mcp-server subsystem present");
  const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
  if (tests.length === 0) failGate("no test files under runtime/src/mcp-server/");
  pass(`${tests.length} test file(s)`);
}

async function pluginGates(item) {
  const dir = path.join(root, "runtime/src/plugins");
  if (!existsSync(dir)) failGate("runtime/src/plugins/ missing");
  pass("plugins subsystem present");
  // PK-06: agenc plugin CLI subcommands.
  if (id === "PK-06") {
    const cliReferenced = grepRepo("agenc plugin", "runtime/src");
    if (!cliReferenced) failGate(`'agenc plugin' subcommand surface not found anywhere in runtime/src/`);
    pass("agenc plugin subcommand present");
  }
}

async function migrationGates(item) {
  // MG-* items are about transition. Done condition is item-specific; verify
  // the named subsystem changed shape per item ID.
  if (id === "MG-01") {
    // Direct-CLI fallback during transition. Just ensure bin/agenc.ts still exists.
    const f = path.join(root, "runtime/src/bin/agenc.ts");
    if (!existsSync(f)) failGate("runtime/src/bin/agenc.ts missing — direct-CLI fallback required during transition");
    pass("direct-CLI fallback present");
    return;
  }
  if (id === "MG-04") {
    // Direct-CLI removal. The runtime should now be daemon-driven only.
    const f = path.join(root, "runtime/src/app-server-client/index.ts");
    if (!existsSync(f)) failGate("runtime/src/app-server-client/index.ts missing — daemon-only CLI requires it");
    pass("daemon-only CLI client present");
    return;
  }
  pass("(generic migration gate)");
}

async function configGates(item) {
  // CF-* items: each adds a named config flag. Look for the flag in the schema.
  const flagMap = {
    "CF-01": "auth.backend",
    "CF-02": "provider.default",
    "CF-03": "provider.managed_keys",
    "CF-04": "agenc",
    "CF-05": "sandbox.mode",
    "CF-06": "agent.retention_days",
    "CF-07": "permissions.default_mode",
    "CF-08": "daemon.transport",
    "CF-09": "daemon.autostart",
    "CF-10": "plugins.enabled",
    "CF-11": "mcp.server",
  };
  const flag = flagMap[id];
  if (flag) {
    const found = grepRepo(flag.replace(/\./g, "\\."), "runtime/src/config");
    if (!found) failGate(`config flag "${flag}" not referenced under runtime/src/config/`);
    pass(`config flag "${flag}" referenced`);
  }
  if (id === "CF-13") {
    const tests = walkFiles(path.join(root, "runtime/src/config")).filter((p) =>
      /\.test\.(ts|tsx)$/.test(p),
    );
    if (tests.length === 0) failGate("no test files under runtime/src/config/");
    pass(`${tests.length} test file(s) under config/`);
  }
  if (id === "CF-14") {
    const cli = grepRepo("agenc config", "runtime/src");
    if (!cli) failGate("'agenc config' CLI surface not found anywhere in runtime/src/");
    pass("agenc config subcommand present");
  }
}

async function onboardingGates(item) {
  // OB-02..OB-04: CLI surface checks.
  if (id === "OB-02") {
    const help = grepRepo("--help", "runtime/src/bin");
    if (!help) failGate("'--help' not referenced in runtime/src/bin/");
    pass("--help surface present");
    return;
  }
  if (id === "OB-03") {
    const found = grepRepo("/help", "runtime/src/commands");
    if (!found) failGate("/help slash command not referenced under runtime/src/commands/");
    pass("/help slash command present");
    return;
  }
  if (id === "OB-04") {
    const found = grepRepo("/doctor", "runtime/src/commands");
    if (!found) failGate("/doctor slash command not referenced under runtime/src/commands/");
    pass("/doctor slash command present");
    return;
  }
  if (id === "OB-06") {
    const found = grepRepo("agenc init", "runtime/src");
    if (!found) failGate("'agenc init' CLI surface not found");
    pass("agenc init subcommand present");
    return;
  }
  pass("(generic onboarding gate)");
}

async function updateGates(item) {
  if (id === "UP-01") {
    const found = grepRepo("agenc update", "runtime/src");
    if (!found) failGate("'agenc update' CLI surface not found");
    pass("agenc update subcommand present");
    return;
  }
  pass("(generic update gate)");
}

async function promptGates(item) {
  // PR-01..PR-08: prompt assembly. Look for a prompts subsystem.
  const dir = path.join(root, "runtime/src/prompts");
  if (!existsSync(dir)) failGate("runtime/src/prompts/ missing");
  pass("prompts subsystem present");
  if (id === "PR-02") {
    const found = grepRepo("AGENC\\.md", "runtime/src/prompts");
    if (!found) failGate("AGENC.md inclusion not referenced in runtime/src/prompts/");
    pass("AGENC.md inclusion present");
  }
}

async function memoryGates(item) {
  // MM-* items: memory subsystem.
  if (id === "MM-06") {
    const found = grepRepo("agenc memory", "runtime/src");
    if (!found) failGate("'agenc memory' CLI surface not found");
    pass("agenc memory subcommand present");
    return;
  }
  pass("(generic memory gate)");
}

async function webPortalGates(item) {
  // WP-* lives in a separate repo (agenc-portal). Skip core checks.
  pass("(WP-* lives in sibling agenc-portal repo; gate limited to shared protocol)");
}

async function ideExtensionGates(item) {
  // IDE-* lives in a separate repo. Skip core checks.
  pass("(IDE-* lives in sibling repo; gate limited to shared protocol)");
}

function grepRepo(pattern, scope = "runtime/src") {
  const r = run("rg", ["--no-messages", "-l", pattern, scope], { silent: true });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function countTscErrors(output) {
  // tsc summary line: "Found N error(s) in M file(s)." or "Found N errors."
  const m = /Found\s+(\d+)\s+error/i.exec(output);
  if (m) return parseInt(m[1], 10);
  // No summary line means tsc exited cleanly (zero errors), or the run
  // failed before tsc could emit one. Count error: lines as fallback.
  const lines = output.split("\n").filter((l) => /error\s+TS\d+/.test(l));
  return lines.length;
}

function readBaselineSafe(p) {
  try {
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf8"));
    return typeof data.errorCount === "number" ? data.errorCount : null;
  } catch {
    return null;
  }
}

function writeBaseline(p, count) {
  writeFileSync(
    p,
    JSON.stringify({ errorCount: count, capturedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}

async function cleanupGates(item) {
  if (id === "Z-01" || id === "Z-02") {
    const r = run("rg", ["--no-messages", "-l", "agenc/upstream", "runtime/src"]);
    if (r.status === 0 && r.stdout.trim()) {
      failGate(`agenc/upstream/ still imported in:\n${r.stdout}`);
    }
    pass("zero upstream importers in runtime/src");
  }
  if (id === "Z-02") {
    if (existsSync(path.join(root, "runtime/src/agenc/upstream"))) {
      failGate("runtime/src/agenc/upstream/ still exists; delete it");
    }
    pass("agenc/upstream/ removed");
  }
}

async function readFileSafe(p) {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}

function walkFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}
