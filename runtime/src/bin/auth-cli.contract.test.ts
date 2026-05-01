import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatAgenCAuthCliHelpText,
  parseAgenCAuthCliArgs,
  runAgenCAuthCli,
  type AgenCAuthCliIo,
} from "./auth-cli.js";

function createIo(): AgenCAuthCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function tempAgencHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-auth-cli-"));
}

describe("AgenC auth CLI", () => {
  it("parses only top-level auth commands", () => {
    expect(parseAgenCAuthCliArgs(["hello"])).toBeNull();
    expect(parseAgenCAuthCliArgs(["login"])).toEqual({ kind: "login" });
    expect(parseAgenCAuthCliArgs(["logout"])).toEqual({ kind: "logout" });
    expect(parseAgenCAuthCliArgs(["whoami"])).toEqual({ kind: "whoami" });
    expect(parseAgenCAuthCliArgs(["login", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCAuthCliHelpText(),
    });
    expect(parseAgenCAuthCliArgs(["whoami", "extra"])).toEqual({
      kind: "error",
      message: "auth command 'whoami' does not accept arguments",
    });
    expect(formatAgenCAuthCliHelpText()).toContain(
      "agenc <login|logout|whoami>",
    );
  });

  it("persists login state through LocalAuthBackend and clears it on logout", async () => {
    const agencHome = await tempAgencHome();
    const env = { ...process.env, AGENC_HOME: agencHome, HOME: agencHome };
    try {
      const whoamiBefore = createIo();
      await expect(
        runAgenCAuthCli({ kind: "whoami" }, { env, io: whoamiBefore }),
      ).resolves.toBe(1);
      expect(whoamiBefore.stdoutText()).toBe("Not logged in\n");
      expect(whoamiBefore.stderrText()).toBe("");

      const loginIo = createIo();
      await expect(
        runAgenCAuthCli({ kind: "login" }, { env, io: loginIo }),
      ).resolves.toBe(0);
      expect(loginIo.stdoutText()).toBe(
        "Logged in as Local AgenC user (id=local, plan=free)\n",
      );
      await expect(
        readFile(join(agencHome, "auth.json"), "utf8"),
      ).resolves.toContain("\"provider\": \"local\"");

      const whoamiAfter = createIo();
      await expect(
        runAgenCAuthCli({ kind: "whoami" }, { env, io: whoamiAfter }),
      ).resolves.toBe(0);
      expect(whoamiAfter.stdoutText()).toBe(
        "Local AgenC user (id=local, plan=free)\n",
      );

      const logoutIo = createIo();
      await expect(
        runAgenCAuthCli({ kind: "logout" }, { env, io: logoutIo }),
      ).resolves.toBe(0);
      expect(logoutIo.stdoutText()).toBe("Logged out\n");

      const whoamiCleared = createIo();
      await expect(
        runAgenCAuthCli({ kind: "whoami" }, { env, io: whoamiCleared }),
      ).resolves.toBe(1);
      expect(whoamiCleared.stdoutText()).toBe("Not logged in\n");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("surfaces unavailable remote login flow", async () => {
    const agencHome = await tempAgencHome();
    const env = { ...process.env, AGENC_HOME: agencHome, HOME: agencHome };
    await writeFile(
      join(agencHome, "config.toml"),
      "[auth]\nbackend = \"remote\"\n",
    );
    try {
      const io = createIo();
      await expect(
        runAgenCAuthCli({ kind: "login" }, { env, io }),
      ).resolves.toBe(1);
      expect(io.stdoutText()).toBe("");
      expect(io.stderrText()).toContain(
        "RemoteAuthBackend login is not available",
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });
});
