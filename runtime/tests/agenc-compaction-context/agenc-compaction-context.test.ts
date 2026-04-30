import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type MatrixRow = {
  id: string;
  source: string;
  target: string;
  sourceRoot?: string;
};

type Matrix = {
  sourceRoot: string;
  targetRoot: string;
  brandingScopes?: string[];
  rows: MatrixRow[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const matrixPath = path.join(
  repoRoot,
  'runtime/parity/agenc-compaction-context.json',
);
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8')) as Matrix;
const matrixDir = path.dirname(matrixPath);

function resolveFrom(root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function row(id: string): MatrixRow {
  const found = matrix.rows.find(entry => entry.id === id);
  if (!found) throw new Error(`contract row not found: ${id}`);
  return found;
}

function targetPath(entry: MatrixRow): string {
  return resolveFrom(resolveFrom(matrixDir, matrix.targetRoot), entry.target);
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function readTarget(id: string): string {
  return read(targetPath(row(id)));
}

function readRelative(relativePath: string): string {
  return read(path.join(repoRoot, relativePath));
}

function expectExports(id: string, names: readonly string[]): void {
  const target = readTarget(id);
  for (const name of names) {
    expect(target).toMatch(
      new RegExp(
        `export\\s+(async\\s+)?(function|const|class|interface|type)\\s+${name}\\b`,
      ),
    );
  }
}

function collectFiles(scope: string): string[] {
  const absolute = resolveFrom(repoRoot, scope);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    return collectFiles(path.join(scope, entry.name));
  });
}

function collectSymlinks(scope: string): string[] {
  const absolute = resolveFrom(repoRoot, scope);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return [absolute];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    collectSymlinks(path.join(scope, entry.name))
  );
}

const blockedNameTerms = [
  [99, 108, 97, 117, 100, 101],
  [99, 111, 100, 101, 120],
].map((codes) => String.fromCharCode(...codes));

const sourceProductName = blockedNameTerms[0];
const otherProductName = blockedNameTerms[1];
const sourceProductTitle =
  sourceProductName.charAt(0).toUpperCase() + sourceProductName.slice(1);
const sourceProductUpper = sourceProductName.toUpperCase();

function containsBlockedName(value: string): boolean {
  const normalized = value.toLowerCase();
  return blockedNameTerms.some((term) => normalized.includes(term));
}

describe('AgenC required files', () => {
  for (const entry of matrix.rows) {
    it(`${entry.id} target exists`, () => {
      expect(fs.existsSync(targetPath(entry))).toBe(true);
    });
  }
});

describe('AgenC naming gate', () => {
  it('keeps configured paths and contents on AgenC naming', () => {
    const files = [
      ...new Set((matrix.brandingScopes ?? []).flatMap((scope) => collectFiles(scope))),
    ];

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const relative = path.relative(repoRoot, file);
      expect(containsBlockedName(relative), relative).toBe(false);
      if (fs.statSync(file).isFile()) {
        const content = read(file);
        expect(containsBlockedName(content), relative).toBe(false);
      }
    }
  });
});

