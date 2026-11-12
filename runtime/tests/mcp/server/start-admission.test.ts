import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../../src/config/home.js";
import {
  prepareMcpSseServerReconfigurationFromConfig,
  resolveMcpServeDefaults,
  startMcpServerFromConfig,
  startMcpSseServe,
  type StartedMcpSseServer,
} from "../../../src/mcp/server/start.js";
import {
  getSecureStorage,
  type SecureStorage,
} from "../../../src/utils/secureStorage/index.js";
import { readNativeSecureStorage } from "../../../src/utils/secureStorage/native.js";
import { SecureStorageUnavailableError } from "../../../src/utils/secureStorage/unavailable.js";
import { createTempWorkspaceFixture } from "../../helpers/temp-workspace.js";

const fixture = createTempWorkspaceFixture("agenc-mcp-sse-admission-");
const getSecureStorageMock = vi.mocked(getSecureStorage);
const hermeticStorageFactory = getSecureStorageMock.getMockImplementation();
const startedServers: StartedMcpSseServer[] = [];

const LOOPBACK = { transport: "sse", host: "127.0.0.1", port: 0 } as const;

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.close()));
  if (!hermeticStorageFactory) {
    throw new Error("Expected the hermetic secure-storage mock");
  }
  getSecureStorageMock.mockImplementation(hermeticStorageFactory);
  await fixture.cleanup();
});

function track(server: StartedMcpSseServer): StartedMcpSseServer {
  startedServers.push(server);
  return server;
}

/** A host with no native backend: reads report absence, writes are refused. */
function absentBackend(): SecureStorage {
  const unavailable = (): never => {
    throw new SecureStorageUnavailableError(
      "Secret Service is unavailable: no session message bus",
    );
  };
  return {
    name: "absent-libsecret",
    read: unavailable,
    readFresh: unavailable,
    readAsync: async () => unavailable(),
    update: () => ({ success: false, warning: "no backend" }),
    delete: () => true,
  };
}

function storedToken(home: string): string | undefined {
  return readNativeSecureStorage(resolveHomeContext({ AGENC_HOME: home }))
    .mcpServer?.token;
}

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (address === null || typeof address === "string") {
    probe.close();
    throw new Error("failed to allocate a loopback test port");
  }
  probe.close();
  await once(probe, "close");
  return address.port;
}

interface McpReply {
  readonly status: number;
  readonly session: string | null;
  readonly challenge: string | null;
  readonly text: string;
}

async function post(
  url: string,
  body: unknown,
  options: {
    readonly token?: string;
    readonly session?: string;
    readonly origin?: string;
  } = {},
): Promise<McpReply> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...(options.session === undefined
        ? {}
        : { "mcp-session-id": options.session }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    session: response.headers.get("mcp-session-id"),
    challenge: response.headers.get("www-authenticate"),
    text: await response.text(),
  };
}

function initialize(
  url: string,
  options: Parameters<typeof post>[2] = {},
): Promise<McpReply> {
  return post(url, { jsonrpc: "2.0", id: 1, method: "initialize" }, options);
}

