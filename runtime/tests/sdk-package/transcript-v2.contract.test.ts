import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createAgencClient,
  type AgencDaemonMethod,
  type AgencDaemonRequest,
  type AgencDaemonResponse,
  type AgencTransport,
  type SessionTranscriptV2TurnResult,
} from "../../../packages/agenc-sdk/src/index";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeProtocolPath = resolve(
  testDirectory,
  "../../src/app-server/protocol/index.ts",
);
const sdkTranscriptV2Path = resolve(
  testDirectory,
  "../../../packages/agenc-sdk/src/transcript-v2.generated.ts",
);

const turnResults = [
  {
    turnId: "turn-1",
    committedSequence: 15,
    outcome: "completed",
    durationMs: 4_137,
    inputTokens: 300,
    outputTokens: 100,
    totalTokens: 400,
    model: "grok-4.6",
    provider: "grok",
  },
  {
    turnId: "turn-2",
    committedSequence: 18,
    outcome: "aborted",
  },
] satisfies readonly SessionTranscriptV2TurnResult[];

class TranscriptV2Transport implements AgencTransport {
  async request<Method extends AgencDaemonMethod>(
    request: AgencDaemonRequest<Method>,
  ): Promise<AgencDaemonResponse<Method>> {
    if (request.method === "initialize") {
      return success(request, {
        type: "initialized",
        protocolVersion: "1.9.0",
        protocol: { version: "1.9.0" },
        capabilities: {
          "daemon.methods": { "session.transcript.v2": true },
        },
      });
    }
    if (request.method === "session.attach") {
      return success(request, {
        attachmentId: "attachment-1",
        sessionId: "session-1",
      });
    }
    if (request.method === "session.transcript.v2") {
      return success(request, {
        schemaVersion: 2,
        sessionId: "session-1",
        runId: "run-1",
        historyEpoch: "history:run-1:initial",
        asOfSequence: 18,
        messages: [],
        turnResults,
      });
    }
    throw new Error(`unexpected method: ${request.method}`);
  }
}

function success<Method extends AgencDaemonMethod>(
  request: AgencDaemonRequest<Method>,
  result: unknown,
): AgencDaemonResponse<Method> {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result,
  } as AgencDaemonResponse<Method>;
}

function interfaceProperties(
  source: string,
  interfaceName: string,
): readonly (readonly [name: string, type: string])[] {
  const match = new RegExp(
    `export\\s+interface\\s+${interfaceName}\\s+extends\\s+(?:JsonObject|TranscriptV2JsonObject)\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (match === null) throw new Error(`missing interface: ${interfaceName}`);
  return [
    ...match[1]!.matchAll(
      /^\s*readonly\s+([A-Za-z_$][\w$]*\??)\s*:\s*([^;]+);/gm,
    ),
  ].map(
    (property) =>
      [property[1]!, property[2]!.replace(/\s+/g, " ").trim()] as const,
  );
}

describe("agenc-sdk session.transcript.v2 contract", () => {
  it("keeps the SDK transcript result shapes aligned with the daemon", () => {
    const runtimeProtocol = readFileSync(runtimeProtocolPath, "utf8");
    const sdkProtocol = readFileSync(sdkTranscriptV2Path, "utf8");

    for (const interfaceName of [
      "SessionTranscriptV2TurnResult",
      "SessionTranscriptV2Result",
    ]) {
      expect(
        interfaceProperties(sdkProtocol, interfaceName),
        interfaceName,
      ).toEqual(interfaceProperties(runtimeProtocol, interfaceName));
    }
  });

  it("preserves typed closed-turn results returned by the daemon", async () => {
    const client = createAgencClient({
      transport: new TranscriptV2Transport(),
      clientId: "transcript-v2-contract",
    });
    await client.initialize();
    const session = await client.resumeSession("session-1");

    await expect(session.transcriptV2()).resolves.toMatchObject({
      turnResults,
    });
  });
});
