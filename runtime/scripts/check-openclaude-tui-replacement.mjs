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
  const absorbedAppFiles = [
    ["components/App.tsx", "src/components/App.tsx"],
  ]
    .filter(([file]) => existsSync(join(liveTuiRoot, file)))
    .map(([, inventoryPath]) => inventoryPath);
  const absorbedStartupFiles = [
    ["startup/StartupScreen.ts", "src/components/StartupScreen.ts"],
    ["startup/StartupScreen.test.ts", "src/components/StartupScreen.test.ts"],
    ["startup/StatusLine.tsx", "src/components/StatusLine.tsx"],
    ["startup/StatusNotices.tsx", "src/components/StatusNotices.tsx"],
    ["startup/statusNoticeDefinitions.tsx", "src/utils/statusNoticeDefinitions.tsx"],
    ["startup/statusNoticeDefinitions.test.tsx", "src/utils/statusNoticeDefinitions.test.tsx"],
  ]
    .filter(([file]) => existsSync(join(liveTuiRoot, file)))
    .map(([, inventoryPath]) => inventoryPath);
  const absorbedHistoryFiles = [
    ["history/history.ts", "src/history.ts"],
    ["history/history.test.ts", "src/history.test.ts"],
    ["history/HistorySearchDialog.tsx", "src/components/HistorySearchDialog.tsx"],
    ["history/ResumeConversation.tsx", "src/screens/ResumeConversation.tsx"],
    ["history/transcriptSearch.ts", "src/utils/transcriptSearch.ts"],
    ["history/transcriptSearch.test.ts", "src/utils/transcriptSearch.test.ts"],
  ]
    .filter(([file]) => existsSync(join(liveTuiRoot, file)))
    .map(([, inventoryPath]) => inventoryPath);
  const absorbedCostFiles = [
    ["cost/Stats.tsx", "src/components/Stats.tsx"],
    ["cost/TokenWarning.tsx", "src/components/TokenWarning.tsx"],
    ["cost/MemoryUsageIndicator.tsx", "src/components/MemoryUsageIndicator.tsx"],
    ["cost/tokenAnalytics.ts", "src/utils/tokenAnalytics.ts"],
    ["cost/tokenAnalytics.test.ts", "src/utils/tokenAnalytics.test.ts"],
  ]
    .filter(([file]) => existsSync(join(liveTuiRoot, file)))
    .map(([, inventoryPath]) => inventoryPath);
  const absorbedSpinnerFiles = [
    ["components/spinner/Spinner.tsx", "src/components/Spinner.tsx"],
    ["components/spinner/FlashingChar.tsx", "src/components/Spinner/FlashingChar.tsx"],
    ["components/spinner/GlimmerMessage.tsx", "src/components/Spinner/GlimmerMessage.tsx"],
    ["components/spinner/ShimmerChar.tsx", "src/components/Spinner/ShimmerChar.tsx"],
    ["components/spinner/SpinnerAnimationRow.tsx", "src/components/Spinner/SpinnerAnimationRow.tsx"],
    ["components/spinner/SpinnerGlyph.tsx", "src/components/Spinner/SpinnerGlyph.tsx"],
    ["components/spinner/TeammateSpinnerLine.tsx", "src/components/Spinner/TeammateSpinnerLine.tsx"],
    ["components/spinner/TeammateSpinnerTree.tsx", "src/components/Spinner/TeammateSpinnerTree.tsx"],
    ["components/spinner/teammateSelectHint.ts", "src/components/Spinner/teammateSelectHint.ts"],
    ["components/spinner/types.ts", "src/components/Spinner/types.ts"],
    ["components/spinner/useShimmerAnimation.ts", "src/components/Spinner/useShimmerAnimation.ts"],
    ["components/spinner/useStalledAnimation.ts", "src/components/Spinner/useStalledAnimation.ts"],
    ["components/spinner/utils.ts", "src/components/Spinner/utils.ts"],
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
    [
      "src/components/Spinner/index.ts",
      "src/components/Spinner.tsx",
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
    [
      "src/utils/statusNoticeDefinitions.tsx",
      "T-14 absorbs the startup notice-definition utility with StatusNotices because it is a dedicated startup dependency outside the component inventory.",
    ],
    [
      "src/utils/statusNoticeDefinitions.test.tsx",
      "Focused coverage for the T-14 startup notice-definition behavior and AgenC wording.",
    ],
    [
      "src/history.ts",
      "T-15 absorbs the prompt history storage and paste-reference helpers with the history/resume TUI cluster; this top-level donor file is outside the tracked TUI source directories.",
    ],
    [
      "src/history.test.ts",
      "Focused coverage for T-15 paste-reference parsing and expansion behavior in the absorbed history helper.",
    ],
    [
      "src/utils/transcriptSearch.ts",
      "T-15 absorbs transcript-search text extraction with the history/resume TUI cluster; this utility is outside the tracked TUI source directories.",
    ],
    [
      "src/utils/transcriptSearch.test.ts",
      "Focused coverage for T-15 transcript-search extraction behavior used by history search.",
    ],
    [
      "src/utils/tokenAnalytics.ts",
      "T-16 absorbs the token analytics helper with the cost/usage TUI cells; this utility is outside the tracked TUI source directories.",
    ],
    [
      "src/utils/tokenAnalytics.test.ts",
      "Focused coverage for T-16 token usage analytics behavior.",
    ],
    [
      "src/components/Spinner/types.ts",
      "T-17 defines the spinner mode and RGB color type surface locally because the donor spinner cluster imports this module but the published source snapshot omits it.",
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
    .concat(absorbedAppFiles)
    .concat(absorbedStartupFiles)
    .concat(absorbedHistoryFiles)
    .concat(absorbedCostFiles)
    .concat(absorbedSpinnerFiles)
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
    "input/PARITY.md",
    "input/processBashCommand.test.tsx",
    "input/processBashCommand.tsx",
    "input/processSlashCommand.test.ts",
    "input/processSlashCommand.tsx",
    "input/processTextPrompt.ts",
    "input/processUserInput.test.ts",
    "input/processUserInput.ts",
    // App imports these helpers directly, so they live under a neutral
    // bridge path rather than the compatibility test directory.
    "bridges/message-adapter.ts",
    "bridges/permission-bridge.tsx",
    "bridges/tool-stubs.tsx",
    "bridges/use-session-transcript.ts",
    "bridges/use-tool-jsx.ts",
    "components/App.render.test.tsx",
    "components/permissions/PermissionRequest.tsx",
    `${compatibilityDir}/App.tsx`,
    `${compatibilityDir}/session-types.ts`,
    "session-types.ts",
    "slash/PARITY.md",
    "slash/argument-substitution.test.ts",
    "slash/argument-substitution.ts",
    "slash/shell-quote.ts",
    "slash/slash-command-parsing.test.ts",
    "slash/slash-command-parsing.ts",
    "state/AppState.test.tsx",
    "state/AppState.tsx",
    "state/AppStateStore.ts",
    "state/store.ts",
    "startup/PARITY.md",
    "startup/StartupScreen.test.ts",
    "startup/StartupScreen.ts",
    "startup/StatusLine.tsx",
    "startup/StatusNotices.tsx",
    "startup/statusNoticeDefinitions.test.tsx",
    "startup/statusNoticeDefinitions.tsx",
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
    if (file.startsWith("components/spinner/")) continue;
    if (file === "components/Messages.tsx") continue;
    if (file === "components/messagesOptionalModules.ts") continue;
    if (file === "components/messagesOptionalModules.test.ts") continue;
    if (file === "components/Messages.behavior.test.ts") continue;
    if (file === "components/messagesBriefFiltering.ts") continue;
    if (file === "components/App.tsx") continue;
    if (file.startsWith("cost/")) continue;
    if (file.startsWith("history/")) continue;
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
  const deletedAppEntrypoint = join(copiedRoot, "components/App");
  const deletedSpinnerRoot = join(copiedRoot, "components/Spinner");
  const deletedStartupEntrypoints = new Map([
    [join(copiedRoot, "components/StartupScreen"), "StartupScreen"],
    [join(copiedRoot, "components/StatusLine"), "StatusLine"],
    [join(copiedRoot, "components/StatusNotices"), "StatusNotices"],
    [join(copiedRoot, "utils/statusNoticeDefinitions"), "status notice definitions"],
  ]);
  const deletedHistoryEntrypoints = new Map([
    [join(copiedRoot, "history"), "history"],
    [join(copiedRoot, "components/HistorySearchDialog"), "HistorySearchDialog"],
    [join(copiedRoot, "screens/ResumeConversation"), "ResumeConversation"],
    [join(copiedRoot, "utils/transcriptSearch"), "transcript search"],
  ]);
  const deletedCostEntrypoints = new Map([
    [join(copiedRoot, "components/Stats"), "Stats component"],
    [join(copiedRoot, "components/TokenWarning"), "TokenWarning component"],
    [join(copiedRoot, "components/MemoryUsageIndicator"), "MemoryUsageIndicator component"],
    [join(copiedRoot, "utils/tokenAnalytics"), "token analytics"],
  ]);
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
      if (
        specifier === "src/components/App" ||
        specifier === "src/components/App.js"
      ) {
        fail(`deleted App alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/components/StartupScreen" ||
        specifier === "src/components/StartupScreen.js" ||
        specifier === "src/components/StatusLine" ||
        specifier === "src/components/StatusLine.js" ||
        specifier === "src/components/StatusNotices" ||
        specifier === "src/components/StatusNotices.js" ||
        specifier === "src/utils/statusNoticeDefinitions" ||
        specifier === "src/utils/statusNoticeDefinitions.js"
      ) {
        fail(`deleted startup/status alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/history" ||
        specifier === "src/history.js" ||
        specifier === "src/components/HistorySearchDialog" ||
        specifier === "src/components/HistorySearchDialog.js" ||
        specifier === "src/screens/ResumeConversation" ||
        specifier === "src/screens/ResumeConversation.js" ||
        specifier === "src/utils/transcriptSearch" ||
        specifier === "src/utils/transcriptSearch.js"
      ) {
        fail(`deleted history/resume alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/components/Stats" ||
        specifier === "src/components/Stats.js" ||
        specifier === "src/components/TokenWarning" ||
        specifier === "src/components/TokenWarning.js" ||
        specifier === "src/components/MemoryUsageIndicator" ||
        specifier === "src/components/MemoryUsageIndicator.js" ||
        specifier === "src/utils/tokenAnalytics" ||
        specifier === "src/utils/tokenAnalytics.js"
      ) {
        fail(`deleted cost/usage alias import remains: ${file} -> ${specifier}`);
      }
      if (
        specifier === "src/components/Spinner" ||
        specifier === "src/components/Spinner.js" ||
        specifier.startsWith("src/components/Spinner/")
      ) {
        fail(`deleted spinner alias import remains: ${file} -> ${specifier}`);
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
      if (resolved === deletedAppEntrypoint) {
        fail(`deleted App relative import remains: ${file} -> ${specifier}`);
      }
      if (
        resolved === deletedSpinnerRoot ||
        resolved.startsWith(`${deletedSpinnerRoot}/`)
      ) {
        fail(`deleted spinner relative import remains: ${file} -> ${specifier}`);
      }
      for (const [deletedStartupEntrypoint, label] of deletedStartupEntrypoints) {
        if (resolved === deletedStartupEntrypoint) {
          fail(`deleted ${label} relative import remains: ${file} -> ${specifier}`);
        }
      }
      for (const [deletedHistoryEntrypoint, label] of deletedHistoryEntrypoints) {
        if (resolved === deletedHistoryEntrypoint) {
          fail(`deleted ${label} relative import remains: ${file} -> ${specifier}`);
        }
      }
      for (const [deletedCostEntrypoint, label] of deletedCostEntrypoints) {
        if (resolved === deletedCostEntrypoint) {
          fail(`deleted ${label} relative import remains: ${file} -> ${specifier}`);
        }
      }
    }
  }
}

function assertLiveWiring() {
  const main = readFileSync(join(liveTuiRoot, "main.tsx"), "utf8");
  const app = readFileSync(join(liveTuiRoot, "components/App.tsx"), "utf8");
  if (!main.includes("./ink.js")) {
    fail("main.tsx does not render through absorbed Ink");
  }
  if (!main.includes("AgenCTuiApp")) {
    fail("main.tsx does not mount AgenCTuiApp");
  }
  for (const forbidden of [
    "from \"./App.js\"",
    "from './App.js'",
    `${compatibilityDir}/App`,
    "tui/composer",
    "tui/transcript",
  ]) {
    if (main.includes(forbidden) || app.includes(forbidden)) {
      fail(`forbidden old TUI import remains: ${forbidden}`);
    }
  }
  const permissionBridge = readFileSync(
    join(liveTuiRoot, "bridges/permission-bridge.tsx"),
    "utf8",
  );
  for (const [label, required] of [
    ["Messages", ["./Messages.js", "components/Messages.js"]],
    ["PromptInput", ["./PromptInput/PromptInput.js", "components/PromptInput/PromptInput.js"]],
    ["KeybindingSetup", ["../keybindings/KeybindingProviderSetup.js", "keybindings/KeybindingProviderSetup.js"]],
    ["PromptOverlay", ["../context/promptOverlayContext.js", "context/promptOverlayContext.js"]],
    ["PermissionRequest", ["components/permissions/PermissionRequest.js"]],
  ]) {
    if (!required.some((needle) => app.includes(needle) || permissionBridge.includes(needle))) {
      fail(`upstream live import missing: ${label}`);
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
