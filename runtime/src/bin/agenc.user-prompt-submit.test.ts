import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  __installTuiSessionContractForTest,
  oneShotCLI,
  type PreparedTurnRuntimeInputs,
} from "./agenc.js";
import { defaultConfig } from "../config/schema.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";
import type { PhaseEvent } from "../phases/events.js";

function fakeSession(cwd: string) {
  let installed:
    | {
        submit(message: string): Promise<void>;
        flushEventLog?(): void;
      }
    | null = null;
  const events: unknown[] = [];
  const session = {
    abortController: new AbortController(),
    activeTurn: { unsafePeek: () => null },
    conversationId: "conv-hooks",
    emit: (event: unknown) => {
      events.push(event);
    },
    emitPhaseEvent: (event: PhaseEvent) => {
      events.push(event);
    },
    installTurnDriverHooks: (hooks: typeof installed) => {
      installed = hooks;
    },
    newDefaultTurn: () => ({
      subId: "turn-hooks",
      config: {},
      modelInfo: {},
      collaborationMode: { model: "stub-model" },
    }),
    nextInternalSubId: () => `sub-${events.length + 1}`,
    permissionModeRegistry: {
      current: () => ({ mode: "default" }),
    },
    services: {
      hooks: {
        userPromptSubmitHooks: [] as Array<(input: unknown) => unknown>,
      },
      mcpManager: {
        effectiveServers: async () => new Map(),
      },
    },
    sessionConfiguration: { cwd },
    submit: async (message: string) => {
      if (!installed) throw new Error("submit hook missing");
      await installed.submit(message);
    },
  };
  return { session, events };
}

const EMPTY_TURN_INPUTS: PreparedTurnRuntimeInputs = {
  projectInstructions: "",
  memoryPromptText: "",
  allMemories: [],
  enabledToolNames: new Set(),
  mcpServers: [],
};

function restoreEnv(prevEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in prevEnv)) delete process.env[key];
  }
  Object.assign(process.env, prevEnv);
}

function trustWorkspaceForTest(agencHome: string, workspace: string): void {
  trustProjectSync({
    agencHome,
    projectRoot: workspace,
    env: process.env,
  });
}

async function installOneShotHookConfig(
  agencHome: string,
  scriptName: string,
  script: string,
): Promise<void> {
  const scriptPath = join(agencHome, scriptName);
  await writeFile(scriptPath, script, "utf8");
  const command = `node ${JSON.stringify(scriptPath)}`;
  await writeFile(
    join(agencHome, "config.toml"),
    `
[[hooks.userPromptSubmit]]
hooks = [{ type = "command", command = ${JSON.stringify(command)} }]
`,
    "utf8",
  );
}

async function installOneShotRuntimeSpies() {
  const providerMod = await import("../llm/provider.js");
  const createProviderSpy = vi
    .spyOn(providerMod, "createProvider")
    .mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
  const startMcpSpy = vi
    .spyOn(
      (await import("../session/session.js")).Session.prototype,
      "startMcpManager",
    )
    .mockResolvedValue(undefined);
  const shutdownSpy = vi
    .spyOn(
      (await import("../session/session.js")).Session.prototype,
      "shutdown",
    )
    .mockResolvedValue(undefined);
  const runTurnMod = await import("../session/run-turn.js");
  const runTurnSpy = vi
    .spyOn(runTurnMod, "runTurn")
    .mockImplementation(async function* (): AsyncGenerator<unknown, unknown> {
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      };
      return { reason: "completed" };
    } as never);
  return {
    createProviderSpy,
    startMcpSpy,
    shutdownSpy,
    runTurnSpy,
    restore: () => {
      createProviderSpy.mockRestore();
      startMcpSpy.mockRestore();
      shutdownSpy.mockRestore();
      runTurnSpy.mockRestore();
    },
  };
}

