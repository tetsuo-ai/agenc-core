import { describe, expect, it } from "vitest";
import {
  buildScrubbedSpawnEnv,
  isSecretEnvKey,
  scrubEnvForChildProcess,
} from "../../src/unified-exec/scrub-env.js";
import { withChildTempAuthority } from "../../src/utils/subprocessEnv.js";

describe("scrubEnvForChildProcess (SEC-01)", () => {
  it("classifies provider keys as secrets", () => {
    expect(isSecretEnvKey("XAI_API_KEY")).toBe(true);
    expect(isSecretEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isSecretEnvKey("MY_CUSTOM_TOKEN")).toBe(true);
    expect(isSecretEnvKey("ANTHROPIC_CUSTOM_HEADERS")).toBe(true);
    expect(isSecretEnvKey("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
    expect(isSecretEnvKey("AZURE_CLIENT_CERTIFICATE_PATH")).toBe(true);
    expect(isSecretEnvKey("ALL_INPUTS")).toBe(true);
    expect(isSecretEnvKey("SSH_SIGNING_KEY")).toBe(true);
    expect(isSecretEnvKey("WEB_KEY")).toBe(true);
    expect(isSecretEnvKey("AGENC_CLIENT_KEY_PASSPHRASE")).toBe(true);
    expect(isSecretEnvKey("PATH")).toBe(false);
    expect(isSecretEnvKey("HOME")).toBe(false);
    expect(isSecretEnvKey("LANG")).toBe(false);
  });

  it("drops secret keys from a source map", () => {
    const scrubbed = scrubEnvForChildProcess({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      XAI_API_KEY: "xai-secret",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_CUSTOM_HEADERS: "x-sensitive-header: secret",
      ALL_INPUTS: '{"token":"secret"}',
      WEB_KEY: "web-secret",
      AGENC_CLIENT_KEY_PASSPHRASE: "client-key-secret",
      TERM: "xterm-256color",
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/dev");
    expect(scrubbed.TERM).toBe("xterm-256color");
    expect(scrubbed.XAI_API_KEY).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(scrubbed.ALL_INPUTS).toBeUndefined();
    expect(scrubbed.WEB_KEY).toBeUndefined();
    expect(scrubbed.AGENC_CLIENT_KEY_PASSPHRASE).toBeUndefined();
  });

  it("buildScrubbedSpawnEnv never reintroduces process secrets via overrides", () => {
    const prev = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "should-not-leak";
    try {
      const env = buildScrubbedSpawnEnv({
        XAI_API_KEY: "also-secret",
        CUSTOM_OK: "yes",
      });
      expect(env.XAI_API_KEY).toBeUndefined();
      expect(env.CUSTOM_OK).toBe("yes");
      expect(env.PATH).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prev;
    }
  });

  it("replaces every temp-directory alias with one captured child authority", () => {
    const env = withChildTempAuthority(
      {
        AGENC_TMPDIR: "/ambient/agenc",
        TMPDIR: "/ambient/posix",
        TEMP: "C:\\ambient\\temp",
        TMP: "C:\\ambient\\tmp",
        Temp: "mixed-case-must-not-survive",
        tmpdir: "lowercase-must-not-survive",
        PATH: "/usr/bin",
      },
      "/captured/session-temp",
    );

    expect(env).toMatchObject({
      AGENC_TMPDIR: "/captured/session-temp",
      TMPDIR: "/captured/session-temp",
      TEMP: "/captured/session-temp",
      TMP: "/captured/session-temp",
      PATH: "/usr/bin",
    });
    expect(env).not.toHaveProperty("Temp");
    expect(env).not.toHaveProperty("tmpdir");
  });

  it("rejects a relative child temp authority", () => {
    expect(() => withChildTempAuthority({}, "relative/temp")).toThrow(
      "child process temp root must be a non-empty absolute path",
    );
  });
});
