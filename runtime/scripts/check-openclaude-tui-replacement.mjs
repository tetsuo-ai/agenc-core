import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(runtimeRoot, "..");
const compatibilityDir = "open" + "clau" + "de";
const compatibilityContract = `${compatibilityDir}-tui-replacement`;
const donorBrand = "Clau" + "de";
const matrixPath = join(runtimeRoot, "parity", `${compatibilityContract}.json`);
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
const donorRoot = resolve(repoRoot, matrix.sourceRoot);
const copiedRoot = join(runtimeRoot, "src/agenc/upstream");
const liveTuiRoot = join(runtimeRoot, "src/tui");

function fail(message) {
  throw new Error(`[${compatibilityContract}] ${message}`);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        out.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  visit(root);
  return out.sort();
}

function scopedFiles(root, dirs) {
  return dirs.flatMap((dir) =>
    walk(join(root, dir)).map((file) => `${dir}/${file}`),
  ).sort();
}

function assertMatrix() {
  for (const field of [
    "contractName",
    "sourceRoot",
    "targetRoot",
    "sourceCommit",
    "sourceFiles",
    "targetFiles",
    "testFiles",
    "rows",
  ]) {
    if (!(field in matrix)) fail(`matrix missing ${field}`);
  }
  for (const row of matrix.rows) {
    for (const field of [
      "id",
      "source",
      "target",
      "requiredBehaviors",
      "tests",
      "commands",
      "status",
    ]) {
      if (!(field in row)) fail(`row ${row.id ?? "(missing id)"} missing ${field}`);
    }
    if (row.status !== "required") fail(`row ${row.id} is not required`);
    if (row.tests.length === 0) fail(`row ${row.id} has no tests`);
    if (row.commands.length === 0) fail(`row ${row.id} has no commands`);
  }
}

