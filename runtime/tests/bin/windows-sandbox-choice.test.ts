import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireWindowsSandboxChoiceBeforeTui } from "../../src/bin/default-cli-route.js";
import {
  WINDOWS_SANDBOX_QUIT_MESSAGE,
  requireWindowsSandboxChoiceForTui,
  runWindowsSandboxChoiceForTui,
} from "../../src/bin/windows-sandbox-choice.js";
import type { SandboxExecutionStatus } from "../../src/sandbox/execution-broker.js";

const ARGV = ["node", "agenc"];

function windowsStatus(
  kind: SandboxExecutionStatus["kind"] = "unavailable",
): SandboxExecutionStatus {
  return {
    kind,
    mode: "workspace_write",
    platform: "win32",
    ...(kind === "unavailable"
      ? { reason: "Windows restricted-token sandbox is not implemented" }
      : {}),
  };
}

function terminal(isTTY = true): {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
} {
  return {
    stdin: { isTTY } as NodeJS.ReadStream,
    stdout: { isTTY } as NodeJS.WriteStream,
  };
}

describe("Windows no-sandbox card", () => {
  let home = "";
  let workspace = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agenc-win-home-"));
    workspace = await mkdtemp(join(tmpdir(), "agenc-win-ws-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  function env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      AGENC_HOME: home,
      AGENC_WORKSPACE: workspace,
      HOME: home,
    };
  }

  async function savedConfig(): Promise<string> {
    return readFile(join(home, "config.toml"), "utf8").catch(() => "");
  }

  it("asks once on Windows and remembers continue as danger-full-access", async () => {
    const probe = vi.fn(() => windowsStatus());
    const renderPrompt = vi.fn(async () => true);

    await expect(
      runWindowsSandboxChoiceForTui({
        env: env(),
        argv: ARGV,
        cwd: workspace,
        platform: "win32",
        probe,
        renderPrompt,
        ...terminal(),
      }),
    ).resolves.toEqual({
      kind: "continued",
      configPath: join(home, "config.toml"),
    });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "workspace_write", platform: "win32" }),
    );
    expect(renderPrompt).toHaveBeenCalledTimes(1);
    expect(await savedConfig()).toMatch(
      /"?sandbox_mode"?\s*=\s*"danger-full-access"/,
    );

    const nextLaunch = vi.fn(async () => true);
    await expect(
      runWindowsSandboxChoiceForTui({
        env: env(),
        argv: ARGV,
        cwd: workspace,
        platform: "win32",
        probe,
        renderPrompt: nextLaunch,
        ...terminal(),
      }),
    ).resolves.toEqual({ kind: "not_needed" });
    expect(nextLaunch).not.toHaveBeenCalled();
  });

  it("saves nothing when the user quits, so the card returns next time", async () => {
    const renderPrompt = vi.fn(async () => false);
    const stderr = { write: vi.fn(() => true) } as unknown as NodeJS.WriteStream;

    await expect(
      requireWindowsSandboxChoiceForTui({
        env: env(),
        argv: ARGV,
        cwd: workspace,
        platform: "win32",
        probe: () => windowsStatus(),
        renderPrompt,
        stderr,
        ...terminal(),
      }),
    ).resolves.toBe(false);
    expect(stderr.write).toHaveBeenCalledExactlyOnceWith(
      WINDOWS_SANDBOX_QUIT_MESSAGE,
    );
    expect(await savedConfig()).not.toContain("sandbox_mode");

    await expect(
      runWindowsSandboxChoiceForTui({
        env: env(),
        argv: ARGV,
        cwd: workspace,
        platform: "win32",
        probe: () => windowsStatus(),
        renderPrompt,
        ...terminal(),
      }),
    ).resolves.toEqual({ kind: "quit" });
    expect(renderPrompt).toHaveBeenCalledTimes(2);
  });

  it.each(["darwin", "linux"] as const)("never asks on %s", async (platform) => {
    const probe = vi.fn(() => windowsStatus());
    const renderPrompt = vi.fn(async () => true);
    await expect(
      runWindowsSandboxChoiceForTui({
        env: env(),
        argv: ARGV,
        cwd: workspace,
        platform,
        probe,
        renderPrompt,
        ...terminal(),
      }),
    ).resolves.toEqual({ kind: "not_needed" });
    expect(probe).not.toHaveBeenCalled();
    expect(renderPrompt).not.toHaveBeenCalled();
  });

  it.each(["--bypass-approvals", "--dangerously-bypass-approvals-and-sandbox"])(
    "does not ask when %s already runs without a sandbox",
    async (flag) => {
      const renderPrompt = vi.fn(async () => true);
      await expect(
        runWindowsSandboxChoiceForTui({
          env: env(),
          argv: [...ARGV, flag],
          cwd: workspace,
          platform: "win32",
          probe: () => windowsStatus(),
          renderPrompt,
          ...terminal(),
        }),
      ).resolves.toEqual({ kind: "not_needed" });
      expect(renderPrompt).not.toHaveBeenCalled();
    },
  );

  it.each(["workspace-write", "read-only", "danger-full-access"])(
    "keeps sandbox_mode = %s that the user set",
    async (mode) => {
      const config = `config_version = 2\nsandbox_mode = "${mode}"\n`;
      await writeFile(join(home, "config.toml"), config, "utf8");
      const renderPrompt = vi.fn(async () => true);
      await expect(
        runWindowsSandboxChoiceForTui({
          env: env(),
          argv: ARGV,
          cwd: workspace,
          platform: "win32",
          probe: () => windowsStatus(),
          renderPrompt,
          ...terminal(),
        }),
      ).resolves.toEqual({ kind: "not_needed" });
      expect(renderPrompt).not.toHaveBeenCalled();
      expect(await savedConfig()).toBe(config);
    },
  );

  it.each(["ready", "external"] as const)(
    "does not ask when the host reports a %s sandbox",
    async (kind) => {
      const renderPrompt = vi.fn(async () => true);
      await expect(
        runWindowsSandboxChoiceForTui({
          env: env(),
          argv: ARGV,
          cwd: workspace,
          platform: "win32",
          probe: () => windowsStatus(kind),
          renderPrompt,
          ...terminal(),
        }),
      ).resolves.toEqual({ kind: "not_needed" });
      expect(renderPrompt).not.toHaveBeenCalled();
    },
  );

  it("is a no-op off Windows at the CLI route and asks on Windows", async () => {
    const renderPrompt = vi.fn(async () => false);
    const stderr = { write: vi.fn(() => true) } as unknown as NodeJS.WriteStream;
    await expect(
      requireWindowsSandboxChoiceBeforeTui({ platform: "linux", renderPrompt, stderr }),
    ).resolves.toBe(true);
    expect(renderPrompt).not.toHaveBeenCalled();
    await expect(
      requireWindowsSandboxChoiceBeforeTui({
        env: env(),
        argv: ARGV,
        cwd: workspace,
        platform: "win32",
        probe: () => windowsStatus(),
        renderPrompt,
        stderr,
        ...terminal(),
      }),
    ).resolves.toBe(false);
    expect(renderPrompt).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses to start when the answer cannot be saved",
    async () => {
      await chmod(home, 0o500);
      const stderr = { write: vi.fn(() => true) } as unknown as NodeJS.WriteStream;
      try {
        await expect(
          requireWindowsSandboxChoiceForTui({
            env: env(),
            argv: ARGV,
            cwd: workspace,
            platform: "win32",
            probe: () => windowsStatus(),
            renderPrompt: async () => true,
            stderr,
            ...terminal(),
          }),
        ).resolves.toBe(false);
        expect(stderr.write).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(
            new RegExp(`^agenc: could not save sandbox_mode in ${join(home, "config.toml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `),
          ),
        );
      } finally {
        await chmod(home, 0o700);
      }
    },
  );

  it("leaves a run without a terminal to the existing refusal", async () => {
    const renderPrompt = vi.fn(async () => true);
    await expect(
      requireWindowsSandboxChoiceForTui({
        env: env(),
        argv: ARGV,
        cwd: workspace,
        platform: "win32",
        probe: () => windowsStatus(),
        renderPrompt,
        ...terminal(false),
      }),
    ).resolves.toBe(true);
    expect(renderPrompt).not.toHaveBeenCalled();
    expect(await savedConfig()).not.toContain("sandbox_mode");
  });
});
