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
    expect(target).toContain('getShortcutDisplay');
    expect(target).toContain('app:toggleTranscript');
  });

  it('exposes runtime-session adapter hooks backed by upstream compaction modules', () => {
    const target = readTarget('adapter-runtime-session');
    const loaders = readTarget('adapter-dynamic-loaders');

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
    expect(loaders).toContain('../upstream/services/compact');
    expect(loaders).toContain('../upstream/services/contextCollapse');
    expect(loaders).toContain('../upstream/commands/compact');
    expect(loaders).toContain('../upstream/commands/context');
    expect(target).not.toContain('return { kind: "pass" };');
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
