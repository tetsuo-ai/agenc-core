/**
 * Drift guard for the in-repo embedding SDK (`packages/agenc-sdk`).
 *
 * The package generates standalone wire declarations. The compiler checks
 * every method's params, results, envelope and generic client arguments.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
import { checkSdkWireParity } from "../../scripts/check-sdk-wire-parity.mjs";

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

  it("exactly matches every wire request, result and client signature", () => {
    expect(checkSdkWireParity()).toEqual({
      matches: true,
      mismatches: { RequestExact: [], ResultExact: [], EnvelopeExact: [], ClientArgumentsExact: [] },
      diagnostics: [],
    });
  }, 30_000);

  it("does not import runtime internals", () => {
    const source = readFileSync(packageProtocolPath, "utf8");
    expect(source).not.toMatch(/from "\.\.\/\.\.\/runtime\//);
    expect(source).not.toMatch(/@tetsuo-ai\/runtime/);
  });

  it("mirrors the runtime local endpoint on Unix and Windows", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-sdk-endpoint-")));
    try {
      for (const [home, platform] of [
        [join(root, "unix-home"), "linux"],
        [join(root, "windows-home"), "win32"],
      ] as const) {
        const env = { AGENC_HOME: home };
        expect(resolveDaemonSocketPath(env, home, platform)).toBe(
          agenCDaemonLocalEndpoint(home, platform),
        );
      }
      const hostHome = join(root, "host-home");
      expect(resolveDaemonSocketPath(
        { AGENC_HOME: hostHome },
        hostHome,
        process.platform,
      )).toBe(resolveAgenCDaemonSocketPath(
        { AGENC_HOME: hostHome },
        hostHome,
        process.platform,
      ));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
