/**
 * Drift guard for the in-repo embedding SDK (`packages/agenc-sdk`).
 *
 * The package hand-mirrors the daemon protocol so it can stand alone with
 * zero runtime-internal imports. This test pins that mirror to the runtime's
 * canonical method registry the same way the sibling-repo SDK is pinned by
 * `tests/app-server/sdk-client.contract.test.ts`: any protocol change fails
 * here until `packages/agenc-sdk/src/protocol.ts` is updated.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
} from "../../src/app-server/protocol/index.js";
import { resolveAgenCDaemonSocketPath } from "../../src/app-server/daemon-cli.js";
import { agenCDaemonLocalEndpoint } from "../../src/app-server/transport/unix-socket.js";
import { resolveHomeContext } from "../../src/config/home.js";
import {
  AGENC_SDK_DAEMON_PROTOCOL_VERSION,
  AGENC_SDK_DAEMON_METHODS,
  AGENC_SDK_DAEMON_NOTIFICATION_METHODS,
  type AgencParamsByMethod,
} from "../../../packages/agenc-sdk/src/protocol";
import {
  connect,
  resolveAgencHome,
  resolveDaemonSocketPath,
} from "../../../packages/agenc-sdk/src/socket";
import { resolveAgenCHome as resolveLauncherHome } from "../../../packages/agenc/lib/home-authority.mjs";

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
      ["/tmp/agenc-sdk-windows-home", "win32"],
    ] as const) {
      const env = { AGENC_HOME: home };
      expect(resolveDaemonSocketPath(env, home, platform)).toBe(
        agenCDaemonLocalEndpoint(home, platform),
      );
    }
    const hostHome = "/tmp/agenc-sdk-host-home";
    expect(resolveDaemonSocketPath(
      { AGENC_HOME: hostHome },
      hostHome,
      process.platform,
    )).toBe(resolveAgenCDaemonSocketPath(
      { AGENC_HOME: hostHome },
      hostHome,
      process.platform,
    ));
  });

  it("matches runtime and launcher home validation and canonicalization", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-cross-package-home-"));
    try {
      const canonical = join(root, "canonical");
      const alias = join(root, "alias");
      mkdirSync(canonical);
      symlinkSync(canonical, alias, "dir");
      const configured = join(alias, "nested", "home");
      const env = { AGENC_HOME: configured };
      const expected = resolveHomeContext(env, { platformHome: root }).path;

      expect(resolveLauncherHome(env, root)).toBe(expected);
      expect(resolveAgencHome(env, root)).toBe(expected);

      for (const resolveHome of [
        (candidate: NodeJS.ProcessEnv) =>
          resolveHomeContext(candidate, { platformHome: root }).path,
        (candidate: NodeJS.ProcessEnv) => resolveLauncherHome(candidate, root),
        (candidate: NodeJS.ProcessEnv) => resolveAgencHome(candidate, root),
      ]) {
        expect(() => resolveHome({ AGENC_HOME: "relative-home" })).toThrow(
          /AGENC_HOME must be an absolute path/,
        );
        expect(() => resolveHome({ AGENC_CONFIG_DIR: join(root, "retired") })).toThrow(
          /AGENC_CONFIG_DIR is no longer a runtime configuration authority/,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates home authority before connect uses explicit endpoint overrides", async () => {
    await expect(connect({
      env: { AGENC_CONFIG_DIR: "/tmp/retired-agenc-home" },
      socketPath: "/tmp/explicit-agenc.sock",
      cookiePath: "/tmp/explicit-agenc.cookie",
      autostart: false,
    })).rejects.toThrow(
      /AGENC_CONFIG_DIR is no longer a runtime configuration authority/,
    );
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
