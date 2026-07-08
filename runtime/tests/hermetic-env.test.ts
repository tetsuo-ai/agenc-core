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

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HERMETIC_AGENC_STATE_ENV_VARS,
  HERMETIC_MARKER_ENV_VAR,
  HERMETIC_PROVIDER_CREDENTIAL_ENV_VARS,
} from "./helpers/hermetic-env.mjs";

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

  it("points AGENC_HOME at a hermetic temp dir, never the real ~/.agenc", () => {
    const agencHome = process.env.AGENC_HOME;
    expect(agencHome).toBeTruthy();
    expect(agencHome).toBe(process.env.AGENC_TEST_HERMETIC_HOME);
    expect(agencHome).not.toBe(join(homedir(), ".agenc"));
  });

  it("pins the auth backend env override to local (no id.agenc.ag logins)", () => {
    expect(process.env.AGENC_AUTH_BACKEND).toBe("local");
  });
});