describe('copied upstream compact/context code', () => {
  it('keeps the copied dependency source tree local to AgenC', () => {
    const copiedRoot = path.join(repoRoot, 'runtime/src/agenc/upstream');
    const copiedFiles = collectFiles('runtime/src/agenc/upstream')
      .map(file => path.relative(copiedRoot, file))
      .sort();

    expect(copiedFiles.length).toBeGreaterThan(1000);
    for (const file of [
      'commands/compact/compact.ts',
      'commands/compact/index.ts',
      'commands/context/context-noninteractive.ts',
      'commands/context/context.tsx',
      'commands/context/index.ts',
      'services/compact/apiMicrocompact.ts',
      'services/compact/autoCompact.ts',
      'services/compact/cachedMicrocompact.ts',
      'services/compact/cachedMCConfig.ts',
      'services/compact/compact.ts',
      'services/compact/compactWarningState.ts',
      'services/compact/grouping.ts',
      'services/compact/microCompact.ts',
      'services/compact/postCompactCleanup.ts',
      'services/compact/prompt.ts',
      'services/compact/sessionMemoryCompact.ts',
      'services/compact/snipCompact.ts',
      'services/compact/timeBasedMCConfig.ts',
      'services/contextCollapse/index.ts',
      'services/contextCollapse/operations.ts',
      'services/contextCollapse/persist.ts',
      'tools/CtxInspectTool/CtxInspectTool.ts',
      'utils/permissions/yolo-classifier-prompts/auto_mode_system_prompt.txt',
      'utils/permissions/yolo-classifier-prompts/permissions_external.txt',
      'utils/permissions/yolo-classifier-prompts/permissions_anthropic.txt',
      'commands/fork/index.ts',
      'tools/VerifyPlanExecutionTool/constants.ts',
      'utils/context.ts',
      'utils/contextAnalysis.ts',
      'utils/model/contextWindowUpgradeCheck.ts',
      'bootstrap/state.ts',
      'utils/config.ts',
      'Tool.ts',
      'commands.ts',
      `services/api/${sourceProductName}.ts`,
      'proto/agenc.proto',
    ]) {
      expect(copiedFiles, file).toContain(file);
    }

    const symlinks = collectSymlinks('runtime/src/agenc/upstream')
      .map(file => path.relative(repoRoot, file));
    expect(symlinks).toEqual([]);
  });

  it('keeps local resolver config independent from sibling source checkouts', () => {
    const sourceRepoName = `open${sourceProductName}`;
    const otherRepoName = `open${otherProductName}`;
    const resolverFiles = [
      'runtime/tsup.config.ts',
      'runtime/vitest.config.ts',
      'runtime/src/agenc/adapters/dynamic-loaders.js',
    ];
    const forbiddenResolverTerms = [
      ['upstream', 'Source', 'Root'].join(''),
      ['upstream', 'Project'].join(''),
      `../${sourceRepoName}`,
      `..\\${sourceRepoName}`,
      `/${sourceRepoName}/src`,
      `../${otherRepoName}`,
      `..\\${otherRepoName}`,
      `/${otherRepoName}/src`,
    ];

    for (const file of resolverFiles) {
      const content = read(path.join(repoRoot, file));
      for (const term of forbiddenResolverTerms) {
        expect(content, `${file} must not contain ${term}`).not.toContain(term);
      }
    }
  });

  it('uses AgenC branding for copied user-facing source terms', () => {
    const copiedFiles = collectFiles('runtime/src/agenc/upstream');
    const forbiddenCopiedTerms = [
      `Open${sourceProductTitle}`,
      `OPEN${sourceProductUpper}`,
      `${sourceProductTitle} Code`,
      `${sourceProductUpper}_CODE`,
      `${sourceProductName}-cli`,
      `${sourceProductName}-code`,
      `.${sourceProductName}`,
      `~/.${sourceProductName}`,
      `${sourceProductName}.ai`,
    ];

    for (const file of copiedFiles) {
      const relative = path.relative(repoRoot, file);
      const content = read(file);
      for (const term of forbiddenCopiedTerms) {
        expect(relative, relative).not.toContain(term);
        expect(content, relative).not.toContain(term);
      }
    }
  });
});

