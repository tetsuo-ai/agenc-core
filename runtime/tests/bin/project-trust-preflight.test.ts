import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachAgentTuiEntry,
  main,
  oneShotCLI,
  resolveAttachTargetTrustRoot,
} from "./agenc-main.js";
import { runProjectTrustPreflightForTui } from "./project-trust-preflight.js";
import {
  getSessionTrustAccepted,
  setSessionTrustAccepted,
} from "../bootstrap/state.js";
import {
  resolveProjectTrustKindSync,
  trustProjectSync,
  trustedProjectsPath,
} from "../permissions/trust/project-trust.js";

/**
 * Give a workspace a repository hook, so trusting it turns something on and
 * the preflight must ask (or refuse when it cannot ask).
 */
async function shipRepoHook(workspace: string): Promise<void> {
  await mkdir(join(workspace, ".agenc"), { recursive: true });
  await writeFile(
    join(workspace, ".agenc", "config.toml"),
    'config_version = 2\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "./notify.sh" }]\n',
    "utf8",
  );
}

function refusalWithHooks(workspace: string): string {
  return (
    `agenc: project is not trusted: ${workspace}\n` +
    "agenc: trusting it turns on hooks; run agenc there in a terminal to review them\n"
  );
}

function makeEnv(home: string, workspace: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENC_HOME: home,
    AGENC_WORKSPACE: workspace,
    HOME: home,
    XAI_API_KEY: "test-key",
  };
}

function makeNonTtyStdio(): {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly stderrText: () => string;
} {
  const stderrChunks: string[] = [];
  return {
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: { isTTY: false } as NodeJS.WriteStream,
    stderr: {
      isTTY: false,
      write: (chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      },
    } as NodeJS.WriteStream,
    stderrText: () => stderrChunks.join(""),
  };
}

function makeTtyStdio(): {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly stderrText: () => string;
} {
  const stdio = makeNonTtyStdio();
  return {
    ...stdio,
    stdin: { isTTY: true } as NodeJS.ReadStream,
    stdout: { isTTY: true } as NodeJS.WriteStream,
  };
}

function replaceProcessArgv(argv: string[]): () => void {
  const previous = process.argv;
  process.argv = argv;
  return () => {
    process.argv = previous;
  };
}

function replaceEnv(key: string, value: string): () => void {
  const previous = process.env[key];
  process.env[key] = value;
  return () => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  };
}

function replaceIsTTY(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  value: boolean,
): () => void {
  const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", {
    configurable: true,
    value,
  });
  return () => {
    if (previous === undefined) {
      Reflect.deleteProperty(stream, "isTTY");
    } else {
      Object.defineProperty(stream, "isTTY", previous);
    }
  };
}

function captureStderr(): {
  readonly text: () => string;
  readonly restore: () => void;
} {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(
    ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write,
  );
  return {
    text: () => chunks.join(""),
    restore: () => {
      spy.mockRestore();
    },
  };
}

