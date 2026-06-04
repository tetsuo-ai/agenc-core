import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UUID } from "node:crypto";
import axios from "axios";

import { resetStateForTests } from "../../../src/bootstrap/state.js";
import {
  appendSessionLog,
  clearAllSessions,
  clearSession,
  getSessionLogs,
} from "../../../src/services/api/sessionIngress.js";
import type { TranscriptMessage } from "../../../src/types/logs.js";

vi.mock("../../../src/utils/sleep.js", () => ({
  sleep: async () => undefined,
}));

const tempDirs: string[] = [];
const sessionId = "00000000-0000-4000-8000-000000000777";
const originalSessionAccessToken = process.env.AGENC_SESSION_ACCESS_TOKEN;
const originalAfterLastCompact = process.env.AGENC_AFTER_LAST_COMPACT;
const originalTokenFile = process.env.AGENC_SESSION_INGRESS_TOKEN_FILE;
const originalTokenFd = process.env.AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR;

function id(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as UUID;
}

function transcriptEntry(
  uuid: UUID,
  parentUuid: UUID | null = null,
): TranscriptMessage {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: "2026-04-02T00:00:00.000Z",
    cwd: "/tmp",
    userType: "external",
    sessionId,
    version: "test",
    isSidechain: false,
    isMeta: false,
    message: {
      role: "user",
      content: `message ${uuid}`,
    },
  } as TranscriptMessage;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startIngressServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/session`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function forceNoSessionToken(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agenc-session-ingress-token-"));
  tempDirs.push(dir);
  delete process.env.AGENC_SESSION_ACCESS_TOKEN;
  delete process.env.AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR;
  process.env.AGENC_SESSION_INGRESS_TOKEN_FILE = join(dir, "missing-token");
  resetStateForTests();
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearAllSessions();
  resetStateForTests();
  restoreOptionalEnv("AGENC_SESSION_ACCESS_TOKEN", originalSessionAccessToken);
  restoreOptionalEnv("AGENC_AFTER_LAST_COMPACT", originalAfterLastCompact);
  restoreOptionalEnv("AGENC_SESSION_INGRESS_TOKEN_FILE", originalTokenFile);
  restoreOptionalEnv("AGENC_WEBSOCKET_AUTH_FILE_DESCRIPTOR", originalTokenFd);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("does not call remote ingress without an auth token", async () => {
  await forceNoSessionToken();
  let requestCount = 0;
  const server = await startIngressServer((_request, response) => {
    requestCount += 1;
    response.statusCode = 500;
    response.end();
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(1)), server.url)).resolves.toBe(false);
    await expect(getSessionLogs(sessionId, server.url)).resolves.toBeNull();
    expect(requestCount).toBe(0);
  } finally {
    await server.close();
  }
});

test("fetches session logs with bearer auth and adopts the remote last uuid", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  process.env.AGENC_AFTER_LAST_COMPACT = "1";
  resetStateForTests();
  const remoteEntries = [transcriptEntry(id(10)), transcriptEntry(id(11), id(10))];
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    lastUuid: string | undefined;
    bodyUuid?: unknown;
  }> = [];
  const server = await startIngressServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      lastUuid: request.headers["last-uuid"] as string | undefined,
    });
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ loglines: remoteEntries }));
      return;
    }
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    requests.at(-1)!.bodyUuid = body.uuid;
    response.statusCode = 201;
    response.end("{}");
  });

  try {
    await expect(getSessionLogs(sessionId, server.url)).resolves.toEqual(remoteEntries);
    await expect(appendSessionLog(sessionId, transcriptEntry(id(12), id(11)), server.url)).resolves.toBe(true);
    expect(requests).toEqual([
      {
        method: "GET",
        url: "/session?after_last_compact=true",
        authorization: "Bearer session-token",
        lastUuid: undefined,
      },
      {
        method: "PUT",
        url: "/session",
        authorization: "Bearer session-token",
        lastUuid: id(11),
        bodyUuid: id(12),
      },
    ]);
  } finally {
    await server.close();
  }
});

test("serializes appends and advances Last-Uuid headers", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  let inFlight = 0;
  let maxInFlight = 0;
  const putRequests: Array<{ uuid: unknown; lastUuid: string | undefined }> = [];
  const server = await startIngressServer(async (request, response) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    putRequests.push({
      uuid: body.uuid,
      lastUuid: request.headers["last-uuid"] as string | undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    response.statusCode = 201;
    response.end("{}");
  });

  try {
    await expect(
      Promise.all([
        appendSessionLog(sessionId, transcriptEntry(id(20)), server.url),
        appendSessionLog(sessionId, transcriptEntry(id(21), id(20)), server.url),
      ]),
    ).resolves.toEqual([true, true]);
    expect(maxInFlight).toBe(1);
    expect(putRequests).toEqual([
      { uuid: id(20), lastUuid: undefined },
      { uuid: id(21), lastUuid: id(20) },
    ]);
  } finally {
    await server.close();
  }
});

test("recovers from a 409 conflict by adopting the server last uuid header", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  const putRequests: Array<{ uuid: unknown; lastUuid: string | undefined }> = [];
  const server = await startIngressServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    putRequests.push({
      uuid: body.uuid,
      lastUuid: request.headers["last-uuid"] as string | undefined,
    });
    if (putRequests.length === 1) {
      response.statusCode = 409;
      response.setHeader("x-last-uuid", id(30));
      response.end("{}");
      return;
    }
    response.statusCode = 201;
    response.end("{}");
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(31), id(30)), server.url)).resolves.toBe(true);
    expect(putRequests).toEqual([
      { uuid: id(31), lastUuid: undefined },
      { uuid: id(31), lastUuid: id(30) },
    ]);
  } finally {
    await server.close();
  }
});

test("recovers from a 409 conflict by refetching the remote session head", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  const requests: Array<{
    method: string | undefined;
    uuid?: unknown;
    lastUuid: string | undefined;
  }> = [];
  const server = await startIngressServer(async (request, response) => {
    if (request.method === "GET") {
      requests.push({
        method: request.method,
        lastUuid: request.headers["last-uuid"] as string | undefined,
      });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ loglines: [transcriptEntry(id(40))] }));
      return;
    }

    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    requests.push({
      method: request.method,
      uuid: body.uuid,
      lastUuid: request.headers["last-uuid"] as string | undefined,
    });
    if (requests.length === 1) {
      response.statusCode = 409;
      response.end("{}");
      return;
    }
    response.statusCode = 201;
    response.end("{}");
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(41), id(40)), server.url)).resolves.toBe(true);
    expect(requests).toEqual([
      { method: "PUT", uuid: id(41), lastUuid: undefined },
      { method: "GET", lastUuid: undefined },
      { method: "PUT", uuid: id(41), lastUuid: id(40) },
    ]);
  } finally {
    await server.close();
  }
});

test("treats a duplicate 409 entry as already persisted", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  const putRequests: Array<{ uuid: unknown; lastUuid: string | undefined }> = [];
  const server = await startIngressServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    putRequests.push({
      uuid: body.uuid,
      lastUuid: request.headers["last-uuid"] as string | undefined,
    });
    response.statusCode = 409;
    response.setHeader("x-last-uuid", id(50));
    response.end("{}");
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(50)), server.url)).resolves.toBe(true);
    expect(putRequests).toEqual([{ uuid: id(50), lastUuid: undefined }]);
  } finally {
    await server.close();
  }
});

test("returns false for unauthorized appends", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  const server = await startIngressServer((_request, response) => {
    response.statusCode = 401;
    response.end("{}");
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(60)), server.url)).resolves.toBe(false);
  } finally {
    await server.close();
  }
});

test("returns false when a 409 conflict cannot discover a server head", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  const requests: Array<{ method: string | undefined; lastUuid: string | undefined }> = [];
  const server = await startIngressServer(async (request, response) => {
    requests.push({
      method: request.method,
      lastUuid: request.headers["last-uuid"] as string | undefined,
    });
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ loglines: [] }));
      return;
    }

    await readRequestBody(request);
    response.statusCode = 409;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: { message: "chain mismatch" } }));
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(70)), server.url)).resolves.toBe(false);
    expect(requests).toEqual([
      { method: "PUT", lastUuid: undefined },
      { method: "GET", lastUuid: undefined },
    ]);
  } finally {
    await server.close();
  }
});

test("uses the default message when an unrecoverable 409 has no error payload", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  let requestCount = 0;
  const server = await startIngressServer(async (request, response) => {
    requestCount += 1;
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ loglines: [] }));
      return;
    }

    await readRequestBody(request);
    response.statusCode = 409;
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(75)), server.url)).resolves.toBe(false);
    expect(requestCount).toBe(2);
  } finally {
    await server.close();
  }
});

test("handles missing, invalid, unauthorized, and rejected log fetches", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  const statuses = [200, 404, 401, 403];
  const server = await startIngressServer((_request, response) => {
    const status = statuses.shift() ?? 500;
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    if (status === 200) {
      response.end(JSON.stringify({ invalid: true }));
      return;
    }
    response.end("{}");
  });

  try {
    await expect(getSessionLogs(sessionId, server.url)).resolves.toBeNull();
    await expect(getSessionLogs(sessionId, server.url)).resolves.toEqual([]);
    await expect(getSessionLogs(sessionId, server.url)).resolves.toBeNull();
    await expect(getSessionLogs(sessionId, server.url)).resolves.toBeNull();
  } finally {
    await server.close();
  }
});

test("retries retryable append responses until the limit is exhausted", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  let requestCount = 0;
  const server = await startIngressServer(async (request, response) => {
    requestCount += 1;
    await readRequestBody(request);
    response.statusCode = 429;
    response.end("{}");
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(80)), server.url)).resolves.toBe(false);
    expect(requestCount).toBe(10);
  } finally {
    await server.close();
  }
});

test("retries network append errors until the limit is exhausted", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  const putSpy = vi.spyOn(axios, "put").mockRejectedValue(new Error("socket closed"));

  await expect(
    appendSessionLog(sessionId, transcriptEntry(id(85)), "http://127.0.0.1/session"),
  ).resolves.toBe(false);
  expect(putSpy).toHaveBeenCalledTimes(10);
});

test("clears cached append state for a single session", async () => {
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  resetStateForTests();
  const putRequests: Array<{ uuid: unknown; lastUuid: string | undefined }> = [];
  const server = await startIngressServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    putRequests.push({
      uuid: body.uuid,
      lastUuid: request.headers["last-uuid"] as string | undefined,
    });
    response.statusCode = 200;
    response.end("{}");
  });

  try {
    await expect(appendSessionLog(sessionId, transcriptEntry(id(90)), server.url)).resolves.toBe(true);
    clearSession(sessionId);
    await expect(appendSessionLog(sessionId, transcriptEntry(id(91)), server.url)).resolves.toBe(true);
    expect(putRequests).toEqual([
      { uuid: id(90), lastUuid: undefined },
      { uuid: id(91), lastUuid: undefined },
    ]);
  } finally {
    await server.close();
  }
});
