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
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
} from "../../src/app-server/protocol/index.js";
import {
  AGENC_SDK_DAEMON_METHODS,
  AGENC_SDK_DAEMON_NOTIFICATION_METHODS,
} from "../../../packages/agenc-sdk/src/protocol";

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
