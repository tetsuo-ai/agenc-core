import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns, { lookup as namedDnsLookup } from 'node:dns';
import dnsPromises, {
  lookup as namedDnsPromiseLookup,
} from 'node:dns/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { connect as namedNetConnect, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls, { connect as namedTlsConnect } from 'node:tls';
import { Worker } from 'node:worker_threads';
import { Agent, buildConnector, Dispatcher1Wrapper } from 'undici';
import WebSocketClient from 'ws';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeBlockedNetworkAttempt,
  installNetworkTripwire,
  isAllowedIpcPath,
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
    expect(consumeBlockedNetworkAttempt(error)).toBe(true);
    return error as Error & { code?: string };
  }
  throw new Error('expected the public-network tripwire to throw');
}

async function captureBlockedAsync(
  action: Promise<unknown>,
): Promise<Error & { code?: string }> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: PUBLIC_NETWORK_BLOCKED_CODE });
    expect(consumeBlockedNetworkAttempt(error)).toBe(true);
    return error as Error & { code?: string };
  }
  throw new Error('expected the public-network tripwire to reject');
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

    const secretHost = 'user:super-secret@raw.example.test/path?token=hidden';
    const secretError = captureBlocked(() => net.connect({
      host: secretHost,
      port: 443,
      lookup,
    }));
    expect(secretError.message).not.toContain('super-secret');
    expect(secretError.message).not.toContain('/path');
    expect(secretError.message).not.toContain('hidden');
  });

  it('guards DNS and UDP while preserving literal-loopback datagrams', async () => {
    expect(namedDnsLookup).toBe(dns.lookup);
    expect(namedDnsPromiseLookup).toBe(dnsPromises.lookup);

    const lookupCallback = vi.fn();
    const safeNegativeDnsName = 'dns-no-io.example.test';
    captureBlocked(() => dns.lookup(
      safeNegativeDnsName,
      { family: 999 as 4 },
      lookupCallback,
    ));
    captureBlocked(() => dns.resolve4(
      safeNegativeDnsName,
      123 as never,
    ));
    captureBlocked(() => new dns.Resolver().resolve4(
      safeNegativeDnsName,
      123 as never,
    ));
    await captureBlockedAsync(
      dnsPromises.lookup(safeNegativeDnsName, { family: 999 as 4 }),
    );
    const loopbackPromiseResolver = new dnsPromises.Resolver();
    loopbackPromiseResolver.setServers(['127.0.0.1:9']);
    await captureBlockedAsync(
      loopbackPromiseResolver.resolve4(safeNegativeDnsName),
    );
    if (typeof dns.resolveTlsa === 'function') {
      captureBlocked(() => dns.resolveTlsa(
        safeNegativeDnsName,
        123 as never,
      ));
    }
    if (typeof dnsPromises.resolveTlsa === 'function') {
      await captureBlockedAsync(dnsPromises.resolveTlsa(
        Symbol('invalid-no-io-hostname') as unknown as string,
      ));
      const resolver = new dnsPromises.Resolver();
      resolver.setServers(['127.0.0.1:9']);
      await captureBlockedAsync(resolver.resolveTlsa(
        Symbol('invalid-no-io-hostname') as unknown as string,
      ));
    }
    expect(lookupCallback).not.toHaveBeenCalled();

    await expect(dnsPromises.lookup('localhost')).resolves.toEqual({
      address: '127.0.0.1',
      family: 4,
    });
    await expect(dnsPromises.lookup('localhost', {
      all: true,
      family: 6,
    })).resolves.toEqual([{ address: '::1', family: 6 }]);
    await new Promise<void>((resolve, reject) => {
      dns.lookup('localhost', { family: 4 }, (error, address, family) => {
        if (error) return reject(error);
        try {
          expect(address).toBe('127.0.0.1');
          expect(family).toBe(4);
          resolve();
        } catch (assertionError) {
          reject(assertionError);
        }
      });
    });

    const poisonedDgramLookup = vi.fn(() => {
      throw new Error('custom dgram lookup must not run');
    });
    captureBlocked(() => dgram.createSocket({
      type: 'udp4',
      lookup: poisonedDgramLookup,
    }));
    captureBlocked(() => new dgram.Socket({
      type: 'udp4',
      lookup: poisonedDgramLookup,
    }));
    expect(poisonedDgramLookup).not.toHaveBeenCalled();

    const blockedSocket = dgram.createSocket('udp4');
    try {
      // Numeric non-local bind can only reach the kernel's local bind check if
      // the guard is reverted; it cannot resolve a hostname or emit a packet.
      captureBlocked(() => blockedSocket.bind(0, '198.51.100.10'));
      captureBlocked(() => blockedSocket.connect(-1, '198.51.100.10'));
      captureBlocked(() => blockedSocket.send(
        Buffer.from('blocked'),
        -1,
        '198.51.100.10',
      ));
    } finally {
      blockedSocket.close();
    }

    // A closed socket makes every native membership fallback fail before it
    // can join/leave a group or emit IGMP/MLD if the guard is reverted.
    const membershipSocket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      membershipSocket.bind(0, '127.0.0.1', error => {
        if (error) reject(error);
        else membershipSocket.close(resolve);
      });
    });
    captureBlocked(() => membershipSocket.addMembership('239.255.0.1'));
    captureBlocked(() => membershipSocket.dropMembership('239.255.0.1'));
    captureBlocked(() => membershipSocket.addSourceSpecificMembership(
      '198.51.100.2',
      '232.0.0.1',
    ));
    captureBlocked(() => membershipSocket.dropSourceSpecificMembership(
      '198.51.100.2',
      '232.0.0.1',
    ));

    const server = dgram.createSocket('udp4');
    const client = dgram.createSocket('udp4');
    const connectedClient = dgram.createSocket('udp4');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.bind(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (typeof address === 'string') throw new Error('expected UDP address');
      const received = new Promise<string>((resolve, reject) => {
        server.once('error', reject);
        server.once('message', message => resolve(message.toString('utf8')));
      });
      await new Promise<void>((resolve, reject) => {
        client.send(
          Buffer.from('udp-loopback-ok'),
          address.port,
          error => error === null ? resolve() : reject(error),
        );
      });
      await expect(received).resolves.toBe('udp-loopback-ok');
      const receivedWithNullAddress = new Promise<string>((resolve, reject) => {
        server.once('error', reject);
        server.once('message', message => resolve(message.toString('utf8')));
      });
      await new Promise<void>((resolve, reject) => {
        client.send(
          Buffer.from('udp-null-address-ok'),
          address.port,
          null,
          error => error === null ? resolve() : reject(error),
        );
      });
      await expect(receivedWithNullAddress).resolves.toBe('udp-null-address-ok');
      await new Promise<void>((resolve, reject) => {
        connectedClient.connect(
          address.port,
          error => error === undefined ? resolve() : reject(error),
        );
      });
    } finally {
      connectedClient.close();
      client.close();
      server.close();
    }
  });

  it('guards HTTP, HTTPS, and WebSocket clients before lookup', async () => {
    const lookup = vi.fn(() => {
      throw Object.assign(new Error('lookup should not run'), {
        code: 'LOOKUP_CALLED',
      });
    });

    captureBlocked(() => http.get({
      host: 'http.example.test',
      port: 80,
      lookup,
    }));
    captureBlocked(() => https.get({
      host: 'https.example.test',
      port: 443,
      lookup,
    }));
    let wsClient: WebSocketClient | undefined;
    const wsError = await new Promise<unknown>((resolve) => {
      try {
        wsClient = new WebSocketClient('wss://ws-package.example.test', {
          lookup,
        });
        wsClient.once('error', resolve);
      } catch (error) {
        resolve(error);
      }
    });
    wsClient?.terminate();
    expect(wsError).toMatchObject({ code: PUBLIC_NETWORK_BLOCKED_CODE });
    expect(consumeBlockedNetworkAttempt(wsError)).toBe(true);
    captureBlocked(() => new globalThis.WebSocket(
      'wss://global-websocket.example.test/private?token=hidden',
      ['duplicate', 'duplicate'],
    ));
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
    expect(consumeBlockedNetworkAttempt(secretError)).toBe(true);
    expect(secretError?.message).not.toContain('fetch.example.test');
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
      await captureBlockedAsync(fetch(input, { signal: AbortSignal.abort() }));
    }

    await captureBlockedAsync(fetch({
      toString: () => 'https://coercible.example.test/path',
    } as unknown as string, {
      signal: AbortSignal.abort(),
    }));

    class SpoofedRequest extends Request {
      override get url(): string {
        return 'http://127.0.0.1/';
      }
    }
    await captureBlockedAsync(fetch(
      new SpoofedRequest('https://request-brand.example.test/private'),
      { signal: AbortSignal.abort() },
    ));

    class SpoofedUrl extends URL {
      override get hostname(): string {
        return '127.0.0.1';
      }
    }
    await captureBlockedAsync(fetch(
      new SpoofedUrl('https://url-brand.example.test/private'),
      { signal: AbortSignal.abort() },
    ));

    const hostnameDescriptor = Object.getOwnPropertyDescriptor(
      URL.prototype,
      'hostname',
    );
    if (hostnameDescriptor?.get === undefined) {
      throw new Error('URL.prototype.hostname getter is unavailable');
    }
    let hostnameReads = 0;
    try {
      Object.defineProperty(URL.prototype, 'hostname', {
        ...hostnameDescriptor,
        get() {
          hostnameReads += 1;
          return hostnameReads === 1
            ? '127.0.0.1'
            : Reflect.apply(hostnameDescriptor.get as () => string, this, []);
        },
      });
      await captureBlockedAsync(fetch('https://prototype-bypass.example.test/private', {
        signal: AbortSignal.abort(),
      }));
      expect(hostnameReads).toBe(0);
    } finally {
      Object.defineProperty(URL.prototype, 'hostname', hostnameDescriptor);
    }

    const malformedSecret = 'https://user:malformed-secret@';
    const malformedError = await fetch(malformedSecret).then(
      () => null,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(malformedError).toMatchObject({ code: PUBLIC_NETWORK_BLOCKED_CODE });
    expect(consumeBlockedNetworkAttempt(malformedError)).toBe(true);
    expect(malformedError?.message).not.toContain('malformed-secret');

    const malformedWebSocketError = captureBlocked(
      () => new globalThis.WebSocket('wss://user:malformed-ws-secret@'),
    );
    expect(malformedWebSocketError.message).not.toContain('malformed-ws-secret');
  });

  it('canonicalizes stateful fetch and WebSocket inputs exactly once', async () => {
    let fetchCoercions = 0;
    const fetchInput = {
      toString() {
        fetchCoercions += 1;
        return fetchCoercions === 1
          ? 'http://127.0.0.1:1/safe'
          : 'https://stateful-fetch.example.test/unsafe';
      },
    };
    await expect(fetch(fetchInput as unknown as string, {
      signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchCoercions).toBe(1);

    let webSocketCoercions = 0;
    const webSocketInput = {
      toString() {
        webSocketCoercions += 1;
        return webSocketCoercions === 1
          ? 'ws://127.0.0.1:1/safe'
          : 'not a valid websocket URL';
      },
    };
    const socket = new globalThis.WebSocket(webSocketInput as unknown as string);
    socket.addEventListener('error', () => {});
    socket.close();
    expect(webSocketCoercions).toBe(1);
  });

  it('never follows a loopback fetch redirect onto the public network', async () => {
    const redirectTarget = 'https://redirect-bypass.example.test/private';
    const httpServer = http.createServer((_request, response) => {
      response.writeHead(302, { location: redirectTarget });
      response.end();
    });
    const httpPort = await listenTcp(httpServer);
    const nativeConnect = buildConnector({});
    const dispatchedHosts: string[] = [];
    const agent = new Agent({
      connect(options, callback) {
        dispatchedHosts.push(options.hostname);
        if (!isLoopbackHost(options.hostname)) {
          callback(new Error('public redirect reached the dispatcher'), null);
          return;
        }
        nativeConnect(options, callback);
      },
    });
    // Node's built-in fetch currently consumes Undici's legacy dispatcher
    // handler contract; the v8 wrapper adapts this v8 Agent without changing
    // the connection-level observation below.
    const dispatcher = new Dispatcher1Wrapper(agent);

    try {
      // A caller cannot weaken the guard with `follow`. The custom connector
      // makes this regression safe if the override disappears: it records and
      // rejects the public origin before DNS or socket I/O.
      const response = await fetch(`http://127.0.0.1:${httpPort}/redirect`, {
        dispatcher,
        redirect: 'follow',
      } as RequestInit & { dispatcher: Dispatcher1Wrapper });

      expect(response.status).toBe(302);
      expect(response.redirected).toBe(false);
      expect(response.headers.get('location')).toBe(redirectTarget);
      expect(dispatchedHosts).toEqual(['127.0.0.1']);
    } finally {
      await dispatcher.close();
      await closeServer(httpServer);
    }
  });

  it('snapshots stateful Socket.connect destination accessors once', () => {
    const lookup = vi.fn(() => {
      throw Object.assign(new Error('lookup should not run'), {
        code: 'LOOKUP_CALLED',
      });
    });
    let hostReads = 0;
    const options = {
      get host() {
        hostReads += 1;
        return hostReads === 1
          ? '127.0.0.1'
          : 'getter-bypass.example.test';
      },
      lookup,
      port: 1,
    };
    const socket = new Socket();
    socket.on('error', () => {});
    try {
      expect(() => socket.connect(options)).not.toThrow();
      expect(hostReads).toBe(1);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
    }
  });

  it('allows literal loopbacks and real loopback TCP/fetch traffic', async () => {
    for (const host of [
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
    for (const host of [
      undefined,
      'localhost',
      'LOCALHOST',
      '0.0.0.0',
      '10.0.0.1',
      'example.test',
    ]) {
      expect(isLoopbackHost(host), `${host} should be blocked`).toBe(false);
    }

    const poisonedLookup = vi.fn(() => {
      throw Object.assign(new Error('lookup should not run'), {
        code: 'LOOKUP_CALLED',
      });
    });
    captureBlocked(() => net.connect({
      host: 'localhost',
      port: 443,
      lookup: poisonedLookup,
    }));
    expect(poisonedLookup).not.toHaveBeenCalled();

    let bracketError: Error & { code?: string } | undefined;
    try {
      net.connect({ host: '[::1]', port: -1, lookup: poisonedLookup });
    } catch (error) {
      bracketError = error as Error & { code?: string };
    }
    expect(bracketError).toBeInstanceOf(Error);
    expect(bracketError?.code).not.toBe(PUBLIC_NETWORK_BLOCKED_CODE);
    expect(poisonedLookup).not.toHaveBeenCalled();
    captureBlocked(() => net.connect({
      host: '[[::1]]',
      port: -1,
      lookup: poisonedLookup,
    }));
    expect(poisonedLookup).not.toHaveBeenCalled();

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
    expect(isAllowedIpcPath('\\\\.\\pipe\\agenc-local', 'win32')).toBe(true);
    expect(isAllowedIpcPath('\\\\?\\pipe\\agenc-local', 'win32')).toBe(true);
    expect(isAllowedIpcPath('\\\\server\\pipe\\agenc-remote', 'win32')).toBe(false);
    expect(isAllowedIpcPath('/tmp/agenc-local.sock', 'linux')).toBe(true);

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
    expect(process.env.NODE_OPTIONS).toContain('--require');
    expect(process.env.NODE_OPTIONS).toContain('network-tripwire.cjs');

    const clobberedConnect = vi.fn() as unknown as typeof net.connect;
    try {
      net.connect = clobberedConnect;
      installNetworkTripwire();
      expect(net.connect).toBe(before.netConnect);
    } finally {
      net.connect = before.netConnect;
      installNetworkTripwire();
    }

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
          .catch((error) => {
            globalThis[Symbol.for('agenc.test.public-network-tripwire.consume-attempt')](error);
            process.stdout.write(String(error.code ?? error.name));
          })`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(childOutput).toBe(PUBLIC_NETWORK_BLOCKED_CODE);
  });

  it('preloads the guard synchronously into CommonJS eval Workers', async () => {
    const source = `
      const net = require('node:net');
      const { parentPort } = require('node:worker_threads');
      try {
        net.connect({
          host: 'worker.example.test',
          port: 443,
          lookup() {
            throw Object.assign(new Error('lookup should not run'), {
              code: 'LOOKUP_CALLED',
            });
          },
        });
      } catch (error) {
        globalThis[Symbol.for('agenc.test.public-network-tripwire.consume-attempt')](error);
        parentPort.postMessage(error.code);
      }
    `;
    const worker = new Worker(source, { eval: true, execArgv: [] });
    try {
      const code = await new Promise<string>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      expect(code).toBe(PUBLIC_NETWORK_BLOCKED_CODE);
    } finally {
      await worker.terminate();
    }
  });

  it('documents the guard as defense in depth rather than an OS boundary', () => {
    // UDP/direct DNS, native code, replaced child env, and loopback/IPC proxies
    // require an OS firewall/network namespace when hard egress isolation is
    // required. This contract deliberately covers the common JS APIs only.
    expect(PUBLIC_NETWORK_BLOCKED_CODE).toBe('AGENC_TEST_PUBLIC_NETWORK_BLOCKED');
  });
});
