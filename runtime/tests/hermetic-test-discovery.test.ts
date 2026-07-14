import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from 'vite';

import {
  HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS,
  sanitizeHermeticEnv,
} from './helpers/hermetic-env.mjs';

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const vitestCli = resolve(runtimeRoot, '../node_modules/vitest/vitest.mjs');

const LIVE_TEST_FILES = [
  'tests/browser/live-e2e.test.ts',
  'tests/live/grok-full-surface-e2e.live.test.ts',
  'tests/live/imagine-video-e2e.live.test.ts',
  'tests/live/xsearch-retry.live.test.ts',
  'tests/llm/provider.integration.test.ts',
  'tests/transaction-guard/devnet-live.e2e.test.ts',
] as const;

function listTestFiles(config: string): string[] {
  const result = spawnSync(
    process.execPath,
    [vitestCli, 'list', '--filesOnly', '--config', config],
    {
      cwd: runtimeRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    },
  );

  expect(
    result.status,
    `vitest list failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\.test\.tsx?$/.test(line))
    .map((file) => {
      const absolute = isAbsolute(file) ? file : resolve(runtimeRoot, file);
      return relative(runtimeRoot, absolute).split('\\').join('/');
    })
    .sort();
}

describe('hermetic test discovery', () => {
  it('keeps every external-I/O test out of default discovery', () => {
    const files = listTestFiles('vitest.config.ts');

    for (const liveFile of LIVE_TEST_FILES) {
      expect(files, `${liveFile} leaked into the default suite`).not.toContain(liveFile);
    }

    // Despite its historical filename, this test only inspects production
    // rendering source and is intentionally part of the offline suite.
    expect(files).toContain(
      'tests/tui/parity/HookProgressMessage.live.parity.test.ts',
    );
  });

  it('live discovery is an explicit allowlist of external-I/O tests', () => {
    expect(listTestFiles('vitest.live.config.ts')).toEqual([...LIVE_TEST_FILES]);
  });

  it('loads live mode with no setup files while default mode keeps its setup', async () => {
    const environment = { command: 'serve', mode: 'test' } as const;
    const defaultResult = await loadConfigFromFile(
      environment,
      resolve(runtimeRoot, 'vitest.config.ts'),
      runtimeRoot,
    );
    const liveResult = await loadConfigFromFile(
      environment,
      resolve(runtimeRoot, 'vitest.live.config.ts'),
      runtimeRoot,
    );

    expect(defaultResult?.config.test?.setupFiles).toEqual(['./vitest.setup.ts']);
    expect(liveResult?.config.test?.setupFiles).toEqual([]);
  });

  it('strips every ambient live opt-in without stripping passphrases', () => {
    const env: NodeJS.ProcessEnv = {
      AGENC_CLIENT_KEY_PASSPHRASE: 'must-survive',
    };
    for (const name of HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS) env[name] = '1';

    sanitizeHermeticEnv(env, '/tmp/agenc-hermetic-discovery-test');

    for (const name of HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS) {
      expect(env[name], `${name} survived sanitization`).toBeUndefined();
    }
    expect(env.AGENC_CLIENT_KEY_PASSPHRASE).toBe('must-survive');
  });
});
