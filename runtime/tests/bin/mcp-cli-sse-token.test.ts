import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

// Foreground serve returns only an exit code, so the listeners it opens are
// tracked through the real start function and closed after each case.
const tracked = vi.hoisted(() => ({
  servers: [] as Array<{ close(): Promise<void> }>,
}));

vi.mock("../../src/mcp/server/start.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/mcp/server/start.js")>();
  return {
    ...actual,
    startMcpSseServe: async (
      ...args: Parameters<typeof actual.startMcpSseServe>
    ) => {
      const server = await actual.startMcpSseServe(...args);
      tracked.servers.push(server);
      return server;
    },
  };
});

import {
  formatAgenCMcpCliHelpText,
  parseAgenCMcpCliArgs,
  parseMcpServeArgs,
  runAgenCMcpCli,
  type AgenCMcpCliIo,
} from "../../src/bin/mcp-cli.js";
import { resolveHomeContext } from "../../src/config/home.js";
import {
  getSecureStorage,
  type SecureStorage,
} from "../../src/utils/secureStorage/index.js";
import { readNativeSecureStorage } from "../../src/utils/secureStorage/native.js";
import { SecureStorageUnavailableError } from "../../src/utils/secureStorage/unavailable.js";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";

const fixture = createTempWorkspaceFixture("agenc-mcp-cli-sse-token-");
const getSecureStorageMock = vi.mocked(getSecureStorage);
const hermeticStorageFactory = getSecureStorageMock.getMockImplementation();

const SERVE_SSE = {
  kind: "serve",
  transport: "sse",
  host: "127.0.0.1",
  port: 0,
} as const;

afterEach(async () => {
  await Promise.all(tracked.servers.splice(0).map((server) => server.close()));
  if (!hermeticStorageFactory) {
    throw new Error("Expected the hermetic secure-storage mock");
  }
  getSecureStorageMock.mockImplementation(hermeticStorageFactory);
  await fixture.cleanup();
});

