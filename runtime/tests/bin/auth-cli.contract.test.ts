import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  formatAgenCAuthCliHelpText,
  parseAgenCAuthCliArgs,
  runAgenCAuthCli,
  type AgenCAuthCliIo,
} from "./auth-cli.js";
import { RemoteAuthBackend } from "../auth/backends/remote.js";

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
    expect(formatAgenCAuthCliHelpText()).toContain(
      "AGENC_AUTH_BACKEND=remote agenc login",
    );
  });

  it("persists login state through LocalAuthBackend and clears it on logout", async () => {
    const agencHome = await tempAgencHome();
    const env = { ...process.env, AGENC_HOME: agencHome, HOME: agencHome };
    try {
      await writeFile(
        join(agencHome, "config.toml"),
        "[auth]\nbackend = \"local\"\n",
      );
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

  it("persists remote login state through RemoteAuthBackend", async () => {
    const agencHome = await tempAgencHome();
    const backend = new RemoteAuthBackend({
      agencHome,
      loginFlow: () => ({
        token: "remote-token",
        identity: {
          accountId: "acct-1",
          email: "user@agenc.tech",
          displayName: "Remote User",
          plan: "pro",
        },
        subscriptionTier: "pro",
      }),
    });

    try {
      const loginIo = createIo();
      await expect(
        runAgenCAuthCli({ kind: "login" }, { backend, io: loginIo }),
      ).resolves.toBe(0);
      expect(loginIo.stdoutText()).toBe(
        "Logged in as Remote User (id=acct-1, email=user@agenc.tech, plan=pro)\n",
      );
      await expect(
        readFile(join(agencHome, "auth.json"), "utf8"),
      ).resolves.toContain("\"provider\": \"remote\"");

      const whoamiIo = createIo();
      await expect(
        runAgenCAuthCli({ kind: "whoami" }, { backend, io: whoamiIo }),
      ).resolves.toBe(0);
      expect(whoamiIo.stdoutText()).toBe(
        "Remote User (id=acct-1, email=user@agenc.tech, plan=pro)\n",
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("prints remote device-code login instructions from config", async () => {
    const agencHome = await tempAgencHome();
    // This test deliberately exercises the remote backend (with a mocked
    // fetchImpl — no real network). The hermetic suite setup
    // (vitest.setup.ts, TODO task 30) pins AGENC_AUTH_BACKEND=local in
    // process.env, and that env override outranks config.toml, so the
    // remote intent must be explicit here.
    const env = {
      ...process.env,
      AGENC_HOME: agencHome,
      HOME: agencHome,
      AGENC_AUTH_BACKEND: "remote",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device-1",
            userCode: "USER-1",
            verificationUri: "https://agenc.tech/login",
            intervalSeconds: 0,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "remote-token",
            identity: {
              accountId: "acct-1",
              displayName: "Remote User",
            },
            subscriptionTier: "pro",
          }),
          { status: 200 },
        ),
      );

    await writeFile(
      join(agencHome, "config.toml"),
      "[auth]\nbackend = \"remote\"\n",
    );
    try {
      const io = createIo();
      await expect(
        runAgenCAuthCli(
          { kind: "login" },
          {
            env,
            io,
            remote: {
              fetchImpl,
              loginPollEndpoint: "https://api.agenc.tech/test/login/poll",
              loginStartEndpoint: "https://api.agenc.tech/test/login/start",
            },
          },
        ),
      ).resolves.toBe(0);
      expect(io.stdoutText()).toBe(
        [
          "Open this URL in your browser to sign in: https://agenc.tech/login",
          "Enter code: USER-1",
          "Logged in as Remote User (id=acct-1)",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("opens the remote login URL after Enter in an interactive terminal", async () => {
    const agencHome = await tempAgencHome();
    // Explicit remote-backend intent; see the comment in the previous test
    // (the hermetic suite setup pins AGENC_AUTH_BACKEND=local by default).
    const env = {
      ...process.env,
      AGENC_HOME: agencHome,
      HOME: agencHome,
      AGENC_AUTH_BACKEND: "remote",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device-1",
            userCode: "USER-1",
            verificationUri: "https://agenc.tech/login",
            intervalSeconds: 0,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "remote-token",
            identity: {
              accountId: "acct-1",
              displayName: "Remote User",
            },
            subscriptionTier: "pro",
          }),
          { status: 200 },
        ),
      );
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean };
    stdin.isTTY = true;
    const openUrl = vi.fn();

    await writeFile(
      join(agencHome, "config.toml"),
      "[auth]\nbackend = \"remote\"\n",
    );
    try {
      const io = { ...createIo(), stdin, openUrl };
      const login = runAgenCAuthCli(
        { kind: "login" },
        {
          env,
          io,
          remote: {
            fetchImpl,
            loginPollEndpoint: "https://api.agenc.tech/test/login/poll",
            loginStartEndpoint: "https://api.agenc.tech/test/login/start",
          },
        },
      );

      await vi.waitFor(() => {
        expect(io.stdoutText()).toContain("Press Enter to open the browser.");
      });
      stdin.write("\n");

      await expect(login).resolves.toBe(0);
      expect(openUrl).toHaveBeenCalledWith("https://agenc.tech/login");
      expect(io.stdoutText()).toBe(
        [
          "Sign in with Google to continue.",
          "Press Enter to open the browser.",
          "If it does not open, copy this URL:",
          "https://agenc.tech/login",
          "Browser opened. Complete sign in there, then return here.",
          "Logged in as Remote User (id=acct-1)",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });
});
