// Guards the suite-level hermeticity setup (TODO task 30).
//
// Revert-sensitive by construction: vitest.setup.ts stamps
// AGENC_TEST_HERMETIC_ENV=1 when it runs, and this test asserts on that
// marker FIRST. Removing the setupFiles wiring (or the setup file) makes the
// marker assertion fail even in an outer shell that happens to have no
// ambient credentials. The absent-credential assertions then prove the strip
// itself against a polluted outer shell — verified empirically by running
// this file with e.g. `XAI_API_KEY=fake-key npx vitest run
// tests/hermetic-env.test.ts`.

import { readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HERMETIC_AGENC_STATE_ENV_VARS,
  HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS,
  HERMETIC_MANAGED_SETTINGS_ENV_VAR,
  HERMETIC_MARKER_ENV_VAR,
  HERMETIC_PROVIDER_CREDENTIAL_ENV_VARS,
  HERMETIC_RUNTIME_AUTH_ENV_VARS,
  HERMETIC_STRIPPED_ENV_VARS,
} from "./helpers/hermetic-env.mjs";
import { BUILT_IN_PROVIDER_API_KEY_ENVS } from "../src/llm/registry/provider-info.js";
import { SUBPROCESS_SECRET_ENV } from "../src/utils/subprocessEnv.js";
import { AGENC_PROXY_SOCKET_DIR_PREFIX } from "../src/sandbox/linux-launcher/config.js";

const HERMETIC_ENV_CONTRACT = JSON.parse(
  readFileSync(
    new URL("./fixtures/hermetic-env-contract.json", import.meta.url),
    "utf8",
  ),
) as string[];

