import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  main,
  oneShotCLI,
  resolveAttachTargetTrustRoot,
  runProjectTrustPreflightForTui,
} from "./agenc-main.js";
import {
  getSessionTrustAccepted,
  setSessionTrustAccepted,
} from "../bootstrap/state.js";
import { YOLO_TRUST_COPY } from "../permissions/trust/TrustDialog.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";

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
      expect(stdio.stderrText()).toBe(
        `agenc: project is not trusted: ${workspace}\n`,
      );
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

  it("runs startup config migrations before trust enforcement", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeNonTtyStdio();
    const settingsPath = join(home, ".agenc", "settings.json");

    try {
      await mkdir(join(home, ".agenc"), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({ bypassPermissionsModeAccepted: true })}\n`,
        "utf8",
      );

      const result = await runProjectTrustPreflightForTui({
        env,
        argv: ["node", "agenc"],
        cwd: workspace,
        stdin: stdio.stdin,
        stdout: stdio.stdout,
        stderr: stdio.stderr,
      });

      expect(result.accepted).toBe(false);
      const migrated = JSON.parse(
        await readFile(settingsPath, "utf8"),
      ) as Record<string, unknown>;
      expect(migrated.bypassPermissionsModeAccepted).toBeUndefined();
      expect(migrated.bypassPermissionsModeAcceptedIn).toEqual([workspace]);
      expect(migrated.configMigrationVersion).toBe(11);
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
      expect(stdio.stderrText()).toBe(
        `agenc: project is not trusted: ${attachWorkspace}\n`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(envWorkspace, { recursive: true, force: true });
      await rm(attachWorkspace, { recursive: true, force: true });
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
        expect.objectContaining({ workspaceRoot: workspace }),
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
          argv: ["node", "agenc", "--yolo"],
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
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("explains both approval bypass and sandbox bypass in --yolo trust copy", () => {
    expect(YOLO_TRUST_COPY).toContain("skips tool approval prompts");
    expect(YOLO_TRUST_COPY).toContain("danger-full-access sandbox mode");
    expect(YOLO_TRUST_COPY).toContain("project trust still requires confirmation");
  });

  it("prompts for interactive agent start trust before daemon readiness", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-trust-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-trust-ws-"));
    const env = makeEnv(home, workspace);
    const stdio = makeTtyStdio();
    const renderPrompt = vi.fn(async () => false);

    try {
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
          expect(stderr.text()).toBe(
            `agenc: project is not trusted: ${workspace}\n`,
          );
        } finally {
          stderr.restore();
          createProviderSpy.mockRestore();
          startMcpSpy.mockRestore();
        }
      },
    );
  });

  it("fails closed before non-interactive one-shot --no-tui --yolo can bootstrap tools", async () => {
    await withMainTrustProcess(
      ["node", "agenc", "--yolo", "--no-tui", "run", "tools"],
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

  it("fails closed before agent start can autostart the daemon", async () => {
    await withMainTrustProcess(
      ["node", "agenc", "agent", "start", "do", "work"],
      { stdinTTY: false, stdoutTTY: false },
      async ({ workspace }) => {
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
