import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { remoteCommand } from "src/commands/remote.js";
import {
  captureRemoteCliRuntimeContext,
  parseAgenCRemoteCliArgs,
  parseRemoteSlashArgs,
  runAgenCRemoteCli,
  runRemoteSlash,
  startRemoteOn,
  type RemoteCliRuntimeContext,
} from "src/bin/remote-cli.js";
import { RemoteAuthBackend } from "src/auth/backends/remote.js";
import type { ConfigStore } from "src/config/store.js";
import type { Session } from "src/session/session.js";

afterEach(() => {
  vi.restoreAllMocks();
});

interface RemoteFixture {
  readonly context: RemoteCliRuntimeContext;
  readonly cleanup: () => void;
}

function remoteFixture(
  prefix: string,
  environment: Readonly<Record<string, string>> = {},
): RemoteFixture {
  const agencHome = mkdtempSync(join(tmpdir(), prefix));
  const context = captureRemoteCliRuntimeContext(
    Object.freeze({
      AGENC_HOME: agencHome,
      ...environment,
    }),
  );
  return {
    context,
    cleanup: () => rmSync(agencHome, { recursive: true, force: true }),
  };
}

async function loginRemoteFixture(
  prefix: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<RemoteFixture & { readonly backend: RemoteAuthBackend }> {
  const fixture = remoteFixture(prefix, {
    AGENC_BACKEND_URL: "https://backend.test",
    ...environment,
  });
  const backend = new RemoteAuthBackend({
    agencHome: fixture.context.home.path,
    env: fixture.context.environment,
    loginFlow: () => ({ token: "core-login-token" }),
    now: () => new Date("2026-07-11T00:00:00.000Z"),
  });
  await backend.login();
  return { ...fixture, backend };
}

function slashCommandContext(
  context: RemoteCliRuntimeContext,
): Parameters<typeof remoteCommand.execute>[0] {
  const configStore = {
    homeContext: context.home,
    current: () => ({}) as ReturnType<ConfigStore["current"]>,
  };
  const session = {
    services: {
      configStore,
      providerEnvironment: context.environment,
    },
  } as unknown as Session;
  return {
    session,
    argsRaw: "status",
    cwd: "/workspace",
    home: tmpdir(),
  };
}

describe("/remote slash command", () => {
  it("is an immediate command named remote", () => {
    expect(remoteCommand.name).toBe("remote");
    expect(remoteCommand.immediate).toBe(true);
    expect(remoteCommand.description.toLowerCase()).toContain("phone");
  });

  it("status returns a link-state line without touching the network", async () => {
    const fixture = remoteFixture("agenc-remote-status-");
    try {
      const text = await runRemoteSlash("status", fixture.context);
      expect(typeof text).toBe("string");
      expect(text.toLowerCase()).toMatch(/link/);
    } finally {
      fixture.cleanup();
    }
  });

  it("execute returns a { kind: 'text' } result", async () => {
    const fixture = remoteFixture("agenc-remote-command-");
    try {
      const result = await remoteCommand.execute(
        slashCommandContext(fixture.context),
      );
      expect(result.kind).toBe("text");
    } finally {
      fixture.cleanup();
    }
  });

  it("does not create a mobile sign-in code without a remote login session", async () => {
    const fixture = remoteFixture("agenc-remote-no-login-", { AGENC_REMOTE_FULL_CONTROL: "1" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network should not be touched"));
    try {
      const result = await startRemoteOn(fixture.context);

      expect(result).toEqual({
        message:
          "Not logged in. Run `/login` in the TUI or `AGENC_AUTH_BACKEND=remote agenc login` before using remote pairing.",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("sends the Core login bearer when creating the mobile bootstrap code", async () => {
    const fixture = await loginRemoteFixture("agenc-remote-bearer-");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "stop-after-observation" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      await expect(startRemoteOn(fixture.context, { fullControl: true })).resolves.toEqual({
        message: "Could not start pairing (503). Check your connection.",
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, request] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://backend.test/v1/pair/start");
      expect(request.headers).toEqual({
        "content-type": "application/json",
        authorization: "Bearer core-login-token",
      });
      expect(JSON.parse(String(request.body))).toEqual({
        machineName: expect.any(String),
      });
    } finally {
      await fixture.backend.logout();
      fixture.cleanup();
    }
  });

  it("sends the Core login bearer from foreground `agenc remote on`", async () => {
    const fixture = await loginRemoteFixture("agenc-remote-cli-bearer-");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "stop-after-observation" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(
        runAgenCRemoteCli({ kind: "on", fullControl: true }, fixture.context),
      ).resolves.toBe(1);
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        "Warning: a paired phone gets full control of this computer's AgenC.",
      );
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, request] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://backend.test/v1/pair/start");
      expect(request.headers).toEqual({
        "content-type": "application/json",
        authorization: "Bearer core-login-token",
      });
      expect(JSON.parse(String(request.body))).toEqual({
        machineName: expect.any(String),
      });
    } finally {
      await fixture.backend.logout();
      fixture.cleanup();
    }
  });

  it("is off by default: every start surface refuses before reading a login or touching the network", async () => {
    const fixture = await loginRemoteFixture("agenc-remote-off-by-default-");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network should not be touched"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const started = await startRemoteOn(fixture.context);
      expect("message" in started ? started.message : "").toMatch(/^Phone remote control is off\./u);
      expect("message" in started ? started.message : "").toContain("/remote on --full-control");
      expect("message" in started ? started.message : "").toContain("AGENC_REMOTE_FULL_CONTROL=1");
      expect(await runRemoteSlash("on", fixture.context)).toMatch(/^Phone remote control is off\./u);
      expect(await runRemoteSlash("", fixture.context)).toMatch(/^Phone remote control is off\./u);
      expect(await runAgenCRemoteCli({ kind: "on" }, fixture.context)).toBe(1);
      const refusal = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(refusal).toContain("Phone remote control is off.");
      expect(refusal).toContain("agenc remote on --full-control");
      expect(stdout).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      // status and off never needed the opt-in.
      expect((await runRemoteSlash("status", fixture.context)).toLowerCase()).toMatch(/link/);
    } finally {
      await fixture.backend.logout();
      fixture.cleanup();
    }
  });

  it("turns on with the flag for one run or with the environment key, and says what that means", async () => {
    expect(parseAgenCRemoteCliArgs(["remote", "on"])).toEqual({ kind: "on", fullControl: false });
    expect(parseAgenCRemoteCliArgs(["remote", "on", "--full-control"])).toEqual({ kind: "on", fullControl: true });
    expect(parseAgenCRemoteCliArgs(["remote", "on", "--yes"])).toEqual({ kind: "help" });
    expect(parseRemoteSlashArgs("on --full-control")).toEqual({ sub: "on", fullControl: true });
    expect(parseRemoteSlashArgs("--full-control")).toEqual({ sub: "on", fullControl: true });
    expect(parseRemoteSlashArgs("status")).toEqual({ sub: "status", fullControl: false });
    const fixture = await loginRemoteFixture("agenc-remote-opt-in-", { AGENC_REMOTE_FULL_CONTROL: "1" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "stop-after-observation" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await expect(startRemoteOn(fixture.context)).resolves.toEqual({
        message: "Could not start pairing (503). Check your connection.",
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://backend.test/v1/pair/start");
    } finally {
      await fixture.backend.logout();
      fixture.cleanup();
    }
  });
});