describe("suite-level hermetic env (vitest.setup.ts)", () => {
  it("ran before this module loaded (marker present)", () => {
    expect(process.env[HERMETIC_MARKER_ENV_VAR]).toBe("1");
  });

  it("stripped every ambient provider credential env var", () => {
    // Set-inside-a-test still works: setup runs before the module loads,
    // so nothing here fights tests that export their own keys.
    const leaked = HERMETIC_PROVIDER_CREDENTIAL_ENV_VARS.filter(
      (name: string) => process.env[name] !== undefined,
    );
    expect(leaked).toEqual([]);
  });

  it("stripped every ambient AgenC developer-state env var", () => {
    const leaked = HERMETIC_AGENC_STATE_ENV_VARS.filter(
      (name: string) => process.env[name] !== undefined,
    );
    expect(leaked).toEqual([]);
  });

  it("stripped every ambient runtime auth credential and credential path", () => {
    const leaked = HERMETIC_RUNTIME_AUTH_ENV_VARS.filter(
      (name: string) => process.env[name] !== undefined,
    );
    expect(leaked).toEqual([]);
  });

  it("covers canonical provider and subprocess secret registries", () => {
    const stripped = new Set<string>(HERMETIC_STRIPPED_ENV_VARS);
    const canonical = [
      ...Object.values(BUILT_IN_PROVIDER_API_KEY_ENVS),
      ...SUBPROCESS_SECRET_ENV,
    ].filter((name): name is string => typeof name === "string");
    expect(canonical.filter((name) => !stripped.has(name))).toEqual([]);
  });

  it("stripped the complete exported ambient list", () => {
    expect(
      HERMETIC_ENV_CONTRACT.filter(
        (name: string) => process.env[name] !== undefined,
      ),
    ).toEqual([]);
  });

  it("matches the independent reviewed env contract without duplicates", () => {
    const exported = [...HERMETIC_STRIPPED_ENV_VARS].sort();
    expect(exported).toEqual(HERMETIC_ENV_CONTRACT);
    expect(new Set(HERMETIC_ENV_CONTRACT).size).toBe(
      HERMETIC_ENV_CONTRACT.length,
    );
  });

  it("stripped every ambient live test opt-in", () => {
    const leaked = HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS.filter(
      (name: string) => process.env[name] !== undefined,
    );
    expect(leaked).toEqual([]);
  });

  it("points AGENC_HOME at a hermetic temp dir, never the real ~/.agenc", () => {
    const agencHome = process.env.AGENC_HOME;
    expect(agencHome).toBeTruthy();
    expect(agencHome).toBe(process.env.AGENC_TEST_HERMETIC_HOME);
    expect(process.env.AGENC_CONFIG_DIR).toBe(agencHome);
    expect(process.env.HOME).toBe(agencHome);
    expect(process.env.USERPROFILE).toBe(agencHome);
    expect(process.env.AGENC_MANAGED_HOME).toBe(
      join(agencHome as string, "managed-home"),
    );
    expect(process.env.AGENC_MANAGED_SETTINGS).toBe(
      join(agencHome as string, "managed-settings.json"),
    );
    expect(process.env[HERMETIC_MANAGED_SETTINGS_ENV_VAR]).toBe(
      join(agencHome as string, "managed-policy"),
    );
    for (const name of [
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ]) {
      expect(process.env[name]?.startsWith(`${agencHome}${sep}`)).toBe(true);
    }
  });

  it("gives this worker a unique short temp root inside the owned run root", () => {
    const runRoot = process.env.AGENC_TEST_HERMETIC_RUN_ROOT;
    const tempRoot = process.env.TMPDIR;
    expect(runRoot).toBeTruthy();
    expect(tempRoot).toBeTruthy();
    expect(tempRoot?.startsWith(`${runRoot}${sep}`)).toBe(true);
    expect(tempRoot).toBe(process.env.TEMP);
    expect(tempRoot).toBe(process.env.TMP);
    expect(basename(tempRoot as string)).toMatch(
      new RegExp(`^t-${process.pid}-.{6}$`, "u"),
    );
    expect(tempRoot).not.toBe(join(process.env.AGENC_HOME as string, "tmp"));
  });

  it("keeps suite Unix sockets below the portable macOS path ceiling", () => {
    if (process.platform === "win32") return;
    const tempRoot = process.env.TMPDIR as string;
    const suffix = "x".repeat(6);
    const candidates = [
      join(
        tempRoot,
        `agenc-agent-connection-state-${suffix}`,
        "daemon.sock",
      ),
      join(
        tempRoot,
        `${AGENC_PROXY_SOCKET_DIR_PREFIX}${suffix}`,
        "proxy-route-0.sock",
      ),
    ];
    for (const socketPath of candidates) {
      // Darwin's sockaddr_un.sun_path is 104 bytes including the terminator.
      expect(Buffer.byteLength(socketPath), socketPath).toBeLessThanOrEqual(103);
    }
  });

  it("pins the auth backend env override to local (no id.agenc.ag logins)", () => {
    expect(process.env.AGENC_AUTH_BACKEND).toBe("local");
  });

  it("uses the canonical prelauncher environment instead of ambient behavior knobs", () => {
    for (const name of [
      "AGENC_BUBBLEWRAP",
      "AGENC_DISABLE_NONESSENTIAL_TRAFFIC",
      "AGENC_EXTRA_BODY",
      "AGENC_GIT_BASH_PATH",
      "AGENC_OVERRIDE_DATE",
      "AGENC_TEST_FIXTURES_ROOT",
      "AGENC_TMPDIR",
      "CI",
      "GITHUB_DEVICE_FLOW_CLIENT_ID",
      "TERM_PROGRAM",
    ]) {
      expect(process.env[name], `${name} survived the launch allowlist`).toBeUndefined();
    }
    expect(process.env.TZ).toBe("UTC");
    expect(process.env.LANG).toBe("C.UTF-8");
    expect(process.env.LC_ALL).toBe("C.UTF-8");
    expect(process.env.TERM).toBe("dumb");
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.NPM_CONFIG_OFFLINE).toBe("true");
    expect(process.env.GIT_AUTHOR_NAME).toBe("AgenC Hermetic Test");
    expect(process.env.GIT_AUTHOR_EMAIL).toBe(
      "agenc-hermetic-test@invalid",
    );
    expect(process.env.GIT_COMMITTER_NAME).toBe("AgenC Hermetic Test");
    expect(process.env.GIT_COMMITTER_EMAIL).toBe(
      "agenc-hermetic-test@invalid",
    );
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(
      join(process.env.AGENC_HOME as string, "gitconfig"),
    );
    expect(process.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(process.env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