async function withMainTrustProcess(
  argv: string[],
  stdio: { readonly stdinTTY: boolean; readonly stdoutTTY: boolean },
  run: (ctx: { readonly home: string; readonly workspace: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "agenc-main-trust-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "agenc-main-trust-ws-"));
  const previousCwd = process.cwd();
  const restoreFns = [
    replaceProcessArgv(argv),
    replaceEnv("AGENC_HOME", home),
    replaceEnv("AGENC_WORKSPACE", workspace),
    replaceEnv("HOME", home),
    replaceIsTTY(process.stdin, stdio.stdinTTY),
    replaceIsTTY(process.stdout, stdio.stdoutTTY),
  ];
  try {
    process.chdir(workspace);
    await run({ home, workspace });
  } finally {
    process.chdir(previousCwd);
    for (const restore of restoreFns.reverse()) restore();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("project trust preflight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects untrusted TUI startup in non-TTY mode without rendering a prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const stdio = makeNonTtyStdio();

    try {
      await shipRepoHook(workspace);
      const result = await runProjectTrustPreflightForTui({
        env: makeEnv(home, workspace),
        argv: ["node", "agenc"],
        cwd: workspace,
        stdin: stdio.stdin,
        stdout: stdio.stdout,
        stderr: stdio.stderr,
      });

      expect(result).toEqual({
        accepted: false,
        projectRoot: workspace,
        prompted: false,
      });
      expect(stdio.stderrText()).toBe(refusalWithHooks(workspace));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts already trusted projects without prompting", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeNonTtyStdio();
    const markSessionTrusted = vi.fn(async () => undefined);

    try {
      trustProjectSync({ agencHome: home, projectRoot: workspace, env });

      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          markSessionTrusted,
        }),
      ).resolves.toEqual({
        accepted: true,
        projectRoot: workspace,
        prompted: false,
      });
      expect(markSessionTrusted).toHaveBeenCalledTimes(1);
      expect(stdio.stderrText()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed on legacy settings before trust enforcement without mutation", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeNonTtyStdio();
    const settingsPath = join(home, "settings.json");

    try {
      await writeFile(
        settingsPath,
        `${JSON.stringify({ fastModePerSessionOptIn: true })}\n`,
        "utf8",
      );

      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
        }),
      ).rejects.toMatchObject({
        code: "retired-input",
        path: settingsPath,
        message: expect.stringMatching(
          /agenc config migrate check.*agenc config migrate apply/u,
        ),
      });
      expect(await readFile(settingsPath, "utf8")).toBe(
        `${JSON.stringify({ fastModePerSessionOptIn: true })}\n`,
      );
      await expect(readFile(join(home, "state.json"), "utf8")).rejects
        .toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses the attach target cwd instead of AGENC_WORKSPACE when requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const envWorkspace = await mkdtemp(join(tmpdir(), "agenc-trust-env-ws-"));
    const attachWorkspace = await mkdtemp(
      join(tmpdir(), "agenc-trust-attach-ws-"),
    );
    const env = makeEnv(home, envWorkspace);
    const stdio = makeNonTtyStdio();

    try {
      trustProjectSync({ agencHome: home, projectRoot: envWorkspace, env });
      await shipRepoHook(attachWorkspace);

      const result = await runProjectTrustPreflightForTui({
        env,
        argv: ["node", "agenc", "agent", "attach", "agent-1"],
        cwd: attachWorkspace,
        stdin: stdio.stdin,
        stdout: stdio.stdout,
        stderr: stdio.stderr,
        useEnvWorkspace: false,
      });

      expect(result).toEqual({
        accepted: false,
        projectRoot: attachWorkspace,
        prompted: false,
      });
      expect(stdio.stderrText()).toBe(refusalWithHooks(attachWorkspace));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(envWorkspace, { recursive: true, force: true });
      await rm(attachWorkspace, { recursive: true, force: true });
    }
  });

  it("uses flag-selected root markers before trust when a profile is selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-trust-marker-root-"));
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const workspace = join(projectRoot, "packages", "worker");
    const flagPath = join(root, "operator.toml");
    const env = makeEnv(home, workspace);
    const stdio = makeNonTtyStdio();
    await mkdir(join(projectRoot, ".agenc"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(projectRoot, ".operator-root"), "", "utf8");
    await writeFile(flagPath, [
      "config_version = 2",
      'project_root_markers = [".operator-root"]',
      "[profiles.operator]",
      'model = "grok-4.5"',
      "",
    ].join("\n"), "utf8");
    await writeFile(
      join(projectRoot, ".agenc", "config.toml"),
      "config_version = 2\nunknown_project_key = true\n",
      "utf8",
    );

    try {
      trustProjectSync({ agencHome: home, projectRoot, env });

      await expect(runProjectTrustPreflightForTui({
        env,
        startupCliFlags: {
          configPath: flagPath,
          profile: "operator",
        },
        cwd: workspace,
        stdin: stdio.stdin,
        stdout: stdio.stdout,
        stderr: stdio.stderr,
        useEnvWorkspace: false,
      })).rejects.toMatchObject({
        code: "unknown-key",
        path: join(projectRoot, ".agenc", "config.toml"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prompts for interactive one-shot no-tui trust and persists acceptance", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeTtyStdio();
    const renderPrompt = vi.fn(async () => true);
    const markSessionTrusted = vi.fn(async () => undefined);

    try {
      await shipRepoHook(workspace);
      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc", "--no-tui", "run", "tools"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          renderPrompt,
          markSessionTrusted,
        }),
      ).resolves.toEqual({
        accepted: true,
        projectRoot: workspace,
        prompted: true,
      });
      expect(renderPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRoot: workspace,
          review: {
            repoItems: [{ label: "Hooks", values: ["./notify.sh when a turn ends"] }],
            userItems: [],
          },
        }),
      );
      expect(markSessionTrusted).toHaveBeenCalledTimes(1);
      expect(stdio.stderrText()).toBe("");
      expect(
        await runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc", "--no-tui", "run", "tools"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          renderPrompt,
          markSessionTrusted,
        }),
      ).toEqual({
        accepted: true,
        projectRoot: workspace,
        prompted: false,
      });
      expect(markSessionTrusted).toHaveBeenCalledTimes(2);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("tells the interactive trust prompt when bypass permissions were requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeTtyStdio();
    const renderPrompt = vi.fn(async () => true);

    try {
      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc", "--dangerously-bypass-approvals-and-sandbox"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          renderPrompt,
        }),
      ).resolves.toMatchObject({
        accepted: true,
        projectRoot: workspace,
        prompted: true,
      });

      expect(renderPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRoot: workspace,
          bypassPermissionsRequested: true,
          bypassSandboxRequested: true,
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("asks even for an automatically trusted folder when approvals are bypassed", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeTtyStdio();
    const renderPrompt = vi.fn(async () => true);

    try {
      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          renderPrompt,
        }),
      ).resolves.toMatchObject({ accepted: true, prompted: false, automatic: true });
      expect(renderPrompt).not.toHaveBeenCalled();

      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc", "--bypass-approvals"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          renderPrompt,
        }),
      ).resolves.toEqual({ accepted: true, projectRoot: workspace, prompted: true });
      expect(renderPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          bypassPermissionsRequested: true,
          bypassSandboxRequested: false,
        }),
      );
      // Confirming under a bypass flag records an explicit grant.
      expect(
        resolveProjectTrustKindSync({ agencHome: home, env, projectRoot: workspace }),
      ).toBe("explicit");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("prompts for interactive agent start trust before daemon readiness", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeTtyStdio();
    const renderPrompt = vi.fn(async () => false);

    try {
      await shipRepoHook(workspace);
      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc", "agent", "start", "do", "work"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          useEnvWorkspace: false,
          renderPrompt,
        }),
      ).resolves.toEqual({
        accepted: false,
        projectRoot: workspace,
        prompted: true,
      });
      expect(renderPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceRoot: workspace }),
      );
      expect(stdio.stderrText()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("bridges accepted project trust into legacy session trust", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeTtyStdio();
    const renderPrompt = vi.fn(async () => true);
    const previousTrust = getSessionTrustAccepted();

    try {
      await shipRepoHook(workspace);
      setSessionTrustAccepted(false);
      expect(getSessionTrustAccepted()).toBe(false);

      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          renderPrompt,
        }),
      ).resolves.toEqual({
        accepted: true,
        projectRoot: workspace,
        prompted: true,
      });

      expect(getSessionTrustAccepted()).toBe(true);
    } finally {
      setSessionTrustAccepted(previousTrust);
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("automatic project trust in the preflight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withFolders(
    run: (ctx: { readonly home: string; readonly workspace: string }) => Promise<void>,
  ): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "agenc-auto-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-auto-trust-ws-"));
    try {
      await run({ home, workspace });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }

  it("starts without a card when trust has nothing to turn on, and records it as automatic", async () => {
    await withFolders(async ({ home, workspace }) => {
      const env = makeEnv(home, workspace);
      const stdio = makeTtyStdio();
      const renderPrompt = vi.fn(async () => true);
      const markSessionTrusted = vi.fn(async () => undefined);
      const run = () =>
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          renderPrompt,
          markSessionTrusted,
        });

      await expect(run()).resolves.toEqual({
        accepted: true,
        projectRoot: workspace,
        prompted: false,
        automatic: true,
      });
      expect(renderPrompt).not.toHaveBeenCalled();
      expect(markSessionTrusted).toHaveBeenCalledTimes(1);
      expect(
        resolveProjectTrustKindSync({ agencHome: home, env, projectRoot: workspace }),
      ).toBe("automatic");
      const ledger = JSON.parse(
        await readFile(trustedProjectsPath({ agencHome: home }), "utf8"),
      );
      expect(ledger.trustedProjects).toEqual([]);

      // The next launch finds the automatic grant still valid.
      await expect(run()).resolves.toEqual({
        accepted: true,
        projectRoot: workspace,
        prompted: false,
      });
      expect(renderPrompt).not.toHaveBeenCalled();
      expect(stdio.stderrText()).toBe("");
    });
  });

  it("lets a headless run start in a folder with nothing to review", async () => {
    await withFolders(async ({ home, workspace }) => {
      const stdio = makeNonTtyStdio();
      await expect(
        runProjectTrustPreflightForTui({
          env: makeEnv(home, workspace),
          argv: ["node", "agenc", "-p", "hello"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          allowPrompt: false,
        }),
      ).resolves.toMatchObject({ accepted: true, prompted: false, automatic: true });
      expect(stdio.stderrText()).toBe("");
    });
  });

  it("asks again once a repo that was trusted automatically adds a hook", async () => {
    await withFolders(async ({ home, workspace }) => {
      const env = makeEnv(home, workspace);
      const tty = makeTtyStdio();
      const renderPrompt = vi.fn(async () => false);
      const options = {
        env,
        argv: ["node", "agenc"],
        cwd: workspace,
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        renderPrompt,
      };
      await expect(runProjectTrustPreflightForTui(options)).resolves.toMatchObject({
        automatic: true,
      });

      await shipRepoHook(workspace);
      expect(
        resolveProjectTrustKindSync({ agencHome: home, env, projectRoot: workspace }),
      ).toBe("none");
      await expect(runProjectTrustPreflightForTui(options)).resolves.toEqual({
        accepted: false,
        projectRoot: workspace,
        prompted: true,
      });
      expect(renderPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          review: {
            repoItems: [{ label: "Hooks", values: ["./notify.sh when a turn ends"] }],
            userItems: [],
          },
        }),
      );

      const headless = makeNonTtyStdio();
      await expect(
        runProjectTrustPreflightForTui({
          ...options,
          stdin: headless.stdin,
          stdout: headless.stdout,
          stderr: headless.stderr,
        }),
      ).resolves.toMatchObject({ accepted: false, prompted: false });
      expect(headless.stderrText()).toBe(refusalWithHooks(workspace));
    });
  });

  it("asks when the user's own hooks would start running in the folder", async () => {
    await withFolders(async ({ home, workspace }) => {
      await writeFile(
        join(home, "config.toml"),
        'config_version = 2\n[statusLine]\ntype = "command"\ncommand = "~/bin/status.sh"\n',
        "utf8",
      );
      const stdio = makeTtyStdio();
      const renderPrompt = vi.fn(async () => true);
      await expect(
        runProjectTrustPreflightForTui({
          env: makeEnv(home, workspace),
          argv: ["node", "agenc"],
          cwd: workspace,
          stdin: stdio.stdin,
          stdout: stdio.stdout,
          stderr: stdio.stderr,
          renderPrompt,
        }),
      ).resolves.toEqual({ accepted: true, projectRoot: workspace, prompted: true });
      expect(renderPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          review: {
            repoItems: [],
            userItems: [{ label: "Status line", values: ["~/bin/status.sh"] }],
          },
        }),
      );
    });
  });

  it("never trusts the home folder automatically", async () => {
    await withFolders(async ({ home, workspace }) => {
      const env = { ...makeEnv(home, workspace), HOME: workspace };
      const tty = makeTtyStdio();
      const renderPrompt = vi.fn(async () => false);
      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc"],
          cwd: workspace,
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          renderPrompt,
        }),
      ).resolves.toMatchObject({ accepted: false, prompted: true });
      expect(renderPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ location: "home" }),
      );

      const headless = makeNonTtyStdio();
      await expect(
        runProjectTrustPreflightForTui({
          env,
          argv: ["node", "agenc"],
          cwd: workspace,
          stdin: headless.stdin,
          stdout: headless.stdout,
          stderr: headless.stderr,
        }),
      ).resolves.toMatchObject({ accepted: false, prompted: false });
      expect(headless.stderrText()).toBe(
        `agenc: project is not trusted: ${workspace}\n` +
          "agenc: it is your home folder; run agenc there in a terminal to confirm\n",
      );
    });
  });
});