function capture(): {
  readonly io: AgenCMcpCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  const sink = (append: (chunk: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  return {
    io: {
      stdin: Readable.from([]),
      stdout: sink((chunk) => (stdout += chunk)),
      stderr: sink((chunk) => (stderr += chunk)),
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function storedToken(home: string): string | undefined {
  return readNativeSecureStorage(resolveHomeContext({ AGENC_HOME: home }))
    .mcpServer?.token;
}

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

async function initializeStatus(url: string, token?: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  await response.text();
  return response.status;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("agenc mcp serve --transport sse: bearer token", () => {
  test("prints the generated token once, after the URL line and on the same stream", async () => {
    const home = await fixture.create();
    const output = capture();

    await expect(
      runAgenCMcpCli(SERVE_SSE, {
        io: output.io,
        cwd: await fixture.create(),
        environment: { AGENC_HOME: home },
        waitForClose: false,
      }),
    ).resolves.toBe(0);

    const token = storedToken(home);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    const lines = output.stderr().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(
      /^AgenC MCP server listening on http:\/\/127\.0\.0\.1:\d+\/mcp$/u,
    );
    expect(lines[1]).toBe(`AgenC MCP server token: ${token}`);
    expect(lines[2]).toBe(
      "Clients must send it with every request, for example: Authorization: Bearer <token>",
    );
    expect(lines[3]).toBe("");
    expect(occurrences(output.stderr(), token!)).toBe(1);
    expect(output.stdout()).toBe("");

    const url = lines[0]!.slice("AgenC MCP server listening on ".length);
    await expect(initializeStatus(url)).resolves.toBe(401);
    await expect(initializeStatus(url, token)).resolves.toBe(200);
  });

  test("prints an explicit environment token and stores nothing", async () => {
    const home = await fixture.create();
    const explicit = "explicit-environment-token-0123";
    const output = capture();

    await expect(
      runAgenCMcpCli(SERVE_SSE, {
        io: output.io,
        cwd: await fixture.create(),
        environment: { AGENC_HOME: home, AGENC_MCP_SERVER_TOKEN: explicit },
        waitForClose: false,
      }),
    ).resolves.toBe(0);

    expect(output.stderr()).toContain(`AgenC MCP server token: ${explicit}\n`);
    expect(occurrences(output.stderr(), explicit)).toBe(1);
    expect(storedToken(home)).toBeUndefined();
    const url = /listening on (\S+)/u.exec(output.stderr())![1]!;
    await expect(initializeStatus(url, explicit)).resolves.toBe(200);
  });

  test("passes the configured origins to the listener", async () => {
    const home = await fixture.create();
    const output = capture();
    const command = parseAgenCMcpCliArgs(["mcp", "serve"], {
      mcp: {
        server: {
          transport: "sse",
          port: 0,
          allowed_origins: ["http://localhost:5173"],
        },
      },
    });
    expect(command).toEqual({
      ...SERVE_SSE,
      allowedOrigins: ["http://localhost:5173"],
    });
    if (command?.kind !== "serve") throw new Error("expected a serve command");

    await expect(
      runAgenCMcpCli(command, {
        io: output.io,
        cwd: await fixture.create(),
        environment: { AGENC_HOME: home },
        waitForClose: false,
      }),
    ).resolves.toBe(0);

    const url = /listening on (\S+)/u.exec(output.stderr())![1]!;
    const attempt = async (origin: string): Promise<number> => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${storedToken(home)}`,
          origin,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      await response.text();
      return response.status;
    };
    await expect(attempt("http://localhost:5173")).resolves.toBe(200);
    await expect(attempt("http://localhost:5174")).resolves.toBe(403);
  });

  test("does not start, and names the variable, without storage and without an environment token", async () => {
    const home = await fixture.create();
    getSecureStorageMock.mockReturnValue(absentBackend());
    const output = capture();

    await expect(
      runAgenCMcpCli(SERVE_SSE, {
        io: output.io,
        cwd: await fixture.create(),
        environment: { AGENC_HOME: home },
        waitForClose: false,
      }),
    ).resolves.toBe(1);

    expect(output.stderr()).toMatch(
      /^agenc: MCP SSE server has no bearer token: set AGENC_MCP_SERVER_TOKEN to at least 16 characters/u,
    );
    expect(output.stderr()).not.toContain("listening on");
    expect(output.stdout()).toBe("");
    expect(tracked.servers).toHaveLength(0);
  });

  test("the stdio transport neither needs nor creates a token", async () => {
    const home = await fixture.create();
    getSecureStorageMock.mockReturnValue(absentBackend());
    const output = capture();

    await expect(
      runAgenCMcpCli(
        { kind: "serve", transport: "stdio", host: "127.0.0.1", port: 3334 },
        {
          io: output.io,
          cwd: await fixture.create(),
          environment: { AGENC_HOME: home },
        },
      ),
    ).resolves.toBe(0);

    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("");
    expect(tracked.servers).toHaveLength(0);
  });
});

describe("agenc mcp serve --print-token", () => {
  test("parses the flag wherever it appears and documents it", () => {
    expect(parseAgenCMcpCliArgs(["mcp", "serve", "--print-token"])).toEqual({
      kind: "serve-token",
    });
    expect(
      parseMcpServeArgs(["--transport", "sse", "--print-token"]),
    ).toEqual({ kind: "serve-token" });
    expect(
      parseMcpServeArgs(["--print-token", "--transport=stdio"]),
    ).toEqual({ kind: "serve-token" });
    expect(parseMcpServeArgs(["--print-token", "--port", "1"])).toEqual({
      kind: "error",
      message: "mcp serve only accepts --transport",
    });
    expect(parseMcpServeArgs(["--print-token=1"])).toEqual({
      kind: "error",
      message: "mcp serve does not accept argument '--print-token=1'",
    });
    expect(formatAgenCMcpCliHelpText()).toContain("serve --print-token");
  });

  test("prints the token a server bound to the same home accepts, and nothing else", async () => {
    const home = await fixture.create();
    const printed = capture();

    await expect(
      runAgenCMcpCli(
        { kind: "serve-token" },
        { io: printed.io, environment: { AGENC_HOME: home } },
      ),
    ).resolves.toBe(0);

    const token = storedToken(home);
    expect(token).toEqual(expect.any(String));
    expect(printed.stdout()).toBe(`${token}\n`);
    expect(printed.stderr()).toBe("");
    expect(tracked.servers).toHaveLength(0);

    // A server started afterwards for this home, as the daemon does, uses it.
    const served = capture();
    await expect(
      runAgenCMcpCli(SERVE_SSE, {
        io: served.io,
        cwd: await fixture.create(),
        environment: { AGENC_HOME: home },
        waitForClose: false,
      }),
    ).resolves.toBe(0);
    const url = /listening on (\S+)/u.exec(served.stderr())![1]!;
    await expect(initializeStatus(url, token)).resolves.toBe(200);

    const again = capture();
    await runAgenCMcpCli(
      { kind: "serve-token" },
      { io: again.io, environment: { AGENC_HOME: home } },
    );
    expect(again.stdout()).toBe(`${token}\n`);
  });

  test("prints an explicit environment token without storing it", async () => {
    const home = await fixture.create();
    const explicit = "explicit-environment-token-0123";
    const printed = capture();

    await expect(
      runAgenCMcpCli(
        { kind: "serve-token" },
        {
          io: printed.io,
          environment: { AGENC_HOME: home, AGENC_MCP_SERVER_TOKEN: explicit },
        },
      ),
    ).resolves.toBe(0);

    expect(printed.stdout()).toBe(`${explicit}\n`);
    expect(storedToken(home)).toBeUndefined();
  });

  test("fails, naming the variable, when no token can be resolved", async () => {
    const home = await fixture.create();
    getSecureStorageMock.mockReturnValue(absentBackend());
    const printed = capture();

    await expect(
      runAgenCMcpCli(
        { kind: "serve-token" },
        { io: printed.io, environment: { AGENC_HOME: home } },
      ),
    ).resolves.toBe(1);

    expect(printed.stdout()).toBe("");
    expect(printed.stderr()).toMatch(
      /^agenc: MCP SSE server has no bearer token: set AGENC_MCP_SERVER_TOKEN/u,
    );
  });
});
