import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net, { connect as namedNetConnect, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls, { connect as namedTlsConnect } from 'node:tls';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installNetworkTripwire,
  isLoopbackHost,
  PUBLIC_NETWORK_BLOCKED_CODE,
} from './helpers/network-tripwire.mjs';

const openServers = new Set<net.Server | http.Server>();

async function closeServer(server: net.Server | http.Server): Promise<void> {
  openServers.delete(server);
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function listenTcp(server: net.Server | http.Server): Promise<number> {
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an IPv4 TCP listener');
  }
  return address.port;
}

async function listenIpc(server: net.Server, path: string): Promise<void> {
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

function captureBlocked(action: () => unknown): Error & { code?: string } {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: PUBLIC_NETWORK_BLOCKED_CODE });
    return error as Error & { code?: string };
  }
  throw new Error('expected the public-network tripwire to throw');
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => closeServer(server)));
});

describe('default-suite public-network tripwire', () => {
  it('guards CommonJS exports, ESM named exports, and direct Socket.connect', () => {
    expect(namedNetConnect).toBe(net.connect);
    expect(namedTlsConnect).toBe(tls.connect);

    // Throwing lookups make this test safe and revert-sensitive: if the guard
    // disappears, Node calls the local spy and throws LOOKUP_CALLED without
    // ever querying DNS or opening a public socket.
    const lookup = vi.fn(() => {
      throw Object.assign(new Error('lookup should not run'), {
        code: 'LOOKUP_CALLED',
      });
    });

    captureBlocked(() => net.connect({ host: 'net.example.test', port: 443, lookup }));
    expect(lookup).not.toHaveBeenCalled();

    // An invalid port keeps the positional-overload regression safe even if
    // the wrapper is reverted: native Node fails synchronously before I/O.
    captureBlocked(() => net.createConnection(-1, 'create.example.test'));

    const socket = new Socket();
    try {
      captureBlocked(() => socket.connect({
        host: 'socket.example.test',
        port: 443,
        lookup,
      }));
    } finally {
      socket.destroy();
    }

    captureBlocked(() => tls.connect({ host: 'tls.example.test', port: 443, lookup }));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects fetch string, URL, and Request inputs without leaking URL secrets', async () => {
    const secretUrl = 'https://user:super-secret@fetch.example.test/private?token=hidden';
    const secretError = await fetch(secretUrl, {
      signal: AbortSignal.abort(),
    }).then(
      () => null,
      (error: unknown) => error as Error & { code?: string },
    );

    expect(secretError).toMatchObject({ code: PUBLIC_NETWORK_BLOCKED_CODE });
    expect(secretError?.message).toContain('"fetch.example.test"');
    expect(secretError?.message).not.toContain('super-secret');
    expect(secretError?.message).not.toContain('/private');
    expect(secretError?.message).not.toContain('hidden');

    const inputs = [
      new URL('https://url.example.test/path?secret=yes'),
      new Request('https://request.example.test/path', {
        signal: AbortSignal.abort(),
      }),
    ];
    for (const input of inputs) {
      await expect(fetch(input, { signal: AbortSignal.abort() })).rejects.toMatchObject({
        code: PUBLIC_NETWORK_BLOCKED_CODE,
      });
    }
  });

  it('allows literal loopbacks and real loopback TCP/fetch traffic', async () => {
    for (const host of [
      undefined,
      'localhost',
      '127.0.0.1',
      '127.255.255.254',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::1]',
    ]) {
      expect(isLoopbackHost(host), `${String(host)} should be loopback`).toBe(true);
    }
    for (const host of ['LOCALHOST', '0.0.0.0', '10.0.0.1', 'example.test']) {
      expect(isLoopbackHost(host), `${host} should be blocked`).toBe(false);
    }

    const tcpServer = net.createServer((socket) => socket.end('ok'));
    const tcpPort = await listenTcp(tcpServer);
    const payload = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: tcpPort });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { data += chunk; });
      socket.once('end', () => resolve(data));
      socket.once('error', reject);
    });
    expect(payload).toBe('ok');
    await closeServer(tcpServer);

    const httpServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('loopback-ok');
    });
    const httpPort = await listenTcp(httpServer);
    const response = await fetch(`http://127.0.0.1:${httpPort}/probe`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('loopback-ok');
    await closeServer(httpServer);
  });

  it('preserves Unix-socket and Windows named-pipe string overloads', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agenc-network-tripwire-'));
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\agenc-tripwire-${process.pid}-${Date.now()}`
      : join(temp, 'test.sock');
    const server = net.createServer((socket) => socket.end('ipc-ok'));

    try {
      await listenIpc(server, endpoint);
      const payload = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        let data = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => { data += chunk; });
        socket.once('end', () => resolve(data));
        socket.once('error', reject);
      });
      expect(payload).toBe('ipc-ok');
      await closeServer(server);
    } finally {
      await closeServer(server);
      await rm(temp, { force: true, recursive: true });
    }
  });

  it('is idempotent and preloads itself into ordinary Node children', () => {
    const before = {
      createConnection: net.createConnection,
      fetch: globalThis.fetch,
      netConnect: net.connect,
      socketConnect: net.Socket.prototype.connect,
      tlsConnect: tls.connect,
    };
    const first = installNetworkTripwire();
    const second = installNetworkTripwire();

    expect(second).toBe(first);
    expect(net.connect).toBe(before.netConnect);
    expect(net.createConnection).toBe(before.createConnection);
    expect(net.Socket.prototype.connect).toBe(before.socketConnect);
    expect(tls.connect).toBe(before.tlsConnect);
    expect(globalThis.fetch).toBe(before.fetch);
    expect(process.env.NODE_OPTIONS).toContain('--import=file:');

    // An already-aborted signal guarantees no public request even if child
    // preloading regresses; the child then reports AbortError instead of the
    // tripwire's stable code and this assertion fails safely.
    const childOutput = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `fetch('https://child.example.test/secret?token=hidden', { signal: AbortSignal.abort() })
          .then(() => process.stdout.write('UNEXPECTED_SUCCESS'))
          .catch((error) => process.stdout.write(String(error.code ?? error.name)))`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(childOutput).toBe(PUBLIC_NETWORK_BLOCKED_CODE);
  });

  it('documents the guard as defense in depth rather than an OS boundary', () => {
    // UDP/direct DNS, native code, replaced child env, and loopback/IPC proxies
    // require an OS firewall/network namespace when hard egress isolation is
    // required. This contract deliberately covers the common JS APIs only.
    expect(PUBLIC_NETWORK_BLOCKED_CODE).toBe('AGENC_TEST_PUBLIC_NETWORK_BLOCKED');
  });
});