describe("TUI session UserPromptSubmit hooks", () => {
  it("runs hooks through the installed live submit driver before the turn starts", async () => {
    const { session } = fakeSession("/workspace");
    const inputs: unknown[] = [];
    session.services.hooks.userPromptSubmitHooks.push((input) => {
      inputs.push(input);
      return { additionalContexts: ["live hook context"] };
    });
    const runSingleTurnFn = vi.fn(async function* (opts: {
      readonly input: unknown;
    }) {
      inputs.push(opts.input);
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      } satisfies PhaseEvent;
      return { reason: "completed" };
    });
    const uninstall = __installTuiSessionContractForTest({
      session: session as never,
      configStore: { current: () => defaultConfig },
      agencHome: "/tmp/agenc",
      resolvedProvider: "stub",
      autonomousModeEnabled: false,
      loadTurnInputsFn: async () => EMPTY_TURN_INPUTS,
      runSingleTurnFn: runSingleTurnFn as never,
    });

    try {
      await session.submit("hello");
    } finally {
      uninstall();
    }

    expect(inputs[0]).toEqual(
      expect.objectContaining({
        prompt: "hello",
        permissionMode: "default",
        cwd: "/workspace",
      }),
    );
    expect(runSingleTurnFn).toHaveBeenCalledTimes(1);
    expect(String(inputs[1])).toContain("hello");
    expect(String(inputs[1])).toContain("live hook context");
  });

  it("runs live submit hooks before file mention expansion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-prompt-hooks-cwd-"));
    await writeFile(join(cwd, "note.txt"), "file mention body\n", "utf8");
    const { session } = fakeSession(cwd);
    const hookPrompts: unknown[] = [];
    const turnInputs: unknown[] = [];
    session.services.hooks.userPromptSubmitHooks.push((input) => {
      const prompt = (input as { readonly prompt?: unknown }).prompt;
      hookPrompts.push(prompt);
      return {
        additionalContexts: [
          String(prompt).includes("<attached_files>") ? "expanded" : "raw",
        ],
      };
    });
    const runSingleTurnFn = vi.fn(async function* (opts: {
      readonly input: unknown;
    }) {
      turnInputs.push(opts.input);
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      } satisfies PhaseEvent;
      return { reason: "completed" };
    });
    const uninstall = __installTuiSessionContractForTest({
      session: session as never,
      configStore: { current: () => defaultConfig },
      agencHome: "/tmp/agenc",
      resolvedProvider: "stub",
      autonomousModeEnabled: false,
      loadTurnInputsFn: async () => EMPTY_TURN_INPUTS,
      runSingleTurnFn: runSingleTurnFn as never,
    });

    try {
      await session.submit("inspect @note.txt");
    } finally {
      uninstall();
      await rm(cwd, { recursive: true, force: true });
    }

    expect(hookPrompts).toEqual(["inspect @note.txt"]);
    expect(String(turnInputs[0])).toContain("<attached_files>");
    expect(String(turnInputs[0])).toContain("file mention body");
    expect(String(turnInputs[0])).toContain(
      "<hook_additional_context>\nraw\n</hook_additional_context>",
    );
  });

  it("truncates oversized live submit hook context before the turn", async () => {
    const { session } = fakeSession("/workspace");
    const turnInputs: unknown[] = [];
    session.services.hooks.userPromptSubmitHooks.push(() => ({
      additionalContexts: ["x".repeat(10_050)],
    }));
    const runSingleTurnFn = vi.fn(async function* (opts: {
      readonly input: unknown;
    }) {
      turnInputs.push(opts.input);
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      } satisfies PhaseEvent;
      return { reason: "completed" };
    });
    const uninstall = __installTuiSessionContractForTest({
      session: session as never,
      configStore: { current: () => defaultConfig },
      agencHome: "/tmp/agenc",
      resolvedProvider: "stub",
      autonomousModeEnabled: false,
      loadTurnInputsFn: async () => EMPTY_TURN_INPUTS,
      runSingleTurnFn: runSingleTurnFn as never,
    });

    try {
      await session.submit("hello");
    } finally {
      uninstall();
    }

    const modelInput = String(turnInputs[0]);
    expect(modelInput).toContain(
      "[output truncated - exceeded 10000 characters]",
    );
    expect(modelInput).not.toContain("x".repeat(10_050));
  });

  it("blocks the installed live submit driver before runSingleTurn", async () => {
    const { session, events } = fakeSession("/workspace");
    session.services.hooks.userPromptSubmitHooks.push(() => ({
      blockingError: { blockingError: "policy denied" },
    }));
    const runSingleTurnFn = vi.fn(async function* () {
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      } satisfies PhaseEvent;
      return { reason: "completed" };
    });
    const uninstall = __installTuiSessionContractForTest({
      session: session as never,
      configStore: { current: () => defaultConfig },
      agencHome: "/tmp/agenc",
      resolvedProvider: "stub",
      autonomousModeEnabled: false,
      loadTurnInputsFn: async () => EMPTY_TURN_INPUTS,
      runSingleTurnFn: runSingleTurnFn as never,
    });

    try {
      await session.submit("blocked prompt");
    } finally {
      uninstall();
    }

    expect(runSingleTurnFn).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        msg: expect.objectContaining({
          type: "error",
          payload: expect.objectContaining({
            cause: "user_prompt_submit_hook_blocked",
            message: expect.stringContaining("policy denied"),
          }),
        }),
      }),
    );
  });

  it("surfaces live submit hook context when blocking before runSingleTurn", async () => {
    const { session, events } = fakeSession("/workspace");
    session.services.hooks.userPromptSubmitHooks.push(() => ({
      additionalContexts: ["blocked context"],
      blockingError: { blockingError: "policy denied" },
    }));
    const runSingleTurnFn = vi.fn(async function* () {
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      } satisfies PhaseEvent;
      return { reason: "completed" };
    });
    const uninstall = __installTuiSessionContractForTest({
      session: session as never,
      configStore: { current: () => defaultConfig },
      agencHome: "/tmp/agenc",
      resolvedProvider: "stub",
      autonomousModeEnabled: false,
      loadTurnInputsFn: async () => EMPTY_TURN_INPUTS,
      runSingleTurnFn: runSingleTurnFn as never,
    });

    try {
      await session.submit("blocked prompt");
    } finally {
      uninstall();
    }

    expect(runSingleTurnFn).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).toContain(
      "<hook_additional_context>\\nblocked context\\n</hook_additional_context>",
    );
  });

  it("surfaces live submit hook context when preventing continuation", async () => {
    const { session, events } = fakeSession("/workspace");
    session.services.hooks.userPromptSubmitHooks.push(() => ({
      additionalContexts: ["stopped context"],
      preventContinuation: true,
      stopReason: "pause",
    }));
    const runSingleTurnFn = vi.fn(async function* () {
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      } satisfies PhaseEvent;
      return { reason: "completed" };
    });
    const uninstall = __installTuiSessionContractForTest({
      session: session as never,
      configStore: { current: () => defaultConfig },
      agencHome: "/tmp/agenc",
      resolvedProvider: "stub",
      autonomousModeEnabled: false,
      loadTurnInputsFn: async () => EMPTY_TURN_INPUTS,
      runSingleTurnFn: runSingleTurnFn as never,
    });

    try {
      await session.submit("stopped prompt");
    } finally {
      uninstall();
    }

    expect(runSingleTurnFn).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).toContain(
      "<hook_additional_context>\\nstopped context\\n</hook_additional_context>",
    );
  });

  it("warns and continues when an installed live submit hook throws", async () => {
    const { session, events } = fakeSession("/workspace");
    const inputs: unknown[] = [];
    session.services.hooks.userPromptSubmitHooks.push(
      () => {
        throw new Error("hook boom");
      },
      () => ({ additionalContexts: ["context after throw"] }),
    );
    const runSingleTurnFn = vi.fn(async function* (opts: {
      readonly input: unknown;
    }) {
      inputs.push(opts.input);
      yield {
        type: "turn_complete",
        content: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "completed",
      } satisfies PhaseEvent;
      return { reason: "completed" };
    });
    const uninstall = __installTuiSessionContractForTest({
      session: session as never,
      configStore: { current: () => defaultConfig },
      agencHome: "/tmp/agenc",
      resolvedProvider: "stub",
      autonomousModeEnabled: false,
      loadTurnInputsFn: async () => EMPTY_TURN_INPUTS,
      runSingleTurnFn: runSingleTurnFn as never,
    });

    try {
      await session.submit("prompt with throwing hook");
    } finally {
      uninstall();
    }

    expect(runSingleTurnFn).toHaveBeenCalledTimes(1);
    expect(String(inputs[0])).toContain("context after throw");
    expect(events).toContainEqual(
      expect.objectContaining({
        msg: expect.objectContaining({
          type: "warning",
          payload: expect.objectContaining({
            cause: "user_prompt_submit_hook_threw",
            message: expect.stringContaining("hook 0 threw: hook boom"),
          }),
        }),
      }),
    );
  });

  it("runs one-shot prompt hooks before file expansion and appends context", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-one-shot-hook-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-one-shot-hook-cwd-"));
    const prevEnv = { ...process.env };
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const spies = await installOneShotRuntimeSpies();
    await writeFile(join(tmpCwd, "secret.txt"), "one-shot file body\n", "utf8");
    await installOneShotHookConfig(
      tmpHome,
      "prompt-hook.cjs",
      `
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(body);
  const prompt = String(input.prompt);
  const marker = prompt.includes("<attached_files>") ? "expanded" : prompt;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "hook prompt=" + marker
    }
  }));
});
`,
    );

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const code = await oneShotCLI("review @secret.txt");
      expect(code).toBe(0);
      expect(spies.runTurnSpy).toHaveBeenCalledTimes(1);
      const modelInput = String(spies.runTurnSpy.mock.calls[0]?.[2]);
      expect(modelInput).toContain("<attached_files>");
      expect(modelInput).toContain("one-shot file body");
      expect(modelInput).toContain("hook prompt=review @secret.txt");
      expect(modelInput).not.toContain("hook prompt=expanded");
    } finally {
      spies.restore();
      stderrSpy.mockRestore();
      restoreEnv(prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("blocks one-shot prompt hooks before runSingleTurn", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-one-shot-block-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-one-shot-block-cwd-"));
    const prevEnv = { ...process.env };
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const spies = await installOneShotRuntimeSpies();
    await installOneShotHookConfig(
      tmpHome,
      "blocking-prompt-hook.cjs",
      `
process.stderr.write("blocked one-shot prompt");
process.exit(2);
`,
    );

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const code = await oneShotCLI("blocked prompt");
      expect(code).toBe(1);
      expect(spies.runTurnSpy).not.toHaveBeenCalled();
      expect(spies.shutdownSpy).toHaveBeenCalledTimes(1);
      expect(
        stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain("blocked one-shot prompt");
    } finally {
      spies.restore();
      stderrSpy.mockRestore();
      restoreEnv(prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });
});
