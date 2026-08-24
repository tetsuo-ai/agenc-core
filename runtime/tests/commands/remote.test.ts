import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { remoteCommand } from "src/commands/remote.js";
import {
  captureRemoteCliRuntimeContext,
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
): Promise<RemoteFixture & { readonly backend: RemoteAuthBackend }> {
  const fixture = remoteFixture(prefix, {
    AGENC_BACKEND_URL: "https://backend.test",
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
    const fixture = remoteFixture("agenc-remote-no-login-");
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
      await expect(startRemoteOn(fixture.context)).resolves.toEqual({
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

    try {
      await expect(
        runAgenCRemoteCli({ kind: "on" }, fixture.context),
      ).resolves.toBe(1);
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
});
