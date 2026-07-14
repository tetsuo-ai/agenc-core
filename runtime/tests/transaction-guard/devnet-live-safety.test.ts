import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { tryParseShellCommand } from '../../src/utils/bash/shellQuote.js';
import {
  assertSupportedDevnetLivePlatform,
  assertSolanaDevnetGenesisHash,
  buildSolanaCliCommand,
  parseAdditionalDevnetRpcHosts,
  requireExplicitDevnetKeypair,
  SOLANA_DEVNET_GENESIS_HASH,
  validateDevnetRpcEndpoint,
} from './devnet-live-safety.js';

describe('transaction-guard Devnet live safety gate', () => {
  it('fails closed on the unsupported Windows shell path', () => {
    expect(() => assertSupportedDevnetLivePlatform('win32')).toThrow(
      'requires a POSIX shell',
    );
    expect(() => assertSupportedDevnetLivePlatform('linux')).not.toThrow();
    expect(() => assertSupportedDevnetLivePlatform('darwin')).not.toThrow();
  });

  it('accepts the official endpoint and explicitly allowlisted HTTPS providers', () => {
    expect(validateDevnetRpcEndpoint('https://api.devnet.solana.com').hostname).toBe(
      'api.devnet.solana.com',
    );
    expect(
      validateDevnetRpcEndpoint(
        'https://rpc.vendor.example/solana?api-key=redacted',
        ['rpc.vendor.example'],
      ).hostname,
    ).toBe('rpc.vendor.example');
  });

  it.each([
    'not a URL',
    'http://api.devnet.solana.com',
    'https://user:secret@api.devnet.solana.com',
    'https://api.devnet.solana.com:8443',
    'https://api.devnet.solana.com/#devnet',
    'https://api.devnet.solana.com.evil.example',
    'https://api.mainnet-beta.solana.com/devnet',
    'https://evil.example/?cluster=devnet',
  ])('rejects unsafe or non-allowlisted endpoint %s', (rpc) => {
    expect(() => validateDevnetRpcEndpoint(rpc)).toThrow(/^Refusing live/u);
  });

  it('parses an exact comma-separated custom-host allowlist', () => {
    expect(parseAdditionalDevnetRpcHosts(' RPC.ONE.example, rpc.two.example ')).toEqual([
      'rpc.one.example',
      'rpc.two.example',
    ]);
  });

  it('requires an explicit absolute keypair path without normalizing internal spaces', () => {
    const keypair = resolve(tmpdir(), 'operator wallet; reviewed.json');
    expect(requireExplicitDevnetKeypair(`  ${keypair}  `)).toBe(keypair);
    expect(() => requireExplicitDevnetKeypair(undefined)).toThrow(
      'set an explicit absolute Devnet keypair path',
    );
    expect(() => requireExplicitDevnetKeypair('')).toThrow(/^Refusing live/u);
    expect(() => requireExplicitDevnetKeypair('relative/wallet.json')).toThrow(
      /^Refusing live/u,
    );
    expect(() => requireExplicitDevnetKeypair(`${keypair}\0suffix`)).toThrow(
      /^Refusing live/u,
    );
  });

  it('quotes RPC queries and keypair paths as literal shell arguments', () => {
    const keypair = resolve(tmpdir(), 'operator wallet; touch never.json');
    const rpc =
      'https://api.devnet.solana.com/?next=$(touch%20never)&mode=a%26b';
    const args = [
      'transfer',
      'Recipient111111111111111111111111111111111',
      '0.001',
      '--url',
      rpc,
      '--keypair',
      keypair,
      '--memo',
      '# ignore; $(touch never)',
    ];
    const parsed = tryParseShellCommand(buildSolanaCliCommand(args));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // shell-quote reports an escaped `?` URL as a glob-shaped token even
    // though the POSIX shell receives it literally. Normalize only that
    // representation; any command operator from raw interpolation remains an
    // object and makes the equality assertion fail.
    const normalized = parsed.tokens.map((token) =>
      typeof token !== 'string' &&
      token.op === 'glob' &&
      'pattern' in token &&
      typeof token.pattern === 'string'
        ? token.pattern
        : token,
    );
    expect(normalized).toEqual(['solana', ...args]);
  });

  it.skipIf(process.platform === 'win32')(
    'round-trips hostile-looking values through a real POSIX shell',
    () => {
      const temp = mkdtempSync(join(tmpdir(), 'agenc-devnet-shell-probe-'));
      try {
        const fakeSolana = join(temp, 'solana');
        writeFileSync(
          fakeSolana,
          '#!/bin/sh\nexec "$AGENC_TEST_NODE" -e \'process.stdout.write(JSON.stringify(process.argv.slice(1)))\' -- "$@"\n',
          { mode: 0o700 },
        );
        chmodSync(fakeSolana, 0o700);
        const args = [
          'transfer',
          'Recipient111111111111111111111111111111111',
          '0.001',
          '--url',
          'https://api.devnet.solana.com/?next=$(touch%20never)&mode=a%26b',
          '--keypair',
          join(temp, 'operator wallet; touch never.json'),
          '--memo',
          '# ignore; $(touch never)',
        ];
        const result = spawnSync('/bin/sh', ['-c', buildSolanaCliCommand(args)], {
          cwd: temp,
          encoding: 'utf8',
          env: {
            ...process.env,
            AGENC_TEST_NODE: process.execPath,
            PATH: `${temp}${delimiter}${process.env.PATH ?? ''}`,
          },
          timeout: 10_000,
        });
        expect(
          result.status,
          `shell probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(args);
      } finally {
        rmSync(temp, { force: true, recursive: true });
      }
    },
  );

  it('accepts only the full Solana Devnet genesis hash', () => {
    expect(() => assertSolanaDevnetGenesisHash(SOLANA_DEVNET_GENESIS_HASH)).not.toThrow();
    expect(() =>
      assertSolanaDevnetGenesisHash('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'),
    ).toThrow('RPC genesis hash is not Solana Devnet');
    expect(() => assertSolanaDevnetGenesisHash('devnet')).toThrow(
      'RPC genesis hash is not Solana Devnet',
    );
  });
});