describe('AgenC runtime integration', () => {
  it('routes session turns through AgenC context and compaction adapters', () => {
    const target = readTarget('query-loop-context-pipeline');

    expect(target).toContain('prepareAgenCTurnContext');
    expect(target).toContain('getAgenCPreparedTerminal');
    expect(target).toContain('runAgenCAutoCompact');
    expect(target).toContain('buildAgenCCompactedRolloutItem');
    expect(target).toContain('buildAgenCPostCompactMessages');
    expect(target).not.toContain('../phases/prepare-context');
    expect(target).not.toContain('../llm/compact');
    expect(target).not.toContain('compact-runtime-context');
  });

  it('uses the AgenC compact boundary renderer', () => {
    const target = readTarget('compact-boundary-ui');

    expect(target).toContain('Conversation compacted');
    expect(target).toContain('useShortcutDisplay');
    expect(target).toContain('app:toggleTranscript');
  });

  it('exposes runtime-session adapter hooks backed by upstream compaction modules', () => {
    const target = readTarget('adapter-runtime-session');
    const loaders = readTarget('adapter-dynamic-loaders');
    const compactRuntime = readRelative(
      'runtime/src/agenc/adapters/compact-runtime.ts',
    );

    expectExports('adapter-runtime-session', [
      'prepareAgenCTurnContext',
      'getAgenCPreparedTerminal',
      'runAgenCAutoCompact',
      'runAgenCContextUsage',
      'runAgenCContextCollapseOverflowRecovery',
      'buildAgenCCompactedRolloutItem',
      'buildAgenCPostCompactMessages',
    ]);
    expect(target).toContain('loadContextCollapseModule');
    expect(target).toContain('loadAutoCompactModule');
    expect(target).toContain('withUpstreamContextGuards');
    expect(target).toContain('UPSTREAM_CONTEXT_GUARD_ENV');
    expect(loaders).toContain('applyCollapsesIfNeeded');
    expect(loaders).toContain('autoCompactIfNeeded');
    expect(loaders).toContain('recoverFromOverflow');
    expect(loaders).toContain('./compact-runtime.js');
    expect(loaders).not.toContain('../upstream/services/compact');
    expect(loaders).not.toContain('../upstream/services/contextCollapse');
    expect(loaders).not.toContain('../upstream/commands/compact');
    expect(loaders).not.toContain('../upstream/commands/context');
    expect(compactRuntime).toContain('autoCompactIfNeeded');
    expect(compactRuntime).toContain('manualCompactCall');
    expect(compactRuntime).toContain('contextUsageCall');
    expect(compactRuntime).toContain('microcompactMessages');
    expect(target).not.toContain('return { kind: "pass" };');
  });

  it('keeps compact/context guards independent from copied upstream config imports', () => {
    const target = readTarget('adapter-runtime-session');
    const loaders = readTarget('adapter-dynamic-loaders');
    const guardIndex = target.indexOf('async function withUpstreamContextGuards');

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(target.slice(guardIndex)).toContain('process.env[key] = value;');
    expect(loaders).not.toContain('enableUpstreamConfigGate');
    expect(loaders).not.toContain('../upstream/utils/config');
    expect(loaders).not.toContain('enableConfigs()');
    expect(target).not.toContain('../upstream/utils/config');
  });

  it('defines copied runtime build constants during bundling', () => {
    const target = readTarget('upstream-build-constants');

    expect(target).toContain("'MACRO.VERSION'");
    expect(target).toContain("'MACRO.DISPLAY_VERSION'");
    expect(target).toContain("'MACRO.BUILD_TIME'");
    expect(target).toContain("'MACRO.ISSUES_EXPLAINER'");
    expect(target).toContain("'MACRO.FEEDBACK_CHANNEL'");
    expect(target).toContain("'MACRO.PACKAGE_URL'");
    expect(target).toContain("'MACRO.NATIVE_PACKAGE_URL'");
    expect(target).toContain("'MACRO.VERSION_CHANGELOG'");
    expect(target).toContain('@tetsuo-ai/runtime');
  });

  it('matches the open-build feature map for compaction and memory gates', () => {
    const target = readTarget('upstream-feature-flags');

    for (const flag of [
      'CACHED_MICROCOMPACT',
      'EXTRACT_MEMORIES',
      'TEAMMEM',
      'PROMPT_CACHE_BREAK_DETECTION',
      'HOOK_PROMPTS',
      'TRANSCRIPT_CLASSIFIER',
      'CONTEXT_COLLAPSE',
    ]) {
      expect(target).toContain(`${flag}: true`);
    }
    for (const flag of [
      'REACTIVE_COMPACT',
      'KAIROS',
      'DAEMON',
      'FORK_SUBAGENT',
    ]) {
      expect(target).toContain(`${flag}: false`);
    }
  });

  it('resolves local config defaults without remote feature calls', () => {
    const target = readTarget('upstream-config-defaults');

    expect(target).toContain('openBuildDefaults');
    expect(target).toContain('tengu_passport_quail: true');
    expect(target).toContain('tengu_coral_fern: true');
    expect(target).toContain('tengu_session_memory: false');
    expect(target).toContain('tengu_sm_compact: false');
    expect(target).toContain('AGENC_FEATURE_FLAGS_FILE');
    expect(target).toContain("'.agenc'");
    expect(target).toContain('getOpenBuildFeatureValue');
  });

  it('passes the active provider to copied compact requests', () => {
    const target = readTarget('provider-model-bridge');
    const runtimeSession = readTarget('adapter-runtime-session');
    const copiedCompact = readRelative(
      'runtime/src/agenc/upstream/services/compact/compact.ts',
    );

    expect(target).toContain('readProviderFactoryOptions');
    expect(target).toContain('providerOverride');
    expect(target).toContain('baseURL');
    expect(target).toContain('apiKey');
    expect(runtimeSession).toContain('envForToolUseContext');
    expect(runtimeSession).toContain('AGENC_USE_OPENAI');
    expect(runtimeSession).toContain('OPENAI_MODEL');
    expect(runtimeSession).toContain('AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW');
    expect(copiedCompact).toContain(
      'providerOverride: context.options.providerOverride',
    );
  });

  it('runs copied preflight steps before sampling', () => {
    const target = readTarget('adapter-runtime-session');
    const toolContext = readTarget('adapter-tool-use-context');
    const turnLoop = readTarget('query-loop-context-pipeline');
    const prepareIndex = turnLoop.indexOf('await prepareAgenCTurnContext');
    const attachmentsIndex = turnLoop.indexOf('getAttachments({', prepareIndex);

    expect(target).toContain('prepareAgenCQueryMessages');
    expect(target).toContain('contentReplacementState: state.contentReplacementState');
    expect(target).toContain('loadToolResultStorageModule');
    expect(target).toContain('applyToolResultBudget');
    expect(target).toContain('recordContentReplacement');
    expect(target).toContain('toUpstreamMessageContent');
    expect(target).toContain('type: "text", text: content');
    expect(target).toContain('loadMicroCompactModule');
    expect(target).toContain('microcompactMessages');
    expect(toolContext).toContain('DEFAULT_MAX_RESULT_SIZE_CHARS');
    expect(toolContext).toContain('maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS');
    expect(target.indexOf('applyToolResultBudget')).toBeLessThan(
      target.indexOf('microcompactMessages'),
    );
    expect(prepareIndex).toBeGreaterThanOrEqual(0);
    expect(attachmentsIndex).toBeGreaterThanOrEqual(0);
    expect(prepareIndex).toBeLessThan(attachmentsIndex);
  });

  it('does not suppress copied auto-compact when the model has a context window', () => {
    const target = readTarget('auto-compact-reachability');

    expect(target).toContain('getAutoCompactTokenLimit(ctx)');
    expect(target).toContain('if (autoCompactLimit !== undefined)');
    expect(target).not.toContain(
      'autoCompactTokenLimit ?? Number.POSITIVE_INFINITY',
    );
  });

  it('mirrors manual compact slash-command replacement semantics', () => {
    const target = readTarget('manual-compact-slash-semantics');

    expect(target).toContain('addManualCompactSlashMessages');
    expect(target).toContain('formatCommandInputTags("compact", args)');
    expect(target).toContain('resetAgenCMicrocompactState');
    expect(target).toContain('messagesToKeep');
    expect(target).toContain('buildPostCompactMessages');
    expect(target).toContain('clearProviderResponseId');
  });

  it('keeps cache-safe compact params isolated from durable prompt and memory inputs', () => {
    const target = readTarget('compact-cache-params');
    const cachedConfig = readTarget('cached-microcompact-config-source');
    const prompts = readRelative('runtime/src/agenc/upstream/constants/prompts.ts');

    expect(target).not.toContain('loadPromptContextModules');
    expect(target).not.toContain('getSystemPrompt');
    expect(target).not.toContain('getUserContext');
    expect(target).not.toContain('getSystemContext');
    expect(target).not.toContain('buildEffectiveSystemPrompt');
    expect(target).toContain('systemPrompt: []');
    expect(target).toContain('userContext: {}');
    expect(target).toContain('systemContext: {}');
    expect(cachedConfig).toContain('getCachedMCConfig');
    expect(prompts).toContain('getCachedMCConfigForFRCSource');
    expect(prompts).toContain('getAntModelOverrideConfig');
    expect(prompts).toContain("../utils/model/antModels.js");
    expect(prompts).not.toContain(
      "require('../services/compact/cachedMCConfig.js')",
    );
  });

  it('routes context analysis through the same model bridge and message view', () => {
    const runtimeSession = readTarget('adapter-runtime-session');
    const slash = readRelative('runtime/src/agenc/adapters/slash-commands.ts');

    expect(slash).toContain('runAgenCContextUsage');
    expect(runtimeSession).toContain('messagesAfterAgenCBoundary');
    expect(runtimeSession).toContain('loadContextNonInteractiveCommand');
    expect(runtimeSession).toContain('envForToolUseContext');
  });

  it('keeps durable memory separate from compacted history projection', () => {
    const runtimeSession = readTarget('adapter-runtime-session');
    const memoryIndex = readRelative('runtime/src/prompts/memory/index.ts');
    const orchestrator = readRelative(
      'runtime/src/prompts/attachments/orchestrator.ts',
    );
    const relevantMemory = readRelative(
      'runtime/src/prompts/attachments/relevant-memory.ts',
    );

    expect(runtimeSession).not.toContain('getUserContext');
    expect(runtimeSession).not.toContain('loadPromptContextModules');
    expect(runtimeSession).not.toContain('DISABLE_AGENC_SM_COMPACT');
    expect(runtimeSession).not.toContain('AGENC_DISABLE_AGENC_MDS');
    expect(memoryIndex).toContain('maybeAutoSaveMemory');
    expect(memoryIndex).toContain('selectRelevantMemoriesForTurn');
    expect(orchestrator).toContain('relevantMemoryProducer');
    expect(relevantMemory).toContain('relevant_memories');
  });

  it('resets provider continuation after compact replacement', () => {
    const target = readTarget('post-compact-cleanup-continuation');

    expect(target).toContain('clearProviderResponseId');
    expect(target).toContain('sessionState.history = compacted');
    expect(target).toContain('buildAgenCCompactedRolloutItem');
  });

  it('wires live context-collapse source through the adapter', () => {
    const target = readTarget('context-collapse-live-source');
    const operations = readTarget('context-collapse-operations-source');
    const persist = readTarget('context-collapse-persist-source');
    const inspectTool = readTarget('context-collapse-inspection-tool');
    const runtimeSession = readTarget('adapter-runtime-session');
    const upstreamTools = readRelative('runtime/src/agenc/upstream/tools.ts');

    expect(target).toContain('isContextCollapseEnabled');
    expect(target).toContain('applyCollapsesIfNeeded');
    expect(target).toContain('recoverFromOverflow');
    expect(target).toContain('resetContextCollapse');
    expect(target).toContain('getContextCollapseSnapshot');
    expect(target).toContain('restoreContextCollapseState');
    expect(target).toContain('AGENC_CONTEXT_COLLAPSE');
    expect(target).not.toContain(`${sourceProductUpper}_CONTEXT_COLLAPSE`);
    expect(target).not.toContain(
      'export function isContextCollapseEnabled(): boolean {\n  return false',
    );
    expect(operations).toContain('getContextVisualizationData');
    expect(operations).toContain('resetContextCollapse');
    expect(persist).toContain('restoreContextCollapseState');
    expect(persist).toContain('getContextCollapseCommits');
    expect(inspectTool).toContain('getContextVisualizationData');
    expect(inspectTool).toContain('getContextCollapseSnapshot');
    expect(inspectTool).toContain('getContextCollapseCommits');
    expect(inspectTool).toContain("name: 'CtxInspect'");
    expect(upstreamTools).toContain('ContextCollapseInspectTool');
    expect(upstreamTools).toContain('? ContextCollapseInspectTool');
    expect(upstreamTools).not.toContain(
      "require('./tools/CtxInspectTool/CtxInspectTool.js')",
    );
    expect(runtimeSession).toContain('function isAgenCContextCollapseRequested');
    expect(runtimeSession).toContain('return true;');
    expect(runtimeSession).not.toContain(
      'if (!isAgenCContextCollapseRequested()) return passRecovery();',
    );
  });

  it('stores upstream classifier prompt payloads as local AgenC-branded source', () => {
    const promptDir = targetPath(row('classifier-prompt-assets'));
    const verifyPlanConstant = readTarget('classifier-verify-plan-constant');
    const basePrompt = read(path.join(promptDir, 'auto_mode_system_prompt.txt'));
    const externalPrompt = read(path.join(promptDir, 'permissions_external.txt'));
    const antPrompt = read(path.join(promptDir, 'permissions_anthropic.txt'));
    const yoloClassifier = readRelative(
      'runtime/src/agenc/upstream/utils/permissions/yoloClassifier.ts',
    );

    expect(basePrompt.length).toBeGreaterThan(10_000);
    expect(externalPrompt.length).toBeGreaterThan(10_000);
    expect(antPrompt).toBe('');
    expect(basePrompt).toContain('<permissions_template>');
    expect(basePrompt).toContain('classify_result');
    expect(basePrompt).toContain('CLASSIFIER BYPASS');
    expect(externalPrompt).toContain('<user_allow_rules_to_replace>');
    expect(externalPrompt).toContain('<user_deny_rules_to_replace>');
    expect(externalPrompt).toContain('AGENTS.md');
    expect(externalPrompt).toContain('~/.agenc/projects/*/memory/');
    expect(`${basePrompt}\n${externalPrompt}`).not.toContain(`~/.${sourceProductName}`);
    expect(`${basePrompt}\n${externalPrompt}`).not.toContain(`.${sourceProductName}/`);
    expect(`${basePrompt}\n${externalPrompt}`).not.toContain(`${sourceProductUpper}.md`);
    expect(yoloClassifier).toContain(
      "require('./yolo-classifier-prompts/auto_mode_system_prompt.txt')",
    );
    expect(yoloClassifier).toContain(
      "require('./yolo-classifier-prompts/permissions_external.txt')",
    );
    expect(yoloClassifier).toContain('<user_agenc_md>');
    expect(verifyPlanConstant).toContain('VERIFY_PLAN_EXECUTION_TOOL_NAME');
    expect(verifyPlanConstant).toContain('VerifyPlanExecution');
    const classifierDecision = readRelative(
      'runtime/src/agenc/upstream/utils/permissions/classifierDecision.ts',
    );
    expect(classifierDecision).toContain('VERIFY_PLAN_EXECUTION_TOOL_NAME_SOURCE');
    expect(classifierDecision).not.toContain(
      "require('../../tools/VerifyPlanExecutionTool/constants.js')",
    );
  });

  it('resolves ant model helper users through local imports', () => {
    const helper = readTarget('ant-model-override-symbol-imports');

    expect(helper).toContain('resolveAntModel');
    for (const file of [
      'runtime/src/agenc/upstream/utils/context.ts',
      'runtime/src/agenc/upstream/utils/effort.ts',
      'runtime/src/agenc/upstream/utils/model/model.ts',
      'runtime/src/agenc/upstream/utils/thinking.ts',
    ]) {
      const content = readRelative(file);
      expect(content, file).toContain('resolveAntModel');
      expect(content, file).toContain('antModels.js');
    }
  });

  it('has local Qwen context metadata for compaction budgeting', () => {
    const contextWindows = readTarget('qwen-local-context-window');

    expect(contextWindows).toContain('qwen3.6-35b-a3b-fp8');
    expect(contextWindows).toContain('262_144');
    expect(contextWindows).toContain('65_536');
  });

  it('keeps conditional fork command imports local while the incomplete flag is off', () => {
    const command = readTarget('fork-command-conditional-source');
    const flags = readTarget('upstream-feature-flags');

    expect(command).toContain('name: "fork"');
    expect(command).toContain('AgenC source tree');
    expect(flags).toContain('FORK_SUBAGENT: false');
  });

  it('keeps adapter modules as typed integration glue', () => {
    expectExports('adapter-message-rollout', [
      'toAgenCMessage',
      'toAgenCMessages',
      'fromAgenCMessage',
      'buildCompactedRolloutPayload',
    ]);
    expectExports('adapter-tool-use-context', ['buildAgenCToolUseContext']);
    expectExports('adapter-model-context', ['toAgenCModelContext']);
  });
});