describe("resolveAttachTargetTrustRoot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds the attach target cwd before agent.attach mutates daemon state", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        agents: [{ agentId: "other", cwd: "/tmp/other" }],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        agents: [{ agentId: "agent-1", cwd: "/tmp/target" }],
      });
    const client = { request } as unknown as Parameters<
      typeof resolveAttachTargetTrustRoot
    >[0];

    await expect(
      resolveAttachTargetTrustRoot(client, "agent-1"),
    ).resolves.toBe("/tmp/target");
    expect(request).toHaveBeenNthCalledWith(1, "agent.list", { limit: 100 });
    expect(request).toHaveBeenNthCalledWith(2, "agent.list", {
      limit: 100,
      cursor: "next",
    });
  });

  it("fails closed when daemon metadata has no cwd for the attach target", async () => {
    const request = vi.fn().mockResolvedValue({
      agents: [{ agentId: "agent-1", cwd: "" }],
    });
    const client = { request } as unknown as Parameters<
      typeof resolveAttachTargetTrustRoot
    >[0];

    await expect(resolveAttachTargetTrustRoot(client, "agent-1")).rejects.toThrow(
      /no workspace metadata/,
    );
  });

  it("attach trust preflight uses captured startup flags instead of ambient argv", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-attach-flags-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-attach-flags-ws-"));
    const configPath = join(workspace, "operator.toml");
    await writeFile(configPath, "config_version = 2\n", "utf8");
    await shipRepoHook(workspace);
    const request = vi.fn(async (method: string) => {
      if (method === "agent.list") {
        return { agents: [{ agentId: "agent-1", cwd: workspace }] };
      }
      throw new Error(`unexpected daemon request: ${method}`);
    });
    const close = vi.fn(async () => undefined);
    const daemonClient = { request, close } as unknown as NonNullable<
      Parameters<typeof attachAgentTuiEntry>[0]["daemonClient"]
    >;
    const restoreFns = [
      replaceProcessArgv([
        "node",
        "agenc",
        "--config",
        "ambient-missing.toml",
        "agent",
        "attach",
        "agent-1",
      ]),
      replaceIsTTY(process.stdin, false),
      replaceIsTTY(process.stdout, false),
    ];
    const stderr = captureStderr();

    try {
      await expect(attachAgentTuiEntry({
        agentId: "agent-1",
        clientId: "client-1",
        env: makeEnv(home, workspace),
        startupCliFlags: { configPath },
        daemonClient,
      })).resolves.toBe(1);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("agent.list", { limit: 100 });
      expect(close).toHaveBeenCalledTimes(1);
      expect(stderr.text()).toBe(refusalWithHooks(workspace));
    } finally {
      stderr.restore();
      for (const restore of restoreFns.reverse()) restore();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("main project trust routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed before direct oneShotCLI calls can bootstrap tools", async () => {
    await withMainTrustProcess(
      ["node", "agenc", "--no-tui", "run", "tools"],
      { stdinTTY: false, stdoutTTY: false },
      async ({ workspace }) => {
        await shipRepoHook(workspace);
        const providerMod = await import("../llm/provider.js");
        const createProviderSpy = vi.spyOn(providerMod, "createProvider");
        const startMcpSpy = vi.spyOn(
          (await import("../session/session.js")).Session.prototype,
          "startMcpManager",
        );
        const stderr = captureStderr();
        try {
          await expect(oneShotCLI("run tools")).resolves.toBe(1);
          expect(createProviderSpy).not.toHaveBeenCalled();
          expect(startMcpSpy).not.toHaveBeenCalled();
          expect(stderr.text()).toBe(refusalWithHooks(workspace));
        } finally {
          stderr.restore();
          createProviderSpy.mockRestore();
          startMcpSpy.mockRestore();
        }
      },
    );
  });

  it("fails closed before non-interactive one-shot --no-tui --dangerously-bypass-approvals-and-sandbox can bootstrap tools", async () => {
    await withMainTrustProcess(
      ["node", "agenc", "--dangerously-bypass-approvals-and-sandbox", "--no-tui", "run", "tools"],
      { stdinTTY: false, stdoutTTY: false },
      async ({ workspace }) => {
        const stderr = captureStderr();
        try {
          await expect(main()).resolves.toBe(1);
          expect(stderr.text()).toBe(
            `agenc: project is not trusted: ${workspace}\n`,
          );
        } finally {
          stderr.restore();
        }
      },
    );
  });

  it("fails closed before piped one-shot input can bootstrap tools", async () => {
    await withMainTrustProcess(
      ["node", "agenc", "run", "tools"],
      { stdinTTY: false, stdoutTTY: false },
      async ({ workspace }) => {
        await shipRepoHook(workspace);
        const stderr = captureStderr();
        try {
          await expect(main()).resolves.toBe(1);
          expect(stderr.text()).toBe(refusalWithHooks(workspace));
        } finally {
          stderr.restore();
        }
      },
    );
  });

  it("fails closed before agent start can autostart the daemon", async () => {
    await withMainTrustProcess(
      ["node", "agenc", "agent", "start", "do", "work"],
      { stdinTTY: false, stdoutTTY: false },
      async ({ workspace }) => {
        await shipRepoHook(workspace);
        const stderr = captureStderr();
        try {
          await expect(main()).resolves.toBe(1);
          expect(stderr.text()).toContain(
            `agenc: project is not trusted: ${workspace}\n`,
          );
          expect(stderr.text()).toContain(
            "agenc: project trust was not accepted\n",
          );
        } finally {
          stderr.restore();
        }
      },
    );
  });

  it("checks the agent start cwd instead of trusting AGENC_WORKSPACE", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-main-trust-home-"));
    const envWorkspace = await mkdtemp(join(tmpdir(), "agenc-main-trust-env-ws-"));
    const agentCwd = await mkdtemp(join(tmpdir(), "agenc-main-trust-agent-ws-"));
    const previousCwd = process.cwd();
    const restoreFns = [
      replaceProcessArgv(["node", "agenc", "agent", "start", "do", "work"]),
      replaceEnv("AGENC_HOME", home),
      replaceEnv("AGENC_WORKSPACE", envWorkspace),
      replaceEnv("HOME", home),
      replaceIsTTY(process.stdin, false),
      replaceIsTTY(process.stdout, false),
    ];
    const stderr = captureStderr();
    try {
      trustProjectSync({
        agencHome: home,
        projectRoot: envWorkspace,
        env: process.env,
      });
      await shipRepoHook(agentCwd);
      process.chdir(agentCwd);

      await expect(main()).resolves.toBe(1);
      expect(stderr.text()).toContain(
        `agenc: project is not trusted: ${agentCwd}\n`,
      );
      expect(stderr.text()).toContain(
        "agenc: project trust was not accepted\n",
      );
      expect(stderr.text()).not.toContain(
        `agenc: project is not trusted: ${envWorkspace}\n`,
      );
    } finally {
      process.chdir(previousCwd);
      stderr.restore();
      for (const restore of restoreFns.reverse()) restore();
      await rm(home, { recursive: true, force: true });
      await rm(envWorkspace, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  });
});