function assertSourceSnapshot() {
  if (!existsSync(donorRoot)) fail(`source root missing: ${donorRoot}`);
  const actualCommit = git(["rev-parse", "HEAD"], donorRoot);
  if (actualCommit !== matrix.sourceCommit) {
    fail(`source commit mismatch: expected ${matrix.sourceCommit}, got ${actualCommit}`);
  }
  if (!existsSync(copiedRoot)) fail("copied source root missing");
  const dirs = [
    "src/components",
    "src/context",
    "src/hooks",
    "src/ink",
    "src/keybindings",
    "src/screens",
    "src/state",
  ];
  const sourceFiles = scopedFiles(donorRoot, dirs);
  const copiedDirs = dirs.filter(
    (dir) => dir !== "src/ink" && dir !== "src/keybindings",
  );
  const copiedFiles = scopedFiles(
    copiedRoot,
    copiedDirs.map((dir) => dir.slice("src/".length)),
  ).map((file) => `src/${file}`);
  const absorbedInkFiles = walk(join(liveTuiRoot, "ink")).map(
    (file) => `src/ink/${file}`,
  );
  const agencOnlyKeybindingFiles = new Set([
    "types.ts",
    "useKeybindings.ts",
  ]);
  const absorbedKeybindingFiles = walk(join(liveTuiRoot, "keybindings"))
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => !file.endsWith(".test.tsx"))
    .filter((file) => !agencOnlyKeybindingFiles.has(file))
    .map((file) => `src/keybindings/${file}`);
  const absorbedStateFiles = [
    ["state/AppState.tsx", "src/state/AppState.tsx"],
    ["state/AppStateStore.ts", "src/state/AppStateStore.ts"],
    ["state/store.ts", "src/state/store.ts"],
  ]
    .filter(([file]) => existsSync(join(liveTuiRoot, file)))
    .map(([, inventoryPath]) => inventoryPath);
  const absorbedContextFiles = [
    ["context/promptOverlayContext.tsx", "src/context/promptOverlayContext.tsx"],
  ]
    .filter(([file]) => existsSync(join(liveTuiRoot, file)))
    .map(([, inventoryPath]) => inventoryPath);
  const absorbedPermissionFiles = [
    [
      "components/permissions/PermissionRequest.tsx",
      "src/components/permissions/PermissionRequest.tsx",
    ],
  ]
    .filter(([file]) => existsSync(join(liveTuiRoot, file)))
    .map(([, inventoryPath]) => inventoryPath);
  const absorbedPromptInputFiles = existsSync(
    join(liveTuiRoot, "components/PromptInput"),
  )
    ? walk(join(liveTuiRoot, "components/PromptInput")).map(
        (file) => `src/components/PromptInput/${file}`,
      )
    : [];
  const absorbedMessagesFiles = [
    ["components/Messages.tsx", "src/components/Messages.tsx"],
    [
      "components/messagesOptionalModules.ts",
      "src/components/messagesOptionalModules.ts",
    ],
    [
      "components/messagesOptionalModules.test.ts",
      "src/components/messagesOptionalModules.test.ts",
    ],
    [
      "components/Messages.behavior.test.ts",
      "src/components/Messages.behavior.test.ts",
    ],
    [
      "components/messagesBriefFiltering.ts",
      "src/components/messagesBriefFiltering.ts",
    ],
  ]
    .filter(([file]) => existsSync(join(liveTuiRoot, file)))
    .map(([, inventoryPath]) => inventoryPath);
  const substitutions = new Map([
    [
      `src/components/${donorBrand}CodeHint/PluginHintMenu.tsx`,
      "src/components/AgenCCodeHint/PluginHintMenu.tsx",
    ],
    [
      `src/components/${donorBrand}InChromeOnboarding.tsx`,
      "src/components/AgenCInChromeOnboarding.tsx",
    ],
    [
      `src/components/${donorBrand}MdExternalIncludesDialog.tsx`,
      "src/components/AgenCMdExternalIncludesDialog.tsx",
    ],
    [
      `src/hooks/use${donorBrand}CodeHintRecommendation.tsx`,
      "src/hooks/useAgenCCodeHintRecommendation.tsx",
    ],
    [
      `src/hooks/usePromptsFrom${donorBrand}InChrome.tsx`,
      "src/hooks/usePromptsFromAgenCInChrome.tsx",
    ],
  ]);
  // AgenC-only additions to the copied upstream tree. Each entry must
  // record why upstream's published source omits the file and why AgenC
  // cannot. Adding a new entry here is the explicit acknowledgement that
  // the inventory has diverged on purpose.
  const agencAdditions = new Map([
    [
      "src/components/tasks/MonitorMcpDetailDialog.tsx",
      "Upstream BackgroundTasksDialog.tsx evaluates require('./MonitorMcpDetailDialog.js') under feature('MONITOR_TOOL'); upstream's published source ships the require but not the module. AgenC routes monitoring through LocalShellTask, so this file is a no-op placeholder that exposes the MonitorMcpDetailDialog name to satisfy the feature-gated require. See commit 1b55a077.",
    ],
    [
      "src/components/PromptInput/agencAiLimitsHook.ts",
      "T-06 keeps PromptInput free of donor-branded import paths by routing the rate-limit hook through this AgenC-named adapter until the underlying service is absorbed.",
    ],
    [
      "src/components/PromptInput/proactiveAdapter.ts",
      "T-06 keeps optional proactive/Kairos PromptInput behavior behind an AgenC-owned no-throw adapter because the optional upstream proactive module is absent from this runtime snapshot.",
    ],
    [
      "src/components/PromptInput/proactiveAdapter.test.ts",
      "Focused coverage for the T-06 proactive adapter fallback when the optional proactive module is absent.",
    ],
    [
      "src/components/messagesOptionalModules.ts",
      "T-07 keeps optional proactive/Kairos Messages behavior behind an AgenC-owned no-throw adapter because the optional upstream proactive and file-delivery modules are absent from this runtime snapshot.",
    ],
    [
      "src/components/messagesOptionalModules.test.ts",
      "Focused coverage for the T-07 optional module adapter fallbacks used by Messages.",
    ],
    [
      "src/components/Messages.behavior.test.ts",
      "Focused coverage for T-07 brief-mode filtering and brief-turn text dropping behavior exported by Messages.",
    ],
    [
      "src/components/messagesBriefFiltering.ts",
      "T-07 extracts Messages brief-mode filtering into a TUI-owned pure helper so behavior can be tested without mounting the full renderer component graph.",
    ],
  ]);
  const expected = sourceFiles
    .map((file) => substitutions.get(file) ?? file)
    .concat([...agencAdditions.keys()])
    .sort();
  const actualFiles = copiedFiles
    .concat(absorbedInkFiles, absorbedStateFiles, absorbedContextFiles)
    .concat(absorbedKeybindingFiles)
    .concat(absorbedPermissionFiles)
    .concat(absorbedPromptInputFiles)
    .concat(absorbedMessagesFiles)
    .sort();
  const missing = expected.filter((file) => !actualFiles.includes(file));
  const extra = actualFiles.filter((file) => !expected.includes(file));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `copied TUI inventory mismatch: missing=${missing.slice(0, 10).join(", ")} extra=${extra.slice(0, 10).join(", ")}`,
    );
  }
}