describe("MCP SSE server start: bearer token", () => {
  test("serves memory and instruction files only to a client that sends the token", async () => {
    const home = await fixture.create();
    const workspace = await fixture.create();
    await writeFile(
      join(workspace, "AGENC.md"),
      "# Project instructions\nDeploy key lives at secret path kv/deploy.\n",
    );
    await mkdir(join(workspace, ".agenc", "memory"), { recursive: true });
    await writeFile(
      join(workspace, ".agenc", "memory", "MEMORY.md"),
      "- staging database is db-staging.internal\n",
    );

    const started = track(
      await startMcpSseServe(LOOPBACK, {
        cwd: workspace,
        environment: { AGENC_HOME: home },
      }),
    );

    // The issue's probe: a plain HTTP client that sends no credential.
    const refused = await initialize(started.url);
    expect(refused.status).toBe(401);
    expect(refused.challenge).toBe("Bearer");
    expect(refused.session).toBeNull();
    const refusedList = await post(started.url, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
    });
    expect(refusedList.status).toBe(401);
    expect(refusedList.text).not.toContain("agenc-memory://");
    expect(refusedList.text).not.toContain("agenc-instructions://");

    const token = storedToken(home);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(refused.text).not.toContain(token);

    const admitted = await initialize(started.url, { token });
    expect(admitted.status).toBe(200);
    const session = admitted.session ?? undefined;
    expect(session).toEqual(expect.any(String));
    const list = await post(
      started.url,
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
      { token, session },
    );
    expect(list.status).toBe(200);
    const uris = [...list.text.matchAll(/"uri":"([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(uris).toEqual([
      "agenc-memory://0/MEMORY.md",
      "agenc-instructions://0/AGENC.md",
    ]);
    const memory = await post(
      started.url,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "agenc-memory://0/MEMORY.md" },
      },
      { token, session },
    );
    expect(memory.status).toBe(200);
    expect(memory.text).toContain("staging database is db-staging.internal");

    // The session id is not a credential.
    const sessionOnly = await post(
      started.url,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: "agenc-instructions://0/AGENC.md" },
      },
      { session },
    );
    expect(sessionOnly.status).toBe(401);
    expect(sessionOnly.text).not.toContain("Deploy key");
  });

  test("an explicit environment token wins and nothing is stored", async () => {
    const home = await fixture.create();
    const explicit = "explicit-environment-token-0123";
    const started = track(
      await startMcpSseServe(LOOPBACK, {
        cwd: await fixture.create(),
        environment: { AGENC_HOME: home, AGENC_MCP_SERVER_TOKEN: explicit },
      }),
    );

    await expect(initialize(started.url, { token: explicit })).resolves.toMatchObject(
      { status: 200 },
    );
    await expect(
      initialize(started.url, { token: `${explicit}x` }),
    ).resolves.toMatchObject({ status: 401 });
    expect(storedToken(home)).toBeUndefined();
  });

  test("an environment token shorter than 16 characters is ignored", async () => {
    const home = await fixture.create();
    const short = "only-15-chars!!";
    expect(short).toHaveLength(15);
    const started = track(
      await startMcpSseServe(LOOPBACK, {
        cwd: await fixture.create(),
        environment: { AGENC_HOME: home, AGENC_MCP_SERVER_TOKEN: short },
      }),
    );

    await expect(initialize(started.url, { token: short })).resolves.toMatchObject(
      { status: 401 },
    );
    const generated = storedToken(home);
    expect(generated).toEqual(expect.any(String));
    expect(generated).not.toBe(short);
    await expect(
      initialize(started.url, { token: generated }),
    ).resolves.toMatchObject({ status: 200 });
  });

  test("keeps one generated token per home across restarts", async () => {
    const home = await fixture.create();
    const otherHome = await fixture.create();
    const workspace = await fixture.create();

    const first = await startMcpSseServe(LOOPBACK, {
      cwd: workspace,
      environment: { AGENC_HOME: home },
    });
    const token = storedToken(home);
    await first.close();

    const restarted = track(
      await startMcpSseServe(LOOPBACK, {
        cwd: workspace,
        environment: { AGENC_HOME: home },
      }),
    );
    expect(storedToken(home)).toBe(token);
    await expect(initialize(restarted.url, { token })).resolves.toMatchObject({
      status: 200,
    });

    const other = track(
      await startMcpSseServe(LOOPBACK, {
        cwd: workspace,
        environment: { AGENC_HOME: otherHome },
      }),
    );
    expect(storedToken(otherHome)).not.toBe(token);
    await expect(initialize(other.url, { token })).resolves.toMatchObject({
      status: 401,
    });
  });

  test("an already-resolved token is used as given and resolves nothing", async () => {
    const home = await fixture.create();
    const started = track(
      await startMcpSseServe(LOOPBACK, {
        cwd: await fixture.create(),
        token: "caller-resolved-token-0123456789",
        environment: {
          AGENC_HOME: home,
          AGENC_MCP_SERVER_TOKEN: "environment-token-not-consulted",
        },
      }),
    );

    await expect(
      initialize(started.url, { token: "caller-resolved-token-0123456789" }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      initialize(started.url, { token: "environment-token-not-consulted" }),
    ).resolves.toMatchObject({ status: 401 });
    expect(storedToken(home)).toBeUndefined();
    await expect(
      startMcpSseServe(LOOPBACK, { cwd: await fixture.create(), token: "" }),
    ).rejects.toThrow("requires a non-empty bearer token");
  });

  test("does not start without native secure storage and without an environment token", async () => {
    const home = await fixture.create();
    const workspace = await fixture.create();
    const port = await freeLoopbackPort();
    const command = { transport: "sse", host: "127.0.0.1", port } as const;
    getSecureStorageMock.mockReturnValue(absentBackend());

    for (const environment of [
      { AGENC_HOME: home },
      { AGENC_HOME: home, AGENC_MCP_SERVER_TOKEN: "too-short" },
    ]) {
      const failure = await startMcpSseServe(command, {
        cwd: workspace,
        environment,
      }).then(
        (server) => {
          track(server);
          return null;
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("AGENC_MCP_SERVER_TOKEN");
      expect((failure as Error).message).toContain("at least 16 characters");
      // Nothing was bound: the port still refuses connections.
      await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow();
    }

    await expect(
      startMcpServerFromConfig(
        {
          mcp: {
            server: {
              enabled: true,
              transport: "sse",
              host: "127.0.0.1",
              port,
              workspace,
            },
          },
        },
        { environment: { AGENC_HOME: home } },
      ),
    ).rejects.toThrow("AGENC_MCP_SERVER_TOKEN");
    await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow();

    // The same host starts once the variable carries a real token.
    const explicit = "explicit-environment-token-0123";
    const started = track(
      await startMcpSseServe(command, {
        cwd: workspace,
        environment: { AGENC_HOME: home, AGENC_MCP_SERVER_TOKEN: explicit },
      }),
    );
    await expect(initialize(started.url, { token: explicit })).resolves.toMatchObject(
      { status: 200 },
    );
  });
});

describe("MCP SSE server start: allowed origins", () => {
  const token = "allowed-origins-test-token-0123";
  const viteOrigin = "http://localhost:5173";
  const appOrigin = "https://app.example";

  function configFor(workspace: string, allowedOrigins?: readonly string[]) {
    return {
      mcp: {
        server: {
          enabled: true as const,
          transport: "sse" as const,
          host: "127.0.0.1",
          port: 0,
          workspace,
          ...(allowedOrigins === undefined
            ? {}
            : { allowed_origins: allowedOrigins }),
        },
      },
    };
  }

  test("resolves the configured list and omits it when empty or malformed", () => {
    expect(
      resolveMcpServeDefaults({
        allowed_origins: [viteOrigin, appOrigin, viteOrigin],
      }),
    ).toEqual({
      enabled: false,
      transport: "stdio",
      host: "127.0.0.1",
      port: 3334,
      allowedOrigins: [viteOrigin, appOrigin],
    });
    for (const allowed_origins of [
      undefined,
      [],
      "http://localhost:5173",
      ["*"],
      ["http://localhost:5173/", "null", 5173],
    ]) {
      expect(
        resolveMcpServeDefaults({ allowed_origins } as never),
      ).not.toHaveProperty("allowedOrigins");
    }
    // A malformed raw entry is dropped; it never widens the list.
    expect(
      resolveMcpServeDefaults({
        allowed_origins: ["*", viteOrigin, "http://LOCALHOST:5173"],
      }).allowedOrigins,
    ).toEqual([viteOrigin]);
  });

  test("refuses a localhost origin by default and admits it once configured", async () => {
    const workspace = await fixture.create();
    const closed = await startMcpServerFromConfig(configFor(workspace), { token });
    const open = await startMcpServerFromConfig(
      configFor(workspace, [viteOrigin]),
      { token },
    );
    if (closed.kind !== "started" || open.kind !== "started") {
      throw new Error("expected both servers to start");
    }
    track(closed.server);
    track(open.server);

    await expect(
      initialize(closed.server.url, { token, origin: viteOrigin }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(initialize(closed.server.url, { token })).resolves.toMatchObject({
      status: 200,
    });

    await expect(
      initialize(open.server.url, { token, origin: viteOrigin }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      initialize(open.server.url, { token, origin: appOrigin }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      initialize(open.server.url, { token, origin: "https://attacker.example" }),
    ).resolves.toMatchObject({ status: 403 });
    // A configured origin is not a credential.
    await expect(
      initialize(open.server.url, { origin: viteOrigin }),
    ).resolves.toMatchObject({ status: 401 });
  });

  test("a reload that changes the list applies it to the live listener", async () => {
    const workspace = await fixture.create();
    const result = await startMcpServerFromConfig(
      configFor(workspace, [viteOrigin]),
      { token },
    );
    if (result.kind !== "started") throw new Error("expected a started server");
    const server = track(result.server);

    const session = (await initialize(server.url, { token, origin: viteOrigin }))
      .session;
    expect(session).toEqual(expect.any(String));

    // A list with an invalid entry is refused while it is prepared, so the
    // listener keeps the list it had.
    expect(() => server.prepareAllowedOriginsReplacement(["*"])).toThrow(
      "allowed origin",
    );
    await expect(
      initialize(server.url, { token, origin: viteOrigin }),
    ).resolves.toMatchObject({ status: 200 });

    const swapped = await prepareMcpSseServerReconfigurationFromConfig(
      server,
      configFor(workspace, [appOrigin]),
    );
    expect(swapped.defaults.allowedOrigins).toEqual([appOrigin]);
    expect(swapped.apply()).toBe(2);
    await expect(
      initialize(server.url, { token, origin: viteOrigin }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      initialize(server.url, { token, origin: appOrigin }),
    ).resolves.toMatchObject({ status: 200 });

    const cleared = await prepareMcpSseServerReconfigurationFromConfig(
      server,
      configFor(workspace),
    );
    expect(cleared.defaults).not.toHaveProperty("allowedOrigins");
    expect(cleared.apply()).toBe(1);
    await expect(
      initialize(server.url, { token, origin: appOrigin }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(initialize(server.url, { token })).resolves.toMatchObject({
      status: 200,
    });
  });
});
