import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
} from "./protocol/index.js";
import {
  createAgenCDaemonClient as createSdkDaemonClient,
  type AgenCDaemonRequest as SdkDaemonRequest,
  type AgenCDaemonResponse as SdkDaemonResponse,
  type AgenCDaemonTransport as SdkDaemonTransport,
} from "../../../../agenc-sdk/src/daemon";

function siblingSdkPath(...segments: readonly string[]): string {
  const path = [
    resolve(process.cwd(), "..", "..", "agenc-sdk", ...segments),
    resolve(process.cwd(), "..", "agenc-sdk", ...segments),
    siblingSdkPathFromMainCheckout(...segments),
  ].find(existsSync);

  if (path === undefined) {
    throw new Error(`Missing sibling agenc-sdk path: ${segments.join("/")}`);
  }
  return path;
}

function siblingSdkPathFromMainCheckout(
  ...segments: readonly string[]
): string {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  const commonDir = resolve(process.cwd(), result.stdout.trim());
  if (basename(commonDir) !== ".git") return "";
  return resolve(dirname(commonDir), "..", "agenc-sdk", ...segments);
}

function readSiblingSdkSource(...segments: readonly string[]): string {
  return readFileSync(siblingSdkPath(...segments), "utf8");
}

describe("AgenC SDK daemon client wrapper", () => {
  it("exposes a typed wrapper over every daemon method without SDK agent logic", () => {
    const daemonSource = readSiblingSdkSource("src", "daemon.ts");
    const indexSource = readSiblingSdkSource("src", "index.ts");

    expect(indexSource).toContain('export * from "./daemon";');
    expect(daemonSource).toContain("export class AgenCDaemonClient");
    expect(daemonSource).toContain("export interface AgenCDaemonTransport");

    for (const method of AGENC_DAEMON_METHODS) {
      expect(daemonSource).toContain(`"${method}"`);
    }
    for (const method of AGENC_DAEMON_NOTIFICATION_METHODS) {
      expect(daemonSource).toContain(`"${method}"`);
    }

    expectOrderedLiterals(
      "AgenCDaemonMethod",
      AGENC_DAEMON_METHODS,
      extractTypeUnionStringLiterals(daemonSource, "AgenCDaemonMethod"),
    );
    expectOrderedLiterals(
      "AgenCDaemonParamsByMethod",
      AGENC_DAEMON_METHODS,
      extractInterfaceMethodKeys(daemonSource, "AgenCDaemonParamsByMethod"),
    );
    expectOrderedLiterals(
      "AgenCDaemonResultByMethod",
      AGENC_DAEMON_METHODS,
      extractInterfaceMethodKeys(daemonSource, "AgenCDaemonResultByMethod"),
    );
    expectOrderedLiterals(
      "AgenCDaemonNotificationMethod",
      AGENC_DAEMON_NOTIFICATION_METHODS,
      extractTypeUnionStringLiterals(
        daemonSource,
        "AgenCDaemonNotificationMethod",
      ),
    );
    expectOrderedLiterals(
      "AgenCDaemonNotificationParamsByMethod",
      AGENC_DAEMON_NOTIFICATION_METHODS,
      extractInterfaceMethodKeys(
        daemonSource,
        "AgenCDaemonNotificationParamsByMethod",
      ),
    );

    expect(daemonSource).not.toMatch(/@solana\/web3\.js|@coral-xyz\/anchor/);
    expect(daemonSource).not.toMatch(
      /from "\.\/(agents|tasks|bid-marketplace|proofs|prover|queries|protocol)"/,
    );
  });

  it("frames session lifecycle methods onto daemon JSON-RPC requests", async () => {
    const requests: SdkDaemonRequest[] = [];
    const requestIds = sequence([
      "sdk-create-session",
      "sdk-detach-session",
      "sdk-terminate-session",
    ]);
    const transport: SdkDaemonTransport = {
      request: async (request) => {
        requests.push(request);
        const resultByMethod = {
          "session.create": {
            sessionId: "session_sdk",
            agentId: "agent_sdk",
            status: "idle",
            createdAt: "2026-05-01T14:00:00.000Z",
          },
          "session.detach": {
            sessionId: "session_sdk",
            attachmentId: "attachment_sdk",
            detached: true,
            remainingAttachmentIds: [],
          },
          "session.terminate": {
            sessionId: "session_sdk",
            terminated: true,
            status: "closed",
            closedAt: "2026-05-01T14:00:01.000Z",
          },
        } as const;
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: resultByMethod[request.method as keyof typeof resultByMethod],
        } as SdkDaemonResponse<typeof request.method>;
      },
    };
    const client = createSdkDaemonClient({
      transport,
      createRequestId: requestIds,
    });

    await expect(
      client.createSession({
        agentId: "agent_sdk",
        metadata: { source: "sdk-contract" },
      }),
    ).resolves.toMatchObject({ sessionId: "session_sdk" });
    await expect(
      client.detachSession({
        sessionId: "session_sdk",
        attachmentId: "attachment_sdk",
      }),
    ).resolves.toMatchObject({ detached: true });
    await expect(
      client.terminateSession({
        sessionId: "session_sdk",
        reason: "done",
      }),
    ).resolves.toMatchObject({ terminated: true });

    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        id: "sdk-create-session",
        method: "session.create",
        params: {
          agentId: "agent_sdk",
          metadata: { source: "sdk-contract" },
        },
      },
      {
        jsonrpc: "2.0",
        id: "sdk-detach-session",
        method: "session.detach",
        params: {
          sessionId: "session_sdk",
          attachmentId: "attachment_sdk",
        },
      },
      {
        jsonrpc: "2.0",
        id: "sdk-terminate-session",
        method: "session.terminate",
        params: {
          sessionId: "session_sdk",
          reason: "done",
        },
      },
    ]);
  });
});

function extractTypeUnionStringLiterals(
  source: string,
  typeName: string,
): string[] {
  const match = new RegExp(
    `export\\s+type\\s+${escapeRegExp(typeName)}\\s*=([\\s\\S]*?);`,
  ).exec(source);
  if (!match) throw new Error(`missing type union: ${typeName}`);
  return extractStringLiterals(match[1]);
}

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

function extractStringLiterals(source: string): string[] {
  const values: string[] = [];
  const literalRe = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match;
  while ((match = literalRe.exec(source)) !== null) {
    values.push(unescapeLiteral(match[1] ?? match[2]));
  }
  return values;
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\(["'\\])/g, "$1");
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
