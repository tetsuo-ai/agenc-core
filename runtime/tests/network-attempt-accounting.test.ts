import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

const CHILD_MODE = 'AGENC_TEST_NETWORK_ATTEMPT_CHILD_MODE';
const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const prelauncher = fileURLToPath(
  new URL('../scripts/run-hermetic-vitest.mjs', import.meta.url),
);

if (process.env[CHILD_MODE] === 'caught-fetch') {
  describe('caught public-network attempt fixture', () => {
    it('cannot hide an attempted request by catching its rejection', async () => {
      await fetch('https://caught-attempt.example.test/private', {
        signal: AbortSignal.abort(),
      }).catch(
        () => undefined,
      );
      expect(true).toBe(true);
    });
  });
} else if (process.env[CHILD_MODE] === 'terminated-worker') {
  describe('terminated Worker network-attempt fixture', () => {
    it('cannot discard the ledger by replacing its environment', async () => {
      const source = `
        const { parentPort } = require('node:worker_threads');
        fetch('https://terminated-worker.example.test/private', {
          signal: AbortSignal.abort(),
        })
          .catch((error) => {
            parentPort.postMessage(error.code);
            setInterval(() => {}, 1_000);
          });
      `;
      const worker = new Worker(source, { eval: true, env: {} });
      const code = await new Promise<string>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      expect(code).toBe('AGENC_TEST_PUBLIC_NETWORK_BLOCKED');
      await worker.terminate();
    });
  });
} else {
  describe('public-network attempt accounting', () => {
    function runNested(mode: string, tempRoot?: string) {
      const result = spawnSync(
        process.execPath,
        [
          prelauncher,
          'run',
          'tests/network-attempt-accounting.test.ts',
          '--config',
          'vitest.config.ts',
          '--reporter=dot',
        ],
        {
          cwd: runtimeRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            [CHILD_MODE]: mode,
            ...(tempRoot === undefined ? {} : {
              TMP: tempRoot,
              TEMP: tempRoot,
              TMPDIR: tempRoot,
            }),
          },
          timeout: 30_000,
        },
      );

      return result;
    }

    it('fails the hermetic run even when the test catches the blocked error', () => {
      const result = runNested('caught-fetch');

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'unconsumed public-network attempt(s)',
      );
      expect(result.stderr).toContain('network-attempt-accounting.test.ts');
    });

    it('retains Worker attempts when a custom env is terminated early', () => {
      const result = runNested('terminated-worker');

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'unconsumed public-network attempt(s)',
      );
    });

    it('removes its owned run root after a failing nested invocation', () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'agenc-run-cleanup-test-'));
      const isolatedTemp = join(fixtureRoot, 'tmp');
      mkdirSync(isolatedTemp, { recursive: true });
      try {
        const result = runNested('caught-fetch', isolatedTemp);
        expect(result.status).toBe(1);
        expect(readdirSync(isolatedTemp)).toEqual([]);
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });
  });
}
