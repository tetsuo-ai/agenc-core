/**
 * Drift guard for the in-repo embedding SDK (`packages/agenc-sdk`).
 *
 * The package hand-mirrors the daemon protocol so it can stand alone with
 * zero runtime-internal imports. This test pins that mirror to the runtime's
 * canonical method registry the same way the sibling-repo SDK is pinned by
 * `tests/app-server/sdk-client.contract.test.ts`: any protocol change fails
 * here until `packages/agenc-sdk/src/protocol.ts` is updated.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
} from "../../src/app-server/protocol/index.js";
import { resolveAgenCDaemonSocketPath } from "../../src/app-server/daemon-cli.js";
import {
  AGENC_SDK_DAEMON_PROTOCOL_VERSION,
  AGENC_SDK_DAEMON_METHODS,
  AGENC_SDK_DAEMON_NOTIFICATION_METHODS,
  type AgencParamsByMethod,
} from "../../../packages/agenc-sdk/src/protocol";
import { resolveDaemonSocketPath } from "../../../packages/agenc-sdk/src/socket";

// @ts-expect-error A partial evidence request must not match the legacy branch.
const invalidPartialToolResolution: AgencParamsByMethod["session.resolveToolCall"] = {
  sessionId: "session_legacy",
  toolCallId: "call_partial",
  disposition: "confirmed_no_effect",
};
void invalidPartialToolResolution;

const packageProtocolPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/agenc-sdk/src/protocol.ts",
);

describe("agenc-sdk protocol mirror", () => {
  it("mirrors the runtime daemon method registry exactly (names and order)", () => {
    expect([...AGENC_SDK_DAEMON_METHODS]).toEqual([...AGENC_DAEMON_METHODS]);
    expect([...AGENC_SDK_DAEMON_NOTIFICATION_METHODS]).toEqual([
      ...AGENC_DAEMON_NOTIFICATION_METHODS,
    ]);
  });

  it("retains the SDK 0.3.0 tool-resolution request shape", () => {
    const resolveAllLegacy = {
      sessionId: "session_legacy",
      reviewer: "sdk-0.3.0",
    } satisfies AgencParamsByMethod["session.resolveToolCall"];
    const resolveOneLegacy = {
      sessionId: "session_legacy",
      toolCallId: "call_legacy",
      reviewer: "sdk-0.3.0",
    } satisfies AgencParamsByMethod["session.resolveToolCall"];

    expect(AGENC_SDK_DAEMON_PROTOCOL_VERSION).toBe(
      AGENC_DAEMON_PROTOCOL_VERSION,
    );
    expect(resolveAllLegacy).toEqual({
      sessionId: "session_legacy",
      reviewer: "sdk-0.3.0",
    });
    expect(resolveOneLegacy.toolCallId).toBe("call_legacy");
  });

  it("declares params and result mappings for every daemon method", () => {
    const source = readFileSync(packageProtocolPath, "utf8");
    expectOrderedKeys(
      "AgencParamsByMethod",
      AGENC_DAEMON_METHODS,
      extractInterfaceMethodKeys(source, "AgencParamsByMethod"),
    );
    expectOrderedKeys(
      "AgencResultByMethod",
      AGENC_DAEMON_METHODS,
      extractInterfaceMethodKeys(source, "AgencResultByMethod"),
    );
  });

  it("does not import runtime internals", () => {
    const source = readFileSync(packageProtocolPath, "utf8");
    expect(source).not.toMatch(/from "\.\.\/\.\.\/runtime\//);
    expect(source).not.toMatch(/@tetsuo-ai\/runtime/);
  });

  it("mirrors the runtime local endpoint on Unix and Windows", () => {
    for (const [home, platform] of [
      ["/tmp/agenc-sdk-home", "linux"],
      [String.raw`C:\Users\Test\.agenc`, "win32"],
    ] as const) {
      const env = { AGENC_HOME: home };
      expect(resolveDaemonSocketPath(env, home, platform)).toBe(
        resolveAgenCDaemonSocketPath(env, home, platform),
      );
    }
  });
});

function extractInterfaceMethodKeys(
  source: string,
  interfaceName: string,
): string[] {
  const match = new RegExp(
    `export\\s+interface\\s+${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!match) throw new Error(`missing interface: ${interfaceName}`);
  const keys: string[] = [];
  const keyRe = /readonly\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/g;
  let keyMatch;
  while ((keyMatch = keyRe.exec(match[1]!)) !== null) {
    keys.push((keyMatch[1] ?? keyMatch[2] ?? keyMatch[3])!);
  }
  return keys;
}

function expectOrderedKeys(
  label: string,
  expected: readonly string[],
  actual: readonly string[],
): void {
  expect(actual, label).toEqual([...expected]);
}
