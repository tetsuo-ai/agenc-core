import { isAbsolute } from 'node:path';

import { quote } from '../../src/utils/bash/shellQuote.js';

export const SOLANA_DEVNET_GENESIS_HASH =
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const DEFAULT_DEVNET_RPC_HOSTS = Object.freeze([
  'api.devnet.solana.com',
]);

export function assertSupportedDevnetLivePlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    throw new Error(
      'Refusing live transaction guard test: the guarded shell harness requires a POSIX shell',
    );
  }
}

export function parseAdditionalDevnetRpcHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

export function requireExplicitDevnetKeypair(value: string | undefined): string {
  const keypair = value?.trim();
  if (!keypair || keypair.includes('\0') || !isAbsolute(keypair)) {
    throw new Error(
      'Refusing live transaction guard test: set an explicit absolute Devnet keypair path',
    );
  }
  return keypair;
}

export function buildSolanaCliCommand(args: readonly string[]): string {
  return quote(['solana', ...args]);
}

export function validateDevnetRpcEndpoint(
  rpc: string,
  additionalAllowedHosts: readonly string[] = [],
): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(rpc);
  } catch {
    throw new Error('Refusing live transaction guard test: invalid Devnet RPC URL');
  }

  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443')
  ) {
    throw new Error(
      'Refusing live transaction guard test: RPC must use HTTPS on port 443 without URL userinfo',
    );
  }

  const allowedHosts = new Set([
    ...DEFAULT_DEVNET_RPC_HOSTS,
    ...additionalAllowedHosts.map((host) => host.toLowerCase()),
  ]);
  if (!allowedHosts.has(endpoint.hostname.toLowerCase())) {
    throw new Error(
      'Refusing live transaction guard test: RPC hostname is not explicitly allowlisted',
    );
  }
  return endpoint;
}

export function assertSolanaDevnetGenesisHash(actual: string): void {
  if (actual !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new Error(
      'Refusing live transaction guard test: RPC genesis hash is not Solana Devnet',
    );
  }
}