function assertOldTuiRemoved() {
  const allowed = new Set([
    "daemon-session.contract.test.ts",
    "daemon-session.ts",
    "elicitation-bridge.test.tsx",
    "elicitation-bridge.tsx",
    "elicitation-submit-routing.ts",
    "ink.ts",
    "main.tsx",
    "context/promptOverlayContext.test.tsx",
    "context/promptOverlayContext.tsx",
    "components/permissions/PermissionRequest.tsx",
    `${compatibilityDir}/App.tsx`,
    `${compatibilityDir}/message-adapter.ts`,
    `${compatibilityDir}/permission-bridge.tsx`,
    `${compatibilityDir}/session-types.ts`,
    `${compatibilityDir}/tool-stubs.tsx`,
    `${compatibilityDir}/use-session-transcript.ts`,
    `${compatibilityDir}/use-tool-jsx.ts`,
    "session-types.ts",
    "state/AppState.test.tsx",
    "state/AppState.tsx",
    "state/AppStateStore.ts",
    "state/store.ts",
    "tool-stubs-glob-view.test.tsx",
  ]);
  // Tests under the compatibility island are co-located with the live wiring
  // on purpose. Accept any *.test.ts / *.test.tsx there; the assertion below
  // still fails closed on old TUI directories like composer/, transcript,
  // and other non-absorbed surfaces.
  const compatibilityTestPattern = new RegExp(
    `^${compatibilityDir}/[^/]+\\.test\\.tsx?$`,
  );
  const isAllowedTest = (file) =>
    compatibilityTestPattern.test(file);
  const liveFiles = walk(liveTuiRoot);
  for (const file of liveFiles) {
    if (allowed.has(file)) continue;
    if (isAllowedTest(file)) continue;
    if (file.startsWith("components/PromptInput/")) continue;
    if (file === "components/Messages.tsx") continue;
    if (file === "components/messagesOptionalModules.ts") continue;
    if (file === "components/messagesOptionalModules.test.ts") continue;
    if (file === "components/Messages.behavior.test.ts") continue;
    if (file === "components/messagesBriefFiltering.ts") continue;
    if (file.startsWith("ink/")) continue;
    if (file.startsWith("keybindings/")) continue;
    fail(`unexpected live TUI file remains: ${file}`);
  }
  for (const dir of [
    "composer",
    "transcript",
    "permissions",
    "screens",
  ]) {
    if (existsSync(join(liveTuiRoot, dir))) fail(`old TUI directory remains: ${dir}`);
  }
}

