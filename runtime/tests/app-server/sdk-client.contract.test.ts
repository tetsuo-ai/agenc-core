import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
} from "./protocol/index.js";
import {
  AGENC_SDK_DAEMON_METHODS,
  AGENC_SDK_DAEMON_NOTIFICATION_METHODS,
  createAgencClient,
  type AgencDaemonRequest as SdkDaemonRequest,
  type AgencDaemonResponse as SdkDaemonResponse,
  type AgencTransport as SdkDaemonTransport,
} from "../../../packages/agenc-sdk/src/index";

const canonicalSdkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/agenc-sdk",
);

function readCanonicalSdkSource(...segments: readonly string[]): string {
  return readFileSync(resolve(canonicalSdkRoot, ...segments), "utf8");
}

describe("AgenC SDK daemon client wrapper", () => {
  it("exposes a typed wrapper over every daemon method without SDK agent logic", () => {
    const protocolSource = readCanonicalSdkSource("src", "protocol.ts");
    const clientSource = readCanonicalSdkSource("src", "client.ts");
    const indexSource = readCanonicalSdkSource("src", "index.ts");

    expect(indexSource).toContain('export * from "./protocol.js";');
    expect(indexSource).toContain('export * from "./client.js";');
    expect(clientSource).toContain("export class AgencClient");
    expect(clientSource).toContain("export interface AgencTransport");
    expect([...AGENC_SDK_DAEMON_METHODS]).toEqual([...AGENC_DAEMON_METHODS]);
    expect([...AGENC_SDK_DAEMON_NOTIFICATION_METHODS]).toEqual([
      ...AGENC_DAEMON_NOTIFICATION_METHODS,
    ]);

    for (const method of AGENC_DAEMON_METHODS) {
      expect(protocolSource).toContain(`"${method}"`);
    }
    for (const method of AGENC_DAEMON_NOTIFICATION_METHODS) {
      expect(protocolSource).toContain(`"${method}"`);
    }

    expectOrderedLiterals(
      "AgencParamsByMethod",
      AGENC_DAEMON_METHODS,
      extractInterfaceMethodKeys(protocolSource, "AgencParamsByMethod"),
    );
    expectOrderedLiterals(
      "AgencResultByMethod",
      AGENC_DAEMON_METHODS,
      extractInterfaceMethodKeys(protocolSource, "AgencResultByMethod"),
    );
    // External installed/sibling SDK copies are release artifacts, not build
    // inputs. The canonical in-repo zero-dependency package is the drift gate.
    const runtimeImport = /from\s+["'][^"']*(?:@tetsuo-ai\/runtime|runtime\/)/;
    expect(protocolSource).not.toMatch(runtimeImport);
    expect(clientSource).not.toMatch(runtimeImport);
  });

  it("frames public run introspection methods onto daemon JSON-RPC requests", async () => {
    const requests: SdkDaemonRequest[] = [];
    const requestIds = sequence([
      "sdk-run-status",
      "sdk-run-result",
      "sdk-run-replay",
      "sdk-run-evidence",
      "sdk-run-cancel",
      "sdk-run-start",
    ]);
    const transport: SdkDaemonTransport = {
      request: async (request) => {
        requests.push(request);
        const resultByMethod = {
          "run.status": {
            runId: "run_sdk",
            status: "completed",
            terminal: true,
          },
          "run.result": {
            runId: "run_sdk",
            status: "completed",
            terminal: true,
            outcome: "completed",
          },
          "run.replay": {
            runId: "run_sdk",
            events: [],
            hasMore: false,
            nextAfterSequence: 7,
          },
          "run.evidence": {
            runId: "run_sdk",
            events: [],
            hasMore: false,
          },
          "run.cancel": {
            runId: "run_sdk",
            alreadyTerminal: true,
          },
          "run.start": {
            runId: "run_sdk_wf",
            specDigest: `sha256:${"a".repeat(64)}`,
            baseCommit: "b".repeat(40),
            baseDirty: { dirty: false, fileCount: 0 },
          },
        } as const;
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: resultByMethod[request.method as keyof typeof resultByMethod],
        } as SdkDaemonResponse<typeof request.method>;
      },
    };
    const client = createAgencClient({
      transport,
      createRequestId: requestIds,
    });

    await expect(client.runStatus("run_sdk")).resolves.toMatchObject({
      terminal: true,
    });
    await expect(client.runResult("run_sdk")).resolves.toMatchObject({
      outcome: "completed",
    });
    await expect(
      client.replayRun({ runId: "run_sdk", afterSequence: 7, limit: 25 }),
    ).resolves.toMatchObject({ nextAfterSequence: 7 });
    await expect(
      client.runEvidence({ runId: "run_sdk", afterSequence: 7, limit: 25 }),
    ).resolves.toMatchObject({ hasMore: false });
    await expect(
      client.cancelRun("run_sdk", "operator"),
    ).resolves.toMatchObject({ alreadyTerminal: true });
    await expect(
      client.startRun({
        goal: "Fix the reported bug",
        cwd: "/workspace/repo",
        reviewerModel: "reviewer-model",
        requiredVerification: [{ label: "unit", script: "npm test" }],
      }),
    ).resolves.toMatchObject({ runId: "run_sdk_wf" });

    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        id: "sdk-run-status",
        method: "run.status",
        params: { runId: "run_sdk" },
      },
      {
        jsonrpc: "2.0",
        id: "sdk-run-result",
        method: "run.result",
        params: { runId: "run_sdk" },
      },
      {
        jsonrpc: "2.0",
        id: "sdk-run-replay",
        method: "run.replay",
        params: { runId: "run_sdk", afterSequence: 7, limit: 25 },
      },
      {
        jsonrpc: "2.0",
        id: "sdk-run-evidence",
        method: "run.evidence",
        params: { runId: "run_sdk", afterSequence: 7, limit: 25 },
      },
      {
        jsonrpc: "2.0",
        id: "sdk-run-cancel",
        method: "run.cancel",
        params: { runId: "run_sdk", reason: "operator" },
      },
      {
        jsonrpc: "2.0",
        id: "sdk-run-start",
        method: "run.start",
        params: {
          goal: "Fix the reported bug",
          cwd: "/workspace/repo",
          reviewerModel: "reviewer-model",
          requiredVerification: [{ label: "unit", script: "npm test" }],
        },
      },
    ]);
  });
});

function extractInterfaceMethodKeys(
  source: string,
  interfaceName: string,
): string[] {
  const match = new RegExp(
    `export\\s+interface\\s+${escapeRegExp(interfaceName)}\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!match) throw new Error(`missing interface: ${interfaceName}`);
  const keys: string[] = [];
  const keyRe =
    /readonly\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/g;
  let keyMatch;
  while ((keyMatch = keyRe.exec(match[1])) !== null) {
    keys.push(keyMatch[1] ?? keyMatch[2] ?? keyMatch[3]);
  }
  return keys;
}

function expectOrderedLiterals(
  label: string,
  expected: readonly string[],
  actual: readonly string[],
): void {
  expect(actual, label).toEqual(expected);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}
