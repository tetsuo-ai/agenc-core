import { describe, expect, it } from "vitest";

import { gitChildEnvironment } from "../../src/sandbox/git-environment.js";

describe("gitChildEnvironment", () => {
  it("drops inherited Git/config/transport injection and credential state", () => {
    const env = gitChildEnvironment({
      PATH: "/usr/bin",
      LANG: "C",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
      GIT_EXEC_PATH: "/tmp/attacker-bin",
      GIT_SSH_COMMAND: "/tmp/attacker-ssh",
      GIT_INDEX_FILE: "/tmp/attacker-index",
      GIT_TRACE: "1",
      SSH_ASKPASS: "/tmp/attacker-askpass",
      SSH_ASKPASS_REQUIRE: "force",
      GCM_INTERACTIVE: "Always",
      GITHUB_TOKEN: "secret",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("C");
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_EXEC_PATH).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_TRACE).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS_REQUIRE).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_PROTOCOL_FROM_USER: "0",
      GCM_INTERACTIVE: "Never",
    });
  });
});
