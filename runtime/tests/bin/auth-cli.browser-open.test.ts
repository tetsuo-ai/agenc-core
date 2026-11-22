import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
}));

import { runAgenCAuthCli, type AgenCAuthCliIo } from "../../src/bin/auth-cli.js";
import { browserOpenCommand } from "../../src/utils/browser.js";

/** `agenc login` in a terminal, with Enter pressed at the browser prompt. */
async function loginAfterEnter(
  verificationUri: string,
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const agencHome = await mkdtemp(join(tmpdir(), "agenc-auth-cli-open-"));
  // Explicit remote-backend intent: the hermetic suite pins
  // AGENC_AUTH_BACKEND=local by default.
  const env = {
    ...process.env,
    AGENC_HOME: agencHome,
    HOME: agencHome,
    AGENC_AUTH_BACKEND: "remote",
  };
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        deviceCode: "device-1",
        userCode: "USER-1",
        verificationUri,
        intervalSeconds: 0,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        token: "remote-token",
        identity: { accountId: "acct-1", displayName: "Remote User" },
        subscriptionTier: "pro",
      }),
    );
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  let stdout = "";
  const io: AgenCAuthCliIo = {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: { write: () => true } as Pick<NodeJS.WriteStream, "write">,
    stdin: stdin as unknown as NonNullable<AgenCAuthCliIo["stdin"]>,
  };
  await writeFile(
    join(agencHome, "config.toml"),
    "config_version = 2\n\n[auth]\nbackend = \"remote\"\n",
  );
  try {
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
      expect(stdout).toContain("Press Enter to open the browser.");
    });
    stdin.write("\n");
    const exitCode = await login;
    return { exitCode, stdout };
  } finally {
    await rm(agencHome, { recursive: true, force: true });
  }
}

describe("agenc login browser opener", () => {
  let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReset().mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
  });

  it("opens the sign-in link with the shared opener and the whole URL as one argument", async () => {
    const url =
      "https://accounts.example.test/o/oauth2/v2/auth?client_id=a&redirect_uri=b&state=c";
    const { command, args } = browserOpenCommand(url);

    const result = await loginAfterEnter(url);

    expect(result.exitCode).toBe(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith(command, args, {
      detached: true,
      stdio: "ignore",
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(result.stdout).toContain(
      "Browser opened. Complete sign in there, then return here.",
    );
  });

  it("prints a link that is not http(s) instead of opening it", async () => {
    const result = await loginAfterEnter("agenc-desktop://sign-in?state=c");

    expect(result.exitCode).toBe(0);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(result.stdout).toContain(
      "Could not open the browser automatically. Open this URL: agenc-desktop://sign-in?state=c",
    );
  });
});