function assertNoDeletedAbsorbImporters() {
  const deletedInkRoot = join(copiedRoot, "ink");
  const deletedKeybindingsRoot = join(copiedRoot, "keybindings");
  const deletedStateEntrypoints = new Map([
    [join(copiedRoot, "state/AppState"), "AppState"],
    [join(copiedRoot, "state/AppStateStore"), "AppStateStore"],
    [join(copiedRoot, "state/store"), "state store"],
  ]);
  const deletedContextEntrypoints = new Map([
    [join(copiedRoot, "context/promptOverlayContext"), "prompt overlay context"],
  ]);
  const deletedPermissionEntrypoints = new Map([
    [
      join(copiedRoot, "components/permissions/PermissionRequest"),
      "PermissionRequest component",
    ],
  ]);
  const deletedPromptInputRoot = join(copiedRoot, "components/PromptInput");
  const deletedMessagesEntrypoint = join(copiedRoot, "components/Messages");
  const sourceImportPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  for (const file of walk(copiedRoot)) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    const abs = join(copiedRoot, file);
    const content = readFileSync(abs, "utf8");
    for (const match of content.matchAll(sourceImportPattern)) {
      const specifier = match[1];
      if (specifier === "src/ink" || specifier.startsWith("src/ink/")) {
        fail(`deleted Ink alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/keybindings" ||
        specifier.startsWith("src/keybindings/")
      ) {
        fail(`deleted keybindings alias import remains: ${file} -> ${specifier}`);
      }
      if (specifier === "src/state/AppState" || specifier === "src/state/AppState.js") {
        fail(`deleted AppState alias import remains: ${file} -> ${specifier}`);
      }
      if (specifier === "src/state/AppStateStore" || specifier === "src/state/AppStateStore.js") {
        fail(`deleted AppStateStore alias import remains: ${file} -> ${specifier}`);
      }
      if (specifier === "src/state/store" || specifier === "src/state/store.js") {
        fail(`deleted state store alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/context/promptOverlayContext" ||
        specifier === "src/context/promptOverlayContext.js"
      ) {
        fail(`deleted prompt overlay context alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/components/permissions/PermissionRequest" ||
        specifier === "src/components/permissions/PermissionRequest.js"
      ) {
        fail(`deleted PermissionRequest alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/components/PromptInput" ||
        specifier.startsWith("src/components/PromptInput/")
      ) {
        fail(`deleted PromptInput alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/components/Messages" ||
        specifier === "src/components/Messages.js"
      ) {
        fail(`deleted Messages alias import remains: ${file} -> ${specifier}`);
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = resolve(dirname(abs), specifier)
        .replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, "");
      if (resolved === deletedInkRoot || resolved.startsWith(`${deletedInkRoot}/`)) {
        fail(`deleted Ink relative import remains: ${file} -> ${specifier}`);
      }
      if (
        resolved === deletedKeybindingsRoot ||
        resolved.startsWith(`${deletedKeybindingsRoot}/`)
      ) {
        fail(`deleted keybindings relative import remains: ${file} -> ${specifier}`);
      }
      for (const [deletedStateEntrypoint, label] of deletedStateEntrypoints) {
        if (resolved === deletedStateEntrypoint) {
          fail(`deleted ${label} relative import remains: ${file} -> ${specifier}`);
        }
      }
      for (const [deletedContextEntrypoint, label] of deletedContextEntrypoints) {
        if (resolved === deletedContextEntrypoint) {
          fail(`deleted ${label} relative import remains: ${file} -> ${specifier}`);
        }
      }
      for (const [deletedPermissionEntrypoint, label] of deletedPermissionEntrypoints) {
        if (resolved === deletedPermissionEntrypoint) {
          fail(`deleted ${label} relative import remains: ${file} -> ${specifier}`);
        }
      }
      if (
        resolved === deletedPromptInputRoot ||
        resolved.startsWith(`${deletedPromptInputRoot}/`)
      ) {
        fail(`deleted PromptInput relative import remains: ${file} -> ${specifier}`);
      }
      if (resolved === deletedMessagesEntrypoint) {
        fail(`deleted Messages relative import remains: ${file} -> ${specifier}`);
      }
    }
  }
}

function assertLiveWiring() {
  const main = readFileSync(join(liveTuiRoot, "main.tsx"), "utf8");
  const app = readFileSync(join(liveTuiRoot, compatibilityDir, "App.tsx"), "utf8");
  if (!main.includes("./ink.js")) {
    fail("main.tsx does not render through absorbed Ink");
  }
  if (!main.includes("AgenCTuiApp")) {
    fail("main.tsx does not mount AgenCTuiApp");
  }
  for (const forbidden of [
    "from \"./App.js\"",
    "from './App.js'",
    "tui/composer",
    "tui/transcript",
  ]) {
    if (main.includes(forbidden) || app.includes(forbidden)) {
      fail(`forbidden old TUI import remains: ${forbidden}`);
    }
  }
  for (const required of [
    "components/Messages.js",
    "components/PromptInput/PromptInput.js",
    "keybindings/KeybindingProviderSetup.js",
    "context/promptOverlayContext.js",
    "components/permissions/PermissionRequest.js",
  ]) {
    if (!app.includes(required) && !readFileSync(join(liveTuiRoot, compatibilityDir, "permission-bridge.tsx"), "utf8").includes(required)) {
      fail(`upstream live import missing: ${required}`);
    }
  }
  const allLive = walk(liveTuiRoot)
    .map((file) => readFileSync(join(liveTuiRoot, file), "utf8"))
    .join("\n");
  if (allLive.includes("⚠")) fail("forbidden warning glyph remains in live TUI");
}

function assertPackageScripts() {
  const pkg = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
  for (const script of [
    `check:${compatibilityContract}`,
    `test:${compatibilityContract}`,
    `validate:${compatibilityContract}`,
  ]) {
    if (typeof pkg.scripts?.[script] !== "string") {
      fail(`package script missing: ${script}`);
    }
  }
}

assertMatrix();
assertSourceSnapshot();
assertOldTuiRemoved();
assertNoDeletedAbsorbImporters();
assertLiveWiring();
assertPackageScripts();
console.log(`[${compatibilityContract}] contract verified`);
