import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import net from 'node:net';

import { describe, expect, it, vi } from 'vitest';

const PUBLIC_NETWORK_BLOCKED_CODE = 'AGENC_TEST_PUBLIC_NETWORK_BLOCKED';
const CHILD_MARKER = 'AGENC_TEST_NETWORK_WIRING_CHILD';
const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const vitestCli = resolve(runtimeRoot, '../node_modules/vitest/vitest.mjs');

if (process.env[CHILD_MARKER] === '1') {
  describe('fresh default-suite network-tripwire worker', () => {
    it('blocks before lookup without importing the tripwire helper', () => {
      const lookup = vi.fn(
        (
          _host: string,
          _options: unknown,
          callback: (error: Error) => void,
        ) => callback(Object.assign(new Error('safe lookup sentinel'), {
          code: 'LOOKUP_CALLED',
        })),
      );

      let socket: net.Socket | undefined;
      let thrown: unknown;
      try {
        socket = net.connect({
          host: 'setup-wiring.example.test',
          port: 443,
          lookup: lookup as never,
        });
        socket.once('error', () => undefined);
      } catch (error) {
        thrown = error;
      } finally {
        socket?.destroy();
      }

      expect(thrown).toMatchObject({ code: PUBLIC_NETWORK_BLOCKED_CODE });
      const consumeAttempt = (
        globalThis as unknown as Record<symbol, (error: unknown) => boolean>
      )[Symbol.for('agenc.test.public-network-tripwire.consume-attempt')];
      expect(
        consumeAttempt(thrown),
      ).toBe(true);
      expect(lookup).not.toHaveBeenCalled();
    });
  });
} else {
  describe('default-suite network-tripwire setup wiring', () => {
    it('installs the guard in a fresh worker with no inherited preload', () => {
      const env = { ...process.env, [CHILD_MARKER]: '1' };
      delete env.NODE_OPTIONS;
      const result = spawnSync(
        process.execPath,
        [
          vitestCli,
          'run',
          'tests/network-tripwire-wiring.test.ts',
          '--config',
          'vitest.config.ts',
          '--reporter=dot',
        ],
        {
          cwd: runtimeRoot,
          encoding: 'utf8',
          env,
          timeout: 30_000,
        },
      );

      expect(
        result.status,
        `fresh wiring worker failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
    });
  });
}
