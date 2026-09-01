import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapLocalRuntimeSession } from "./bootstrap.js";
import { readStartupCliFlags } from "../bin/startup-selection.js";
import { defaultConfig } from "../config/schema.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";
import type { AuthBackend } from "../auth/backend.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import type { Tool } from "../tools/types.js";
import type { RolloutItem } from "../session/rollout-item.js";
import { RolloutStore } from "../session/rollout-store.js";
import { Session } from "../session/session.js";
import { buildAgenCToolUseContext } from "../session/agenc-tool-use-context.js";
import { ExecutionAdmissionKernel } from "../budget/execution-admission-kernel.js";
import {
  _resetAgentRolesForTesting,
  createAgentRoleWorkspace,
  registerAgentRole,
} from "../agents/role.js";
import { findAgentDefinitionByType } from "../tools/AgentTool/loadAgentsDir.js";
import { SidecarManager } from "../session/sidecar.js";
import { getCurrentRuntimeSession } from "./_deps/current-session.js";
import {
  isSandboxExecutionBrokerDisposed,
  registerSandboxExecutionLifecycleParticipant,
  transitionSandboxExecutionBroker,
} from "../sandbox/execution-lifecycle.js";
import {
  adaptTranscriptEvents,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
} from "../tui/session-transcript.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../prompts/system-prompt-boundary.js";
import {
  MAX_ADDITIONAL_WORKING_DIRECTORIES,
} from "../contracts/additional-working-directories.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function offlineFetchFixture(): typeof fetch {
  return vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("offline bootstrap fixture"));
}

async function installBootstrapProviderStub(): Promise<void> {
  const providerModule = await import("../llm/provider.js");
  const chat = vi.fn().mockResolvedValue({
    content: "ok",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  });
  vi.spyOn(providerModule, "createProvider").mockReturnValue({
    name: "stub",
    chat,
  } as never);
}

function clearProcessEnv(keys: readonly string[]): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function trustWorkspaceForTest(agencHome: string, workspace: string): void {
  trustProjectSync({
    agencHome,
    cwd: workspace,
    env: { HOME: agencHome },
  });
}

function rolloutEvent(
  id: string,
  type: string,
  payload: unknown,
  seq: number,
): RolloutItem {
  return {
    type: "event_msg",
    payload: {
      eventId: `bootstrap:${seq}:${id}`,
      id,
      seq,
      msg: { type, payload },
    },
  } as unknown as RolloutItem;
}

function nextRolloutEventSequence(rolloutStore: RolloutStore): number {
  return (
    Math.max(
      0,
      ...rolloutStore.readAll().flatMap((item) =>
        item.type === "event_msg" && typeof item.payload.seq === "number"
          ? [item.payload.seq]
          : [],
      ),
    ) + 1
  );
}

describe("readStartupCliFlags", () => {
  it("parses only the canonical permission and autonomy startup flags", () => {
    expect(
      readStartupCliFlags([
        "node",
        "agenc",
        "--permission-mode",
        "plan",
        "--dangerously-bypass-approvals-and-sandbox",
        "--autonomous",
      ]),
    ).toMatchObject({
      permissionMode: "plan",
      dangerouslyBypassApprovalsAndSandbox: true,
      autonomousMode: true,
    });
  });

  it("preserves spaced, equals, and repeated additional-directory flags", () => {
    expect(
      readStartupCliFlags([
        "node",
        "agenc",
        "--add-dir",
        "../shared workspace",
        "--add-dir=/tmp/shared",
        "--add-dir=/tmp/shared",
        "--add-dir=-third",
        "build",
        "the app",
      ]),
    ).toMatchObject({
      addDirs: ["../shared workspace", "/tmp/shared", "-third"],
    });
  });

  it("rejects raw additional-directory overflow before duplicate collapse and bootstrap work", async () => {
    const addDirArgs = Array.from(
      { length: MAX_ADDITIONAL_WORKING_DIRECTORIES + 1 },
      () => "--add-dir=/tmp/repeated",
    );

    expect(() =>
      readStartupCliFlags(["node", "agenc", ...addDirArgs]),
    ).toThrow(
      `agenc --add-dir accepts at most ${MAX_ADDITIONAL_WORKING_DIRECTORIES} paths`,
    );
    await expect(
      bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        cwd: process.cwd(),
        argv: ["node", "agenc", ...addDirArgs],
      }),
    ).rejects.toThrow(
      `agenc --add-dir accepts at most ${MAX_ADDITIONAL_WORKING_DIRECTORIES} paths`,
    );
  });

  it("rejects internal modes at the startup permission surface", () => {
    expect(() =>
      readStartupCliFlags([
        "node",
        "agenc",
        "--permission-mode",
        "unattended",
      ]),
    ).toThrow("unknown permission mode 'unattended'. Expected one of:");
  });
});

describe("bootstrapLocalRuntimeSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetAgentRolesForTesting();
  });

  it("projects CLI additional directories into permissions and the sandbox authority", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-add-dir-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "agenc-bootstrap-add-dir-ws-"),
    );
    const firstAdditional = join(workspace, "shared workspace");
    const secondAdditional = await mkdtemp(
      join(tmpdir(), "agenc-bootstrap-add-dir-external-"),
    );
    const regularFile = join(workspace, "not-a-directory.txt");
    await mkdir(join(workspace, ".git"));
    await mkdir(firstAdditional);
    await writeFile(regularFile, "not a directory", "utf8");
    trustWorkspaceForTest(home, workspace);

    await installBootstrapProviderStub();
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        cwd: workspace,
        argv: [
          "node",
          "agenc",
          "--add-dir",
          "shared workspace",
          "--add-dir=shared workspace",
          `--add-dir=${secondAdditional}`,
          "--add-dir",
          regularFile,
        ],
        env: {
          ...process.env,
          AGENC_HOME: home,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      const additionalDirectories = [
        ...boot.session.permissionModeRegistry
          .current()
          .additionalWorkingDirectories.values(),
      ];
      expect(additionalDirectories).toEqual([
        { path: firstAdditional, source: "cliArg" },
        { path: secondAdditional, source: "cliArg" },
      ]);
      expect(
        boot.configuredExecutionAuthority.fileSystemSandboxPolicy.allowWrite,
      ).toEqual([workspace, firstAdditional, secondAdditional]);
      expect(
        boot.session.permissionModeRegistry
          .current()
          .additionalWorkingDirectories.has(regularFile),
      ).toBe(false);
      expect(
        boot.session.services.sandboxExecutionBroker?.mode,
      ).toBe("workspace_write");
    } finally {
      await shutdown?.().catch(() => {});
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(secondAdditional, { recursive: true, force: true });
    }
  });

  it("resolves mode, trust, and reloaded-config authority from the live broker cwd after rebase", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-authority-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "agenc-bootstrap-authority-ws-"),
    );
    const rebasedWorkspace = await mkdtemp(
      join(tmpdir(), "agenc-bootstrap-authority-rebased-"),
    );
    await mkdir(join(workspace, ".git"));
    await mkdir(join(rebasedWorkspace, ".git"));
    trustWorkspaceForTest(home, workspace);
    await writeFile(
      join(home, "config.toml"),
      'config_version = 2\napproval_policy = "never"\n',
      { mode: 0o600 },
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        cwd: workspace,
        env: {
          ...process.env,
          AGENC_HOME: home,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      const broker = boot.session.services.sandboxExecutionBroker;
      if (broker === undefined) {
        throw new Error("bootstrap did not install its root sandbox broker");
      }
      expect(boot.configuredExecutionAuthority.approvalPolicy.value).toBe(
        "never",
      );

      await transitionSandboxExecutionBroker(broker, rebasedWorkspace);

      expect(boot.configuredExecutionAuthority.approvalPolicy.value).toBe(
        "untrusted",
      );
      expect(
        boot.configuredExecutionAuthority.fileSystemSandboxPolicy.allowWrite,
      ).toEqual([rebasedWorkspace]);

      const prepared = boot.prepareConfiguredExecutionAuthority({
        ...boot.configStore.current(),
        sandbox_mode: "workspace-write",
        sandbox: {
          ...boot.configStore.current().sandbox,
          filesystem: {
            allowWrite: ["./relative-grant"],
          },
        },
      });
      expect(prepared.authority.fileSystemSandboxPolicy.allowWrite).toEqual([
        rebasedWorkspace,
        join(rebasedWorkspace, "relative-grant"),
      ]);
      expect(prepared.authority.approvalPolicy.value).toBe("untrusted");

      prepared.commit();
      expect(
        boot.configuredExecutionAuthority.fileSystemSandboxPolicy.allowWrite,
      ).toEqual([
        rebasedWorkspace,
        join(rebasedWorkspace, "relative-grant"),
      ]);
      prepared.rollback();
      expect(
        boot.configuredExecutionAuthority.fileSystemSandboxPolicy.allowWrite,
      ).toEqual([rebasedWorkspace]);
    } finally {
      await shutdown?.().catch(() => {});
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(rebasedWorkspace, { recursive: true, force: true });
    }
  });

  it("keeps a workspace programmatic role in bootstrap and model-facing catalogs", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-role-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-role-ws-"));
    const roleWorkspace = createAgentRoleWorkspace(workspace);
    registerAgentRole(roleWorkspace, {
      name: "programmatic-auditor",
      config: {
        description: "Strict registered auditor",
        systemPrompt: "Audit without editing.",
        model: "grok-4.5",
        allowlist: ["FileRead"],
        disallowlist: ["Write"],
        reasoningEffort: "high",
      },
    });

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(() =>
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
        }) as never);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        cwd: workspace,
        env: {
          ...process.env,
          AGENC_HOME: home,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      const bootDefinition = findAgentDefinitionByType(
        boot.session.agentDefinitions.activeAgents as never[],
        "programmatic-auditor",
      );
      expect(bootDefinition).toMatchObject({
        source: "flagSettings",
        baseDir: "programmatic",
        model: "grok-4.5",
        tools: ["FileRead"],
        disallowedTools: ["Write"],
        effort: "high",
      });
      expect(bootDefinition?.getSystemPrompt()).toBe("Audit without editing.");

      type SpawnToolSchema = {
        readonly function?: {
          readonly name?: string;
          readonly parameters?: {
            readonly properties?: {
              readonly agent_type?: { readonly enum?: readonly string[] };
            };
          };
        };
      };
      const providerTools = createProviderSpy.mock.calls[0]?.[1].tools as
        | readonly SpawnToolSchema[]
        | undefined;
      const startupSpawnSchema = providerTools?.find(
        (tool) => tool.function?.name === "spawn_agent",
      )?.function?.parameters;
      const liveSpawnSchema = boot.registry
        .toLLMTools()
        .find((tool) => tool.function.name === "spawn_agent")
        ?.function.parameters as SpawnToolSchema["function"] extends {
          readonly parameters?: infer T;
        }
          ? T
          : never;
      expect(
        startupSpawnSchema?.properties?.agent_type?.enum,
      ).toContain("programmatic-auditor");
      expect(liveSpawnSchema).toEqual(startupSpawnSchema);

      const toolContext = buildAgenCToolUseContext(boot.session, boot.ctx);
      expect(
        findAgentDefinitionByType(
          toolContext.options.agentDefinitions.activeAgents,
          "programmatic-auditor",
        ),
      ).toMatchObject({ agentRoleFingerprint: expect.any(String) });
    } finally {
      await shutdown?.().catch(() => {});
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("builds the shared local bootstrap contract and forwards registry customizations", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const extraTool: Tool = {
      name: "system.test.extra",
      description: "test helper",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    };

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
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      // The explicit per-session cwd must beat AGENC_WORKSPACE: in the
      // daemon, env is frozen at daemon start and a stale AGENC_WORKSPACE
      // pinned every session to the first launch folder
      // (audit finding #2).
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: "/stale-daemon-workspace-ignored",
          HOME: home,
        },
        cwd: workspace,
        toolRegistryOptions: {
          extraTools: [extraTool],
        },
      });
      shutdown = boot.shutdown;

      expect(boot.agencHome).toBe(home);
      expect(
        boot.initialState.sessionConfiguration.baseInstructions,
      ).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
      expect(
        boot.initialState.sessionConfiguration.baseInstructions,
      ).not.toContain("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
      expect(boot.workspaceRoot).toBe(workspace);
      expect(boot.resolvedProvider).toBe("grok");
      expect(boot.model).toBe("grok-4.6");
      expect(boot.registry.tools.some((tool) => tool.name === extraTool.name)).toBe(
        true,
      );
      expect(boot.registry.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "FileRead",
          "Write",
          "system.bash",
          extraTool.name,
        ]),
      );
      const providerTools = createProviderSpy.mock.calls[0]?.[1].tools as
        | Array<{ readonly function?: { readonly name?: string } }>
        | undefined;
      const providerToolNames =
        providerTools?.map((tool) => tool.function?.name).filter(Boolean) ?? [];
      expect(providerToolNames).toEqual(
        expect.arrayContaining([
          "exec_command",
          "write_stdin",
          "TodoWrite",
          "EnterPlanMode",
          "ExitPlanMode",
          "system.searchTools",
          extraTool.name,
        ]),
      );
      expect(providerToolNames).toContain("FileRead");
      expect(providerToolNames).toContain("Write");
      expect(providerToolNames).not.toContain("system.bash");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "test-key",
          model: "grok-4.6",
          tools: expect.any(Array),
        }),
      );
      expect(boot.initialState.sessionConfiguration.cwd).toBe(workspace);
      expect(boot.initialState.sessionConfiguration.sessionSource).toBe(
        "cli_main",
      );
      expect(boot.config.agentRoles.length).toBeGreaterThan(0);
      expect(
        boot.session.agentDefinitions.activeAgents.map((definition) =>
          (definition as { agentType: string }).agentType,
        ),
      ).toEqual(boot.config.agentRoles.map((role) => role.name));
      expect(
        boot.session.agentDefinitions.activeAgents,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentType: "scanner",
            source: "built-in",
            agentRoleFingerprint: expect.any(String),
            disallowedTools: expect.arrayContaining(["Write"]),
          }),
        ]),
      );
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager, {
        signal: boot.session.services.mcpStartupCancellationToken.signal,
      });
      const disposeSpy = vi.spyOn(
        boot.session.services.mcpManager,
        "dispose",
      );
      await boot.shutdown();
      shutdown = null;
      expect(disposeSpy).toHaveBeenCalledOnce();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("exposes conversation manager snapshots for fresh startup and resume replay", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-conversation-manager";

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let firstShutdown: (() => Promise<void>) | null = null;
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;

      const firstManager = first.session.services.conversationThreadManager;
      expect(firstManager).toBeDefined();
      expect(first.session.services.threadManager).toBe(firstManager);
      expect(firstManager!.snapshot(conversationId)).toMatchObject({
        prewarm: "ready",
        historyLength: 0,
      });

      first.rolloutStore.appendRollout({
        type: "response_item",
        payload: { role: "user", content: "persisted ask" },
      } as RolloutItem);
      const firstEventSequence = nextRolloutEventSequence(first.rolloutStore);
      for (const event of [
        rolloutEvent(
          "turn",
          "turn_started",
          { turnId: "turn-1" },
          firstEventSequence,
        ),
        rolloutEvent(
          "thinking-start",
          "assistant_thinking_block_start",
          { index: 0, redacted: false, kind: "thinking" },
          firstEventSequence + 1,
        ),
        rolloutEvent(
          "thinking-delta",
          "assistant_thinking_delta",
          { index: 0, delta: "visible reasoning", kind: "thinking" },
          firstEventSequence + 2,
        ),
        rolloutEvent(
          "thinking-stop",
          "assistant_thinking_block_stop",
          { index: 0, kind: "thinking" },
          firstEventSequence + 3,
        ),
        rolloutEvent(
          "thinking-final",
          "agent_thinking",
          { text: "visible reasoning", redacted: false, kind: "thinking" },
          firstEventSequence + 4,
        ),
        rolloutEvent(
          "complete",
          "turn_complete",
          { turnId: "turn-1", lastAgentMessage: "done" },
          firstEventSequence + 5,
        ),
      ]) {
        first.rolloutStore.appendRollout(event);
      }
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const resumedManager = resumed.session.services.conversationThreadManager;
      expect(resumedManager).toBeDefined();
      expect(resumed.session.services.threadManager).toBe(resumedManager);
      expect(resumed.initialState.history).toEqual([
        { role: "user", content: "persisted ask" },
      ]);
      const initialTranscriptEvents = resumed.session.getInitialTranscriptEvents();
      expect(
        initialTranscriptEvents.map((event) =>
          typeof event === "object" && event !== null
            ? (event as { readonly type?: unknown }).type
            : undefined,
        ),
      ).toEqual(
        expect.arrayContaining([
          "turn_started",
          "assistant_thinking_block_start",
          "assistant_thinking_delta",
          "assistant_thinking_block_stop",
          "agent_thinking",
          "turn_complete",
        ]),
      );
      const transcript = adaptTranscriptEvents(
        initialTranscriptEvents as Parameters<typeof adaptTranscriptEvents>[0],
      );
      expect(
        transcript.messages.some(
          (message) =>
            message.type === "assistant" &&
            Array.isArray(message.message?.content) &&
            message.message.content.some(
              (part: {
                readonly type?: unknown;
                readonly thinking?: unknown;
              }) =>
                part.type === "thinking" &&
                part.thinking === "visible reasoning",
            ),
        ),
      ).toBe(true);
      const resumedSnapshot = resumedManager!.snapshot(conversationId);
      expect(resumedSnapshot).toMatchObject({
        prewarm: "ready",
        historyLength: 1,
      });
      expect(resumedSnapshot.rolloutItemCount).toBeGreaterThanOrEqual(1);

      const maxInitialSeq = Math.max(
        0,
        ...initialTranscriptEvents.map((event) =>
          typeof event === "object" &&
          event !== null &&
          "seq" in event &&
          typeof (event as { readonly seq?: unknown }).seq === "number"
            ? (event as { readonly seq: number }).seq
            : 0,
        ),
      );
      const liveEvents: Parameters<
        typeof appendSessionTranscriptEventForTesting
      >[1][] = [];
      const unsubscribe = resumed.session.eventLog.subscribe((event) => {
        liveEvents.push(
          event as Parameters<typeof appendSessionTranscriptEventForTesting>[1],
        );
      });
      resumed.session.emit({
        id: "live-after-resume",
        msg: {
          type: "agent_message",
          payload: { message: "after resume" },
        },
      });
      unsubscribe();
      const liveEvent = liveEvents.find((event) => event.id === "live-after-resume");
      expect(liveEvent?.seq).toBeGreaterThan(maxInitialSeq);

      let transcriptState = createSessionTranscriptStateForTesting(
        initialTranscriptEvents as Parameters<
          typeof createSessionTranscriptStateForTesting
        >[0],
      );
      transcriptState = appendSessionTranscriptEventForTesting(
        transcriptState,
        liveEvent!,
      );
      const transcriptAfterLive = adaptTranscriptEvents(transcriptState.events);
      expect(
        transcriptAfterLive.messages.some(
          (message) =>
            message.type === "assistant" &&
            Array.isArray(message.message?.content) &&
            message.message.content.some(
              (part: { readonly type?: unknown; readonly text?: unknown }) =>
                part.type === "text" && part.text === "after resume",
            ),
        ),
      ).toBe(true);
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("mounts and seeds a resumed rollout before replaying detached admission evidence", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-resume-admission-catchup";
    const admissionKernel = new ExecutionAdmissionKernel({ agencHome: home });

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let firstShutdown: (() => Promise<void>) | null = null;
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        executionAdmissionKernel: admissionKernel,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;
      const firstAdmission = first.session.services.executionAdmission;
      expect(firstAdmission).toBeDefined();
      const lease = await firstAdmission!.acquire({
        stepId: "detached-fallback",
        kind: "model_turn",
        model: "grok-4.3",
        provider: "grok",
        maxInputTokens: 1,
        maxOutputTokens: 1,
        maxCostUsd: 0,
      });
      firstAdmission!.void(
        lease.reservation.reservationId,
        "prepare detached fallback fixture",
      );

      const maxSequenceBeforeDetach = Math.max(
        0,
        ...first.rolloutStore.readAll().flatMap((item) =>
          item.type === "event_msg" && typeof item.payload.seq === "number"
            ? [item.payload.seq]
            : [],
        ),
      );
      await first.shutdown();
      firstShutdown = null;

      // This SQLite-authoritative decision lands while no Session is bound.
      // A production resume must catch it up only after mounting the real
      // rollout and restoring its canonical sequence/identity coordinates.
      firstAdmission!.recordFallback({
        stepId: "detached-fallback",
        fromModel: "grok-4.3",
        toModel: "grok-4.5",
        reason: "resume regression fixture",
      });
      const detachedAdmissions = admissionKernel
        .listJournal({ cwd: workspace, runId: conversationId })
        .filter((event) => event.event === "fallback");
      expect(detachedAdmissions).toHaveLength(1);
      const detachedAdmission = detachedAdmissions[0]!;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        executionAdmissionKernel: admissionKernel,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const admissionEvents = resumed.rolloutStore
        .readAll()
        .flatMap((item) =>
          item.type === "event_msg" &&
          item.payload.msg.type === "execution_admission"
            ? [item.payload]
            : [],
        )
        .filter((event) => event.eventId === detachedAdmission.eventId);
      expect(admissionEvents).toHaveLength(1);
      expect(admissionEvents[0]).toMatchObject({
        eventId: admissionEvents[0]!.msg.payload.eventId,
        seq: expect.any(Number),
        msg: {
          type: "execution_admission",
          payload: { event: "fallback" },
        },
      });
      expect(admissionEvents[0]!.seq).toBeGreaterThan(maxSequenceBeforeDetach);

      const canonicalEvents = resumed.rolloutStore
        .readAll()
        .flatMap((item) => (item.type === "event_msg" ? [item.payload] : []));
      expect(new Set(canonicalEvents.map((event) => event.seq)).size).toBe(
        canonicalEvents.length,
      );
      expect(
        new Set(canonicalEvents.map((event) => event.eventId)).size,
      ).toBe(canonicalEvents.length);
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      admissionKernel.close();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("replays streamed tool input events into resumed transcript state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-streamed-tool-input";

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let firstShutdown: (() => Promise<void>) | null = null;
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;
      const firstEventSequence = nextRolloutEventSequence(first.rolloutStore);

      first.rolloutStore.appendRollout(
        rolloutEvent(
          "tool-input-delta",
          "tool_input_delta",
          {
            callId: "tool-call-1",
            index: 0,
            partialJson: '{"path":"src/partial',
          },
          firstEventSequence,
        ),
      );
      first.rolloutStore.appendRollout(
        rolloutEvent(
          "tool-input-start",
          "tool_input_block_start",
          {
            callId: "tool-call-1",
            index: 0,
            toolName: "FileRead",
            contentBlock: {
              type: "tool_use",
              id: "tool-call-1",
              name: "FileRead",
              input: {},
            },
          },
          firstEventSequence + 1,
        ),
      );
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const initialTranscriptEvents = resumed.session.getInitialTranscriptEvents();
      expect(
        initialTranscriptEvents.map((event) =>
          typeof event === "object" && event !== null
            ? (event as { readonly type?: unknown }).type
            : undefined,
        ),
      ).toEqual(
        expect.arrayContaining([
          "tool_input_delta",
          "tool_input_block_start",
        ]),
      );

      const transcript = adaptTranscriptEvents(
        initialTranscriptEvents as Parameters<typeof adaptTranscriptEvents>[0],
      );
      expect(transcript.streamingToolUses).toHaveLength(1);
      expect(transcript.streamingToolUses[0]).toMatchObject({
        index: 0,
        contentBlock: {
          id: "tool-call-1",
          name: "FileRead",
        },
        unparsedToolInput: '{"path":"src/partial',
      });
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("replays MCP tool call events into resumed transcript state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-mcp-tool-call-replay";

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let firstShutdown: (() => Promise<void>) | null = null;
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;
      const firstEventSequence = nextRolloutEventSequence(first.rolloutStore);

      first.rolloutStore.appendRollout(
        rolloutEvent(
          "mcp-begin",
          "mcp_tool_call_begin",
          {
            callId: "mcp-call-1",
            server: "test-server",
            toolName: "lookup",
            args: JSON.stringify({ query: "runtime" }),
          },
          firstEventSequence,
        ),
      );
      first.rolloutStore.appendRollout(
        rolloutEvent(
          "mcp-end",
          "mcp_tool_call_end",
          {
            callId: "mcp-call-1",
            isError: false,
            result: "lookup result",
            durationMs: 12,
          },
          firstEventSequence + 1,
        ),
      );
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const initialTranscriptEvents = resumed.session.getInitialTranscriptEvents();
      expect(
        initialTranscriptEvents.map((event) =>
          typeof event === "object" && event !== null
            ? (event as { readonly type?: unknown }).type
            : undefined,
        ),
      ).toEqual(
        expect.arrayContaining([
          "mcp_tool_call_begin",
          "mcp_tool_call_end",
        ]),
      );

      const transcript = adaptTranscriptEvents(
        initialTranscriptEvents as Parameters<typeof adaptTranscriptEvents>[0],
      );
      expect(transcript.messages.map((message) => message.type)).toEqual([
        "assistant",
        "user",
      ]);
      const toolUse = transcript.messages[0]?.message.content as Array<{
        readonly id?: string;
        readonly name?: string;
      }>;
      const toolResult = transcript.messages[1]?.message.content as Array<{
        readonly tool_use_id?: string;
        readonly content?: unknown;
      }>;
      expect(toolUse?.[0]).toMatchObject({
        id: "mcp-call-1",
        name: "lookup",
      });
      expect(toolResult?.[0]?.tool_use_id).toBe("mcp-call-1");
      expect(JSON.stringify(toolResult?.[0]?.content ?? "")).toContain(
        "lookup result",
      );
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("replays token ledger events into resumed transcript state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-token-ledger-replay";

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let firstShutdown: (() => Promise<void>) | null = null;
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;
      const firstEventSequence = nextRolloutEventSequence(first.rolloutStore);

      first.rolloutStore.appendRollout(
        rolloutEvent(
          "usage",
          "token_count",
          {
            promptTokens: 1200,
            completionTokens: 450,
            totalTokens: 1650,
            cachedInputTokens: 300,
            cacheCreationInputTokens: 50,
            reasoningOutputTokens: 25,
            webSearchRequests: 1,
            model: "gpt-5.4",
            provider: "openai",
          },
          firstEventSequence,
        ),
      );
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const initialTranscriptEvents = resumed.session.getInitialTranscriptEvents();
      expect(
        initialTranscriptEvents.map((event) =>
          typeof event === "object" && event !== null
            ? (event as { readonly type?: unknown }).type
            : undefined,
        ),
      ).toEqual(expect.arrayContaining(["token_count"]));

      const transcript = adaptTranscriptEvents(
        initialTranscriptEvents as Parameters<typeof adaptTranscriptEvents>[0],
      );
      expect(
        transcript.messages.some(
          (message) =>
            message.type === "system" &&
            typeof message.content === "string" &&
            message.content.startsWith("Token ledger update:"),
        ),
      ).toBe(true);
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes conversation manager submit through a bootstrapped turn driver", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-conversation-submit";

    const providerResponse = {
      content: "driver reply",
      toolCalls: [],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      model: "test-model",
      finishReason: "stop",
    };
    const directChatStream = vi.fn(async () => ({
      ...providerResponse,
      content: "direct reply",
    }));
    const prewarmedChatStream = vi.fn(async () => providerResponse);
    const disposePrewarm = vi.fn(async () => {});
    const prewarmStartup = vi.fn(async () => ({
      chatStream: prewarmedChatStream,
      dispose: disposePrewarm,
    }));
    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          getExecutionProfile: async () => ({
            provider: "stub",
            model: "test-model",
            usageReporting: "authoritative",
            supportsMaxOutputTokens: true,
          }),
          chat: async () => providerResponse,
          chatStream: directChatStream,
          prewarmStartup,
          healthCheck: async () => true,
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    let bootSession: Session | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      bootSession = boot.session;

      const phaseEvents: Array<{ readonly type: string }> = [];
      boot.session.installTurnDriverHooks({
        submit: async (message) => {
          for await (const event of boot.session.runTurn(message, {
            ctx: boot.session.newDefaultTurn(),
            systemPrompt: "",
          })) {
            phaseEvents.push(event);
            boot.session.emitPhaseEvent(event);
          }
        },
      });

      const manager = boot.session.services.conversationThreadManager;
      expect(manager).toBeDefined();
      await manager!.submitTurn(conversationId, {
        type: "user_input",
        input: "driver prompt",
      });

      expect(prewarmStartup).toHaveBeenCalledWith({
        conversationId,
        threadId: conversationId,
      });
      expect(prewarmedChatStream).toHaveBeenCalled();
      expect(directChatStream).not.toHaveBeenCalled();
      expect(disposePrewarm).toHaveBeenCalledTimes(1);
      expect(phaseEvents.some((event) => event.type === "turn_complete")).toBe(
        true,
      );
      const state = boot.session.state.unsafePeek();
      // User history entries carry the file-history join key since 07ae54e6
      // ("make conversation rewind restore files on disk").
      expect(state.history).toEqual([
        {
          role: "user",
          content: "driver prompt",
          runtimeOnly: { userMessageId: expect.stringMatching(/^user-msg-/) },
        },
        { role: "assistant", content: "driver reply" },
      ]);
      expect(manager!.snapshot(conversationId).historyLength).toBe(2);
      expect(
        boot.rolloutStore
          .readAll()
          .some(
            (item) =>
              item.type === "response_item" &&
              item.payload.role === "assistant" &&
              item.payload.content === "driver reply",
          ),
      ).toBe(true);
    } finally {
      bootSession?.installTurnDriverHooks(null);
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("disposes an unused provider startup prewarm handle during shutdown", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const disposePrewarm = vi.fn(async () => {});
    const providerResponse = {
      content: "ok",
      toolCalls: [],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      model: "test-model",
      finishReason: "stop",
    };

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => providerResponse,
          chatStream: async () => providerResponse,
          prewarmStartup: async () => ({
            chatStream: async () => providerResponse,
            dispose: disposePrewarm,
          }),
          healthCheck: async () => true,
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-unused-prewarm",
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      await boot.shutdown();
      shutdown = null;

      expect(disposePrewarm).toHaveBeenCalledTimes(1);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not consume a provider startup prewarm handle that resolves after the first turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const providerResponse = {
      content: "direct reply",
      toolCalls: [],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      model: "test-model",
      finishReason: "stop",
    };
    const directChatStream = vi.fn(async () => providerResponse);
    const lateChatStream = vi.fn(async () => ({
      ...providerResponse,
      content: "late reply",
    }));
    const disposeLate = vi.fn(async () => {});
    let resolvePrewarm!: (handle: {
      chatStream: typeof lateChatStream;
      dispose: typeof disposeLate;
    }) => void;
    const prewarmStartup = vi.fn(
      () =>
        new Promise<{
          chatStream: typeof lateChatStream;
          dispose: typeof disposeLate;
        }>((resolve) => {
          resolvePrewarm = resolve;
        }),
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          getExecutionProfile: async () => ({
            provider: "stub",
            model: "test-model",
            usageReporting: "authoritative",
            supportsMaxOutputTokens: true,
          }),
          chat: async () => providerResponse,
          chatStream: directChatStream,
          prewarmStartup,
          healthCheck: async () => true,
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    let bootSession: Session | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-late-prewarm",
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      bootSession = boot.session;
      boot.session.installTurnDriverHooks({
        submit: async (message) => {
          for await (const event of boot.session.runTurn(message, {
            ctx: boot.session.newDefaultTurn(),
            systemPrompt: "",
          })) {
            boot.session.emitPhaseEvent(event);
          }
        },
      });

      const manager = boot.session.services.conversationThreadManager!;
      await manager.submitTurn("conv-late-prewarm", {
        type: "user_input",
        input: "first",
      });
      expect(directChatStream).toHaveBeenCalledTimes(1);

      resolvePrewarm({
        chatStream: lateChatStream,
        dispose: disposeLate,
      });
      await Promise.resolve();
      await Promise.resolve();

      await manager.submitTurn("conv-late-prewarm", {
        type: "user_input",
        input: "second",
      });

      expect(directChatStream).toHaveBeenCalledTimes(2);
      expect(lateChatStream).not.toHaveBeenCalled();
      expect(disposeLate).toHaveBeenCalledTimes(1);
    } finally {
      bootSession?.installTurnDriverHooks(null);
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps a provider startup prewarm handle useful when it resolves before the first turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const providerResponse = {
      content: "prewarmed reply",
      toolCalls: [],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      model: "test-model",
      finishReason: "stop",
    };
    const directChatStream = vi.fn(async () => ({
      ...providerResponse,
      content: "direct reply",
    }));
    const prewarmedChatStream = vi.fn(async () => providerResponse);
    const disposePrewarm = vi.fn(async () => {});
    let resolvePrewarm!: (handle: {
      chatStream: typeof prewarmedChatStream;
      dispose: typeof disposePrewarm;
    }) => void;
    const prewarmStartup = vi.fn(
      () =>
        new Promise<{
          chatStream: typeof prewarmedChatStream;
          dispose: typeof disposePrewarm;
        }>((resolve) => {
          resolvePrewarm = resolve;
        }),
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          getExecutionProfile: async () => ({
            provider: "stub",
            model: "test-model",
            usageReporting: "authoritative",
            supportsMaxOutputTokens: true,
          }),
          chat: async () => providerResponse,
          chatStream: directChatStream,
          prewarmStartup,
          healthCheck: async () => true,
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    let bootSession: Session | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-ready-before-turn",
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      bootSession = boot.session;
      expect(prewarmStartup).toHaveBeenCalledTimes(1);

      resolvePrewarm({
        chatStream: prewarmedChatStream,
        dispose: disposePrewarm,
      });
      await Promise.resolve();
      await Promise.resolve();

      boot.session.installTurnDriverHooks({
        submit: async (message) => {
          for await (const event of boot.session.runTurn(message, {
            ctx: boot.session.newDefaultTurn(),
            systemPrompt: "",
          })) {
            boot.session.emitPhaseEvent(event);
          }
        },
      });

      const manager = boot.session.services.conversationThreadManager!;
      await manager.submitTurn("conv-ready-before-turn", {
        type: "user_input",
        input: "first",
      });

      expect(prewarmedChatStream).toHaveBeenCalledTimes(1);
      expect(directChatStream).not.toHaveBeenCalled();
      expect(disposePrewarm).toHaveBeenCalledTimes(1);
    } finally {
      bootSession?.installTurnDriverHooks(null);
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("wires live bootstrap services instead of inert structural stubs", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const traceRoot = await mkdtemp(join(tmpdir(), "agenc-bootstrap-trace-"));
    const previousTraceRoot = process.env.AGENC_ROLLOUT_TRACE_ROOT;
    process.env.AGENC_ROLLOUT_TRACE_ROOT = traceRoot;

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      trustWorkspaceForTest(home, workspace);
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-services",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          SHELL: "/bin/sh",
        },
      });
      shutdown = boot.shutdown;

      const services = boot.session.services as typeof boot.session.services & {
        readonly modelClient: {
          setWindowGeneration(n: number): void;
          currentWindowGeneration(): number;
        };
        readonly rolloutTrace: {
          readonly enabled: boolean;
          readonly bundleDir?: string;
        };
      };

      expect(services.rollout).toBeDefined();
      expect(services.rollout?.rolloutPath()).toBe(boot.rolloutStore.rolloutPath);
      await services.rollout?.record({
        type: "session_state",
        payload: { bootstrapServiceProbe: true },
      });
      expect(
        boot.rolloutStore
          .readAll()
          .some(
            (item) =>
              item.type === "session_state" &&
              item.payload.bootstrapServiceProbe === true,
          ),
      ).toBe(true);

      await services.threadStore.setThreadName("conv-services", "Service Probe");
      await expect(services.threadStore.threadName("conv-services")).resolves.toBe(
        "Service Probe",
      );

      expect(services.rolloutTrace.enabled).toBe(true);
      expect(services.rolloutTrace.bundleDir).toBeDefined();
      const traceLog = await readFile(
        join(services.rolloutTrace.bundleDir!, "trace.jsonl"),
        "utf8",
      );
      expect(traceLog).toContain("\"type\":\"thread_started\"");

      const shellSnapshot = services.shellSnapshotTx.value as {
        readonly cwd?: string;
        readonly shell?: string;
      };
      expect(shellSnapshot.cwd).toBe(workspace);
      expect(shellSnapshot.shell).toBe(services.userShell.path);

      services.modelClient.setWindowGeneration(7);
      expect(services.modelClient.currentWindowGeneration()).toBe(7);

      expect(services.execPolicy.current()).toMatchObject({
        cwd: workspace,
        approvalPolicy: "on_request",
        sandboxPolicy: "workspace_write",
      });
      expect(services.authManager).toEqual({ mode: "bearer_key" });
      expect(services.codeModeService.enabled()).toBe(false);
      await expect(
        services.hooks.executePreCompact({
          hook_event_name: "PreCompact",
          session_id: "conv-services",
          transcript_path: boot.rolloutStore.rolloutPath,
          cwd: workspace,
          trigger: "manual",
          custom_instructions: null,
        }),
      ).resolves.toEqual({});
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      if (previousTraceRoot === undefined) {
        delete process.env.AGENC_ROLLOUT_TRACE_ROOT;
      } else {
        process.env.AGENC_ROLLOUT_TRACE_ROOT = previousTraceRoot;
      }
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(traceRoot, { recursive: true, force: true });
    }
  });

  it("uses options.apiKey without probing native BYOK secure storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const readByokSpy = vi
      .spyOn(LocalAuthBackend.prototype, "readByokKey")
      .mockRejectedValue(
        new Error("options.apiKey must prevent secure-storage reads"),
      );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.config.features.enabled?.("personality")).toBe(true);
      expect(
        boot.config.features.enabled?.("default_mode_request_user_input"),
      ).toBe(false);
      expect(boot.config.features.enabled?.("unknown-feature")).toBe(false);
      expect(readByokSpy).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to the explicit cwd when no workspace override is configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "agenc-bootstrap-cwd-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          HOME: home,
        },
        cwd,
      });
      shutdown = boot.shutdown;
      expect(boot.workspaceRoot).toBe(cwd);
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager, {
        signal: boot.session.services.mcpStartupCancellationToken.signal,
      });
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves provider-specific startup auth from the selected provider instead of forcing xAI", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        fetchImpl: offlineFetchFixture(),
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_PROVIDER: "openai",
          OPENAI_API_KEY: "openai-test-key",
          HOME: home,
        },
        argv: ["node", "agenc", "--provider", "openai"],
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("openai");
      // Note: when `AGENC_PROVIDER` overrides `model_provider` while the
      // base config still carries the default `model: "grok-4.6"`,
      // `configuredModelForProvider` keeps that explicit model rather
      // than falling back to the openai default. The test focuses on
      // provider + api-key resolution, not model defaulting.
      expect(createProviderSpy).toHaveBeenCalledWith(
        "openai",
        expect.objectContaining({
          apiKey: "openai-test-key",
          tools: expect.any(Array),
        }),
      );
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps Gemini environment keys out of explicit factory precedence", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        fetchImpl: offlineFetchFixture(),
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_PROVIDER: "gemini",
          AGENC_MODEL: "gemini-2.5-pro",
          AGENC_WORKSPACE: workspace,
          GEMINI_AUTH_MODE: "access-token",
          GEMINI_ACCESS_TOKEN: "captured-access-token",
          GEMINI_API_KEY: "captured-api-key",
          GEMINI_BASE_URL: undefined,
          GOOGLE_API_KEY: "captured-google-key",
          GOOGLE_CLOUD_LOCATION: "us-central1",
          GOOGLE_CLOUD_PROJECT: "captured-project",
          HOME: home,
        },
        argv: ["node", "agenc", "--provider", "gemini"],
      });
      shutdown = boot.shutdown;

      const options = createProviderSpy.mock.calls[0]?.[1];
      expect(options?.apiKey).toBeUndefined();
      expect(options?.extra).toMatchObject({
        gemini: {
          credentialPlan: {
            kind: "access-token",
            credential: "captured-access-token",
            source: "GEMINI_ACCESS_TOKEN",
          },
          endpointPlan: {
            kind: "vertex",
            project: "captured-project",
            location: "us-central1",
            nativeBaseURL:
              "https://us-central1-aiplatform.googleapis.com/v1/projects/captured-project/locations/us-central1/publishers/google",
          },
        },
      });
      expect(options?.baseURL).toBeUndefined();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the Gemini credential plan bound to the startup environment snapshot", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENC_HOME: home,
      AGENC_PROVIDER: "gemini",
      AGENC_MODEL: "gemini-2.5-pro",
      AGENC_WORKSPACE: workspace,
      GEMINI_AUTH_MODE: "access-token",
      GEMINI_ACCESS_TOKEN: "captured-access-token",
      GEMINI_BASE_URL: undefined,
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_CLOUD_PROJECT: "captured-project",
      HOME: home,
    };
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: () => {
        throw new Error("vendKey should not run");
      },
      inferAgencModel: () => {
        throw new Error("inferAgencModel should not run");
      },
      getSubscriptionTier: () => {
        env.GEMINI_ACCESS_TOKEN = "mutated-after-snapshot";
        return "free";
      },
    };
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        env,
        fetchImpl: offlineFetchFixture(),
        argv: ["node", "agenc", "--provider", "gemini"],
      });
      shutdown = boot.shutdown;

      expect(env.GEMINI_ACCESS_TOKEN).toBe("mutated-after-snapshot");
      const options = createProviderSpy.mock.calls[0]?.[1];
      expect(options?.extra).toMatchObject({
        gemini: {
          credentialPlan: {
            kind: "access-token",
            credential: "captured-access-token",
            source: "GEMINI_ACCESS_TOKEN",
          },
          endpointPlan: {
            kind: "vertex",
            project: "captured-project",
            location: "us-central1",
          },
        },
      });
      expect(options?.apiKey).toBeUndefined();
      expect(options?.baseURL).toBeUndefined();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // branding-scan: allow real provider identifier in test title
  it("classifies no-key generic OpenAI-compatible startup as local no-auth", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const restoreEnv = clearProcessEnv([
      "OPENAI_API_KEY",
      "OPENAI_API_BASE",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "OPENAI_COMPATIBLE_API_KEY",
      "OPENAI_COMPATIBLE_BASE_URL",
      "OPENAI_COMPATIBLE_MODEL",
    ]);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "local-model",
            max_model_len: 65_536,
            max_output_tokens: 8_192,
          },
        ],
      }),
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const readByokSpy = vi
      .spyOn(LocalAuthBackend.prototype, "readByokKey")
      .mockRejectedValue(
        new Error("local no-auth providers must not probe BYOK secure storage"),
      );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        env: {
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_PROVIDER: "openai-compatible",
          AGENC_MODEL: "local-model",
          HOME: home,
          SHELL: "/bin/sh",
        },
        argv: ["node", "agenc"],
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("openai-compatible");
      expect(boot.model).toBe("local-model");
      expect(boot.session.services.authManager).toEqual({
        mode: "local_no_auth",
      });
      expect(readByokSpy).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      restoreEnv();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("lazily reads secure-storage-only Gemini BYOK on the first Ollama to Gemini switch", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const fetchImpl = offlineFetchFixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const readByokSpy = vi
      .spyOn(LocalAuthBackend.prototype, "readByokKey")
      .mockImplementation(async (provider) =>
        provider === "gemini" ? "saved-gemini-key" : undefined,
      );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        env: {
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_PROVIDER: "ollama",
          AGENC_MODEL: "llama3.3",
          HOME: home,
          SHELL: "/bin/sh",
        },
        fetchImpl,
        argv: ["node", "agenc"],
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("ollama");
      expect(readByokSpy).not.toHaveBeenCalled();
      boot.session.setPendingProviderSwitch({
        provider: "gemini",
        model: "gemini-2.5-pro",
      });

      await expect(
        boot.session.consumePendingProviderSwitch(),
      ).resolves.toEqual({
        applied: true,
        provider: "gemini",
        model: "gemini-2.5-pro",
      });
      expect(readByokSpy).toHaveBeenCalledOnce();
      expect(readByokSpy).toHaveBeenCalledWith("gemini");
      expect(boot.session.providerBinding.factoryOptions).toMatchObject({
        extra: {
          gemini: {
            credentialPlan: {
              kind: "api-key",
              credential: "saved-gemini-key",
              source: "saved-byok",
            },
            endpointPlan: {
              kind: "developer",
              nativeBaseURL:
                "https://generativelanguage.googleapis.com/v1beta",
            },
          },
        },
      });
      expect(
        boot.session.providerBinding.factoryOptions.apiKey,
      ).toBeUndefined();
      expect(
        boot.session.providerBinding.factoryOptions.baseURL,
      ).toBeUndefined();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // branding-scan: allow real provider identifier in test title
  it("uses an explicit OpenAI-compatible key without probing native BYOK secure storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const restoreEnv = clearProcessEnv([
      "OPENAI_API_KEY",
      "OPENAI_API_BASE",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "OPENAI_COMPATIBLE_API_KEY",
      "OPENAI_COMPATIBLE_BASE_URL",
      "OPENAI_COMPATIBLE_MODEL",
    ]);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "local-model",
            max_model_len: 65_536,
            max_output_tokens: 8_192,
          },
        ],
      }),
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const readByokSpy = vi
      .spyOn(LocalAuthBackend.prototype, "readByokKey")
      .mockRejectedValue(
        new Error("explicit provider credentials must prevent secure-storage reads"),
      );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        env: {
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_PROVIDER: "openai-compatible",
          AGENC_MODEL: "local-model",
          HOME: home,
          OPENAI_COMPATIBLE_API_KEY: "explicit-compatible-key",
          SHELL: "/bin/sh",
        },
        argv: ["node", "agenc"],
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("openai-compatible");
      expect(boot.session.services.authManager).toEqual({
        mode: "bearer_key",
      });
      expect(readByokSpy).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      restoreEnv();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("defers managed-key vending until the first provider operation", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return {
          kind: "api-key",
          provider,
          sessionId,
          apiKey: "managed-key",
          baseUrl: "https://llm.agenc.tech",
        };
      },
      inferAgencModel: () => {
        calls.push("inferAgencModel");
        throw new Error("not expected");
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "pro";
      },
    };

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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        fetchImpl: offlineFetchFixture(),
        conversationId: "conv-auth",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          // Managed subscription vending is live for OpenRouter only
          // (e4a54ec1 "route managed bootstrap through OpenRouter").
          AGENC_MODEL: "x-ai/grok-4.3",
          AGENC_PROVIDER: "openrouter",
          AGENC_WORKSPACE: workspace,
          HOME: home,
          GROK_API_KEY: "",
          OPENROUTER_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.authSubscriptionTier).toBe("pro");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "openrouter",
        expect.objectContaining({
          model: "x-ai/grok-4.3",
          extra: expect.objectContaining({
            authBackend,
            managedCredential: true,
            maxTokens: 2_048,
            sessionId: "conv-auth",
            subscriptionTier: "pro",
          }),
        }),
      );
      const startupOptions = createProviderSpy.mock.calls[0]?.[1];
      expect(startupOptions).not.toHaveProperty("apiKey");
      expect(startupOptions).not.toHaveProperty("baseURL");
      expect(calls).toEqual(["getSubscriptionTier:conv-auth"]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not vend managed keys during provider startup unless enabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return {
          kind: "api-key",
          provider,
          sessionId,
          apiKey: "managed-key",
        };
      },
      inferAgencModel: () => {
        calls.push("inferAgencModel");
        throw new Error("not expected");
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "pro";
      },
    };

    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-auth-disabled",
          env: {
            ...process.env,
            AGENC_HOME: home,
            AGENC_WORKSPACE: workspace,
            AGENC_AUTH_MANAGED_KEYS_ENABLED: "false",
            // OpenRouter is the only provider with a live managed route, so
            // it is the only one that can surface the managed-keys-disabled
            // hint (other providers report "OpenRouter only" instead).
            AGENC_PROVIDER: "openrouter",
            HOME: home,
            GROK_API_KEY: "",
            OPENROUTER_API_KEY: "",
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(/auth\.managedKeys\.enabled/);

      expect(calls).toEqual(["getSubscriptionTier:conv-auth-disabled"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses locally saved BYOK keys before managed key vending", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const authBackend = new LocalAuthBackend({ agencHome: home });
    await authBackend.saveByokKey({
      provider: "grok",
      apiKey: "saved-xai-key",
    });

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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const vendSpy = vi.spyOn(authBackend, "vendKey");
    const readByokSpy = vi.spyOn(
      LocalAuthBackend.prototype,
      "readByokKey",
    );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        conversationId: "conv-local-byok",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          AGENC_WORKSPACE: workspace,
          HOME: home,
          GROK_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("grok");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "saved-xai-key",
          model: "grok-4.6",
        }),
      );
      expect(vendSpy).not.toHaveBeenCalled();
      expect(readByokSpy).toHaveBeenCalledTimes(1);
      expect(readByokSpy).toHaveBeenCalledWith("grok");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not read stored BYOK or vend managed keys when an environment API key is provided", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        throw new Error("vendKey should not run");
      },
      inferAgencModel: () => {
        throw new Error("inferAgencModel should not run");
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "pro";
      },
    };

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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const readByokSpy = vi
      .spyOn(LocalAuthBackend.prototype, "readByokKey")
      .mockRejectedValue(new Error("stored BYOK must not be read"));

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        conversationId: "conv-explicit-byok",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          AGENC_WORKSPACE: workspace,
          HOME: home,
          GROK_API_KEY: "",
          XAI_API_KEY: "explicit-xai-key",
        },
      });
      shutdown = boot.shutdown;

      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "explicit-xai-key",
        }),
      );
      expect(calls).toEqual(["getSubscriptionTier:conv-explicit-byok"]);
      expect(readByokSpy).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses locally saved BYOK keys without an injected auth backend", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await new LocalAuthBackend({ agencHome: home }).saveByokKey({
      provider: "grok",
      apiKey: "saved-default-xai-key",
    });

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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        conversationId: "conv-default-local-byok",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          GROK_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("grok");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "saved-default-xai-key",
          model: "grok-4.6",
        }),
      );
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves saved Gemini BYOK provenance in the canonical plan", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await new LocalAuthBackend({ agencHome: home }).saveByokKey({
      provider: "gemini",
      apiKey: "saved-gemini-key",
    });
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_PROVIDER: "gemini",
          AGENC_MODEL: "gemini-2.5-pro",
          AGENC_WORKSPACE: workspace,
          GEMINI_AUTH_MODE: "api-key",
          GEMINI_API_KEY: "",
          GOOGLE_API_KEY: "",
          HOME: home,
        },
        argv: ["node", "agenc", "--provider", "gemini"],
      });
      shutdown = boot.shutdown;

      const options = createProviderSpy.mock.calls[0]?.[1];
      expect(options?.apiKey).toBeUndefined();
      expect(options?.extra).toMatchObject({
        gemini: {
          credentialPlan: {
            kind: "api-key",
            credential: "saved-gemini-key",
            source: "saved-byok",
          },
          endpointPlan: {
            kind: "developer",
            nativeBaseURL:
              "https://generativelanguage.googleapis.com/v1beta",
          },
        },
      });
      expect(options?.baseURL).toBeUndefined();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("ignores duck-typed BYOK readers and uses canonical local secure storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await new LocalAuthBackend({ agencHome: home }).saveByokKey({
      provider: "grok",
      apiKey: "canonical-saved-xai-key",
    });
    const rogueReadByokKey = vi.fn(() => "rogue-injected-key");
    const authBackend = {
      login: () => ({ authenticated: true, provider: "local" as const }),
      logout: () => ({ authenticated: false as const }),
      whoami: () => ({ authenticated: true, provider: "local" as const }),
      vendKey: () => {
        throw new Error("vendKey should not run");
      },
      inferAgencModel: () => {
        throw new Error("inferAgencModel should not run");
      },
      getSubscriptionTier: () => "pro" as const,
      readByokKey: rogueReadByokKey,
    } as AuthBackend & {
      readByokKey(provider: string): string | undefined;
    };

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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const canonicalReadSpy = vi.spyOn(
      LocalAuthBackend.prototype,
      "readByokKey",
    );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        conversationId: "conv-canonical-local-byok",
        env: {
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          GROK_API_KEY: "",
          SHELL: "/bin/sh",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({ apiKey: "canonical-saved-xai-key" }),
      );
      expect(canonicalReadSpy).toHaveBeenCalledTimes(1);
      expect(canonicalReadSpy).toHaveBeenCalledWith("grok");
      expect(rogueReadByokKey).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the hosted model shortcut behind the AgenC provider boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return {
          kind: "api-key",
          provider,
          sessionId,
          apiKey: "managed-key",
        };
      },
      inferAgencModel: ({ provider, requestedModel, subscriptionTier } = {}) => {
        calls.push(
          `inferAgencModel:${provider ?? ""}:${requestedModel ?? ""}:${subscriptionTier ?? ""}`,
        );
        // The concrete route seeds capability metadata, while the live
        // provider remains the single hosted routing boundary.
        return {
          provider: "openrouter",
          model: "x-ai/grok-4.3",
          subscriptionTier,
        };
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "team";
      },
    };

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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const readByokSpy = vi
      .spyOn(LocalAuthBackend.prototype, "readByokKey")
      .mockRejectedValue(
        new Error("hosted AgenC must not probe local BYOK secure storage"),
      );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        fetchImpl: offlineFetchFixture(),
        conversationId: "conv-hosted",
        argv: ["node", "agenc", "--model", "agenc"],
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          AGENC_WORKSPACE: workspace,
          HOME: home,
          GROK_API_KEY: "",
          OPENROUTER_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.authSubscriptionTier).toBe("team");
      expect(boot.resolvedProvider).toBe("agenc");
      expect(boot.model).toBe("x-ai/grok-4.3");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "agenc",
        expect.objectContaining({
          model: "agenc",
          extra: expect.objectContaining({
            authBackend,
            sessionId: "conv-hosted",
            subscriptionTier: "team",
          }),
        }),
      );
      expect(calls).toEqual([
        "getSubscriptionTier:conv-hosted",
        "inferAgencModel:agenc:agenc:team",
      ]);
      expect(readByokSpy).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("constructs the hosted AgenC provider as the normal routing boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await writeFile(
      join(home, "config.toml"),
      [
        "config_version = 2",
        "",
        "[providers.grok]",
        'base_url = "http://127.0.0.1:8000/v1"',
        "",
      ].join("\n"),
      "utf8",
    );
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return {
          kind: "api-key",
          provider,
          sessionId,
          apiKey: "managed-key",
        };
      },
      inferAgencModel: ({ provider, requestedModel, subscriptionTier } = {}) => {
        calls.push(
          `inferAgencModel:${provider ?? ""}:${requestedModel ?? ""}:${subscriptionTier ?? ""}`,
        );
        return {
          provider: "grok",
          model: "grok-4.3",
          subscriptionTier,
        };
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "team";
      },
    };

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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        fetchImpl: offlineFetchFixture(),
        conversationId: "conv-agenc-provider",
        argv: ["node", "agenc", "--provider", "agenc"],
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          GROK_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("agenc");
      expect(boot.config.model).toBeTruthy();
      expect(boot.modelInfo.slug).toBeTruthy();
      expect(boot.ctx.modelInfo.slug).toBeTruthy();
      expect(boot.initialState.sessionConfiguration.provider).toEqual({
        slug: "agenc",
      });
      expect(
        boot.initialState.sessionConfiguration.collaborationMode.model,
      ).toBeTruthy();
      expect(createProviderSpy).toHaveBeenCalledWith(
        "agenc",
        expect.objectContaining({
          model: "agenc",
          extra: expect.objectContaining({
            authBackend,
            sessionId: "conv-agenc-provider",
            subscriptionTier: "team",
          }),
        }),
      );
      expect(createProviderSpy.mock.calls[0]?.[1]).not.toHaveProperty(
        "baseURL",
      );
      expect(calls).toEqual([
        "getSubscriptionTier:conv-agenc-provider",
        "inferAgencModel:agenc:agenc:team",
      ]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects hosted AgenC model inference responses with empty models", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: () => {
        throw new Error("vendKey should not run");
      },
      inferAgencModel: () => ({
        provider: "grok",
        model: "   ",
      }),
      getSubscriptionTier: () => "team",
    };

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-empty-model",
          argv: ["node", "agenc", "--provider", "agenc"],
          env: {
            ...process.env,
            AGENC_HOME: home,
            AGENC_WORKSPACE: workspace,
            HOME: home,
            GROK_API_KEY: "",
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(/empty model/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates the session permission registry from canonical config", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await writeFile(
      join(home, "config.toml"),
      [
        "config_version = 2",
        "",
        "[permissions]",
        'defaultMode = "acceptEdits"',
        "",
        "[durableTurns.checkpoint]",
        "enabled = false",
        "minIntervalMs = 250",
        "",
        "[durableTurns.resume]",
        "onRestart = false",
        "requireLease = true",
        "buildPinning = true",
        "",
      ].join("\n"),
      "utf8",
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.session.permissionModeRegistry.current().mode).toBe(
        "acceptEdits",
      );
      expect("permissionContext" in boot.session.sessionConfiguration).toBe(
        false,
      );
      expect(boot.config.durableTurns).toEqual({
        checkpoint: { enabled: false, minIntervalMs: 250 },
        resume: { onRestart: false, requireLease: true, buildPinning: true },
      });
      expect(boot.ctx.config.durableTurns).toEqual(boot.config.durableTurns);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves canonical auto disablement when the classifier gate is open", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const permissionSettings = await import("../permissions/settings.js");
    const { createEmptyToolPermissionContext } = await import(
      "../permissions/types.js"
    );
    const classifier = await import("../permissions/classifier.js");
    const restoreGate = classifier.__setAutoModeGateResolverForTesting(
      () => true,
    );
    vi.spyOn(
      permissionSettings,
      "initializeToolPermissionContext",
    ).mockResolvedValue({
      toolPermissionContext: createEmptyToolPermissionContext({
        mode: "default",
        isAutoModeAvailable: false,
      }),
      warnings: ["Auto mode was disabled by configuration"],
    });
    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        fetchImpl: offlineFetchFixture(),
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          XAI_API_KEY: "classifier-live",
        },
      });
      shutdown = boot.shutdown;

      expect(
        boot.session.permissionModeRegistry.current().isAutoModeAvailable,
      ).toBe(false);
      expect(boot.session.permissionModeRegistry.current().mode).toBe("default");
      expect("permissionContext" in boot.initialState.sessionConfiguration).toBe(
        false,
      );
    } finally {
      restoreGate();
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reuses an explicit conversationId when resume bootstraps an existing session", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-resume-123",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.conversationId).toBe("conv-resume-123");
      expect(boot.session.conversationId).toBe("conv-resume-123");
      expect(boot.rolloutStore.rolloutPath).toContain("conv-resume-123");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects the removed MCP JSON environment channel before session startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          apiKey: "test-key",
          env: {
            AGENC_HOME: home,
            AGENC_WORKSPACE: workspace,
            AGENC_MCP_SERVERS: "[]",
            HOME: home,
          },
        }),
      ).rejects.toThrow(/obsolete.*AGENC_MCP_SERVERS/u);
      expect(startMcpSpy).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates the live MCP manager from canonical config.toml mcp_servers", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const pidFile = join(home, "mcp", "github.pid");
    const mcpFixture = join(
      process.cwd(),
      "src/mcp-client/test-fixtures/stdio-pid-server.cjs",
    );
    await writeFile(
      join(home, "config.toml"),
      `
config_version = 2
sandbox_mode = "danger-full-access"

[mcp_servers.github]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(mcpFixture)}, ${JSON.stringify(pidFile)}]
timeout = 5000
required = true
      `,
      "utf8",
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    const startMcpSpy = vi.spyOn(Session.prototype, "startMcpManager");

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.mcpManager.getConfiguredServers()).toEqual([
        expect.objectContaining({
          name: "github",
          command: process.execPath,
          args: [mcpFixture, pidFile],
          timeout: 5_000,
          required: true,
        }),
      ]);
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager, {
        signal: boot.session.services.mcpStartupCancellationToken.signal,
      });
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("wires the session-facing MCP service to the live manager readiness surface", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      const mcpService = (
        boot.session as unknown as { services: { mcpManager: { isConnected?: unknown } } }
      ).services.mcpManager;

      expect(typeof mcpService.isConnected).toBe("function");
      expect(mcpService.isConnected?.("missing-server")).toBe(false);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("owns live session bring-up and teardown for rollout, sidecars, and current-session state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(getCurrentRuntimeSession()).toBe(boot.session);
      expect(boot.sidecarManager.getSidecarNames()).toEqual(
        expect.arrayContaining([
          "file-history",
          "error-log",
          "cost",
          "memory-auto-save",
        ]),
      );
      expect(boot.rolloutStore.rolloutPath).toContain(boot.conversationId);
      expect(boot.ctx.turnMetadataState.conversationId).toBe(
        boot.conversationId,
      );
      boot.rolloutStore.flushDurable();
      expect(
        boot.rolloutStore.readAll().some(
          (item) =>
            item.type === "event_msg" &&
            item.payload.msg.type === "session_configured",
        ),
      ).toBe(true);

      await boot.shutdown();
      await boot.shutdown();

      expect(getCurrentRuntimeSession()).toBeNull();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("strictly disposes root sandbox owners and retries retained failures", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      const broker = boot.session.services.sandboxExecutionBroker;
      if (broker === undefined) {
        throw new Error("bootstrap did not install its root sandbox broker");
      }

      const dispose = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("root process survived cleanup"))
        .mockResolvedValue(undefined);
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "test-root-process-owner",
        quiesce: async () => {},
        resume: async () => {},
        dispose,
      });

      const first = await Promise.allSettled([boot.shutdown(), boot.shutdown()]);
      expect(first).toEqual([
        expect.objectContaining({ status: "rejected" }),
        expect.objectContaining({ status: "rejected" }),
      ]);
      const firstError = first[0]?.status === "rejected"
        ? first[0].reason
        : undefined;
      expect(firstError).toBeInstanceOf(AggregateError);
      expect((firstError as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("test-root-process-owner"),
        }),
      ]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);

      await expect(boot.shutdown()).resolves.toBeUndefined();
      await expect(boot.shutdown()).resolves.toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(2);
      shutdown = null;
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("bootstraps the real agent control plane, registers /root, and tears it down through lifecycle shutdown", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      const { ensureAgentControl } = await import("./delegate-tool.js");
      const { control } = ensureAgentControl(boot.session);
      const shutdownAllSpy = vi
        .spyOn(control, "shutdownAll")
        .mockResolvedValue(undefined);

      const child = await control.spawn({ parentPath: "/root" });
      expect(
        boot.rolloutStore
          .listThreadSpawnChildrenWithStatus(boot.conversationId, "open")
          .map((edge) => edge.childThreadId),
      ).toContain(child.agentId);

      await boot.shutdown();
      shutdown = null;

      expect(shutdownAllSpy).toHaveBeenCalledWith("session_shutdown");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("boots in bypassPermissions when started with --dangerously-bypass-approvals-and-sandbox", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
        argv: ["node", "agenc", "--dangerously-bypass-approvals-and-sandbox"],
      });
      shutdown = boot.shutdown;

      expect(boot.session.permissionModeRegistry.current().mode).toBe(
        "bypassPermissions",
      );
      expect(
        boot.session.permissionModeRegistry.current()
          .isBypassPermissionsModeAvailable,
      ).toBe(true);
      expect(
        boot.session.permissionModeRegistry.current()
          .bypassPermissionsAcceptedIn,
      ).toEqual([await realpath(workspace)]);
      expect(boot.initialState.sessionConfiguration.approvalPolicy.value).toBe(
        "never",
      );
      expect(boot.initialState.sessionConfiguration.sandboxPolicy.value).toBe(
        "danger_full_access",
      );
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    { persisted: false, expectedMode: "default" as const },
    { persisted: true, expectedMode: "bypassPermissions" as const },
  ])(
    "starts a configured default bypass mode only with exact persisted cwd consent ($persisted)",
    async ({ persisted, expectedMode }) => {
      const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
      const canonicalWorkspace = await realpath(workspace);
      const workspaceIdentity = await lstat(canonicalWorkspace, {
        bigint: true,
      });
      await writeFile(
        join(home, "config.toml"),
        [
          "config_version = 2",
          "",
          "[permissions]",
          'defaultMode = "bypassPermissions"',
          'bypassPermissionsMode = "allow"',
          "",
        ].join("\n"),
        "utf8",
      );
      trustWorkspaceForTest(home, workspace);
      if (persisted) {
        await writeFile(
          join(home, "state.json"),
          `${JSON.stringify({
            state_version: 1,
            state: {
              global: {
                permissions: {
                  bypassPermissionsAcceptedByCwd: {
                    [canonicalWorkspace]: {
                      version: 1,
                      canonicalCwd: canonicalWorkspace,
                      dev: workspaceIdentity.dev.toString(10),
                      ino: workspaceIdentity.ino.toString(10),
                    },
                  },
                },
              },
            },
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      }

      const providerMod = await import("../llm/provider.js");
      vi.spyOn(providerMod, "createProvider").mockImplementation(
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
      vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(
        undefined,
      );

      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      let shutdown: (() => Promise<void>) | null = null;
      try {
        const boot = await bootstrapLocalRuntimeSession({
          apiKey: "test-key",
          env: {
            ...process.env,
            AGENC_HOME: home,
            AGENC_WORKSPACE: workspace,
            HOME: home,
          },
        });
        shutdown = boot.shutdown;

        const permissions = boot.session.permissionModeRegistry.current();
        expect(permissions.mode).toBe(expectedMode);
        expect(permissions.bypassPermissionsAcceptedIn ?? []).toEqual(
          persisted ? [canonicalWorkspace] : [],
        );
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        await shutdown?.().catch(() => {
          /* best effort */
        });
        await rm(home, { recursive: true, force: true });
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("keeps untrusted project config from relaxing bootstrap permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    // Pin this temporary directory as the project root. Test runners and local
    // developer machines may legitimately have a root marker (for example a
    // package.json) higher in the system temp directory.
    await writeFile(join(workspace, "package.json"), "{}\n", "utf8");
    await writeFile(
      join(home, "config.toml"),
      'config_version = 2\napproval_policy = "never"\n',
      "utf8",
    );
    await mkdir(join(workspace, ".agenc"), { recursive: true });
    await writeFile(
      join(workspace, ".agenc", "config.toml"),
      [
        "config_version = 2",
        "",
        "[permissions]",
        'defaultMode = "bypassPermissions"',
        'allow = ["system.bash(*)"]',
        'ask = ["FileRead"]',
        'deny = ["Write"]',
        "",
      ].join("\n"),
      "utf8",
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      const permissions = boot.session.permissionModeRegistry.current();

      expect(boot.initialState.sessionConfiguration.approvalPolicy.value).toBe(
        "untrusted",
      );
      expect(permissions.mode).toBe("default");
      expect(permissions.alwaysAllowRules.projectSettings ?? []).toEqual([]);
      expect(permissions.alwaysAskRules.projectSettings).toEqual(["FileRead"]);
      expect(permissions.alwaysDenyRules.projectSettings).toEqual(["Write"]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the configured sandbox for ordinary --permission-mode bypassPermissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    trustWorkspaceForTest(home, workspace);

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
        argv: ["node", "agenc", "--permission-mode", "bypassPermissions"],
      });
      shutdown = boot.shutdown;

      expect(boot.session.permissionModeRegistry.current().mode).toBe(
        "bypassPermissions",
      );
      expect(boot.initialState.sessionConfiguration.approvalPolicy.value).toBe(
        "never",
      );
      expect(boot.initialState.sessionConfiguration.sandboxPolicy.value).toBe(
        "workspace_write",
      );
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses one immutable config/profile/CLI authority across bootstrap, session, tools, and reload subscribers", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-config-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "agenc-bootstrap-config-ws-"),
    );
    await writeFile(
      join(workspace, "operator.toml"),
      [
        "config_version = 2",
        'model_provider = "grok"',
        'model = "grok-4.3"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        "[profiles.operator]",
        'model = "grok-4.5"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        "[profiles.operator.tools_config]",
        'disabled_tools = ["Write"]',
        "",
      ].join("\n"),
      "utf8",
    );
    trustWorkspaceForTest(home, workspace);

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_MODEL: "grok-4.4",
          HOME: home,
        },
        argv: [
          "node",
          "agenc",
          "--config",
          "operator.toml",
          "--profile",
          "operator",
          "--provider",
          "grok",
          "--model",
          "grok-4.6",
        ],
      });
      shutdown = boot.shutdown;
      const expectedConfig = {
        model_provider: "grok",
        model: "grok-4.6",
        approval_policy: "never",
        sandbox_mode: "read-only",
        tools_config: { disabled_tools: ["Write"] },
      };
      const observed: unknown[] = [];
      const unsubscribe = boot.configStore.subscribe((config) =>
        observed.push(config),
      );

      const assertCanonicalBootstrap = (): void => {
        expect(boot.configStore.current()).toMatchObject(expectedConfig);
        expect(boot.resolvedProvider).toBe("grok");
        expect(boot.model).toBe("grok-4.6");
        expect(boot.config.model).toBe("grok-4.6");
        expect(boot.session.services.configStore).toBe(boot.configStore);
        expect(boot.session.sessionConfiguration).toMatchObject({
          provider: { slug: "grok" },
          collaborationMode: { model: "grok-4.6" },
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        });
        expect(boot.registry.tools.some((tool) => tool.name === "FileRead")).toBe(
          true,
        );
        expect(boot.registry.tools.some((tool) => tool.name === "Write")).toBe(
          false,
        );
      };

      assertCanonicalBootstrap();
      await boot.configStore.reload();
      assertCanonicalBootstrap();
      expect(observed).toEqual([expect.objectContaining(expectedConfig)]);
      expect(boot.configStore.provenance("model")?.scope).toBe("cli");
      expect(boot.configStore.provenance("sandbox_mode")?.scope).toBe(
        "profile",
      );
      expect(boot.configStore.sources("flag")).toEqual([
        expect.objectContaining({
          path: join(workspace, "operator.toml"),
        }),
      ]);
      unsubscribe();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("enforces the runtime bootstrap step ordering invariant", async () => {
    // Asserts the concrete step order the bin bootstrap is required to
    // follow, mirroring upstream agenc runtime
    // `core/src/session/session.rs:814-908, 931-942`:
    //
    //   1. Session construction (Session instance exists).
    //   2. Rollout store mounted on the session.
    //   3. History reconstruction: for a fresh session (no prior
    //      rollout items) this is observably complete when the rollout
    //      store's `readAll()` returns empty — i.e. the reconstruction
    //      phase finished without reading any items. This ordering
    //      marker runs right after the mount regardless of whether
    //      there is history to reconstruct.
    //   4. Sidecar manager constructed and sidecars registered.
    //   5. SessionConfigured event emitted.
    //   6. Sidecars started.
    //   7. MCP connection manager started.
    //   8. Startup prewarm runs (observable via
    //      `session.newDefaultTurn()` increment during
    //      `runStartupPrewarm`).
    //
    // Steps 5 (SessionConfigured) and 6/7 (sidecar start + MCP start)
    // specifically follow the upstream rule "Dispatch the
    // SessionConfiguredEvent first and then report any errors"
    // (session.rs:814) — the emit must precede the real MCP manager
    // wiring.
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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

    const ordering: string[] = [];
    // Capture the originals before spying so the spies can delegate
    // back to the real implementation without triggering themselves.
    const originalMount = Session.prototype.mountRolloutStore;
    const originalEmit = Session.prototype.emit;
    const originalSidecarStart = SidecarManager.prototype.start;
    const originalNewDefaultTurn = Session.prototype.newDefaultTurn;

    const mountSpy = vi
      .spyOn(Session.prototype, "mountRolloutStore")
      .mockImplementation(function (
        this: Session,
        store: Parameters<Session["mountRolloutStore"]>[0],
      ) {
        ordering.push("rollout_store_mounted");
        return originalMount.call(this, store);
      });

    const emitSpy = vi
      .spyOn(Session.prototype, "emit")
      .mockImplementation(function (
        this: Session,
        event: Parameters<Session["emit"]>[0],
      ) {
        if (event.msg.type === "session_configured") {
          ordering.push("session_configured_emitted");
        }
        return originalEmit.call(this, event);
      });

    const sidecarStartSpy = vi
      .spyOn(SidecarManager.prototype, "start")
      .mockImplementation(async function (
        this: SidecarManager,
        log: Parameters<SidecarManager["start"]>[0],
      ) {
        ordering.push("sidecars_started");
        return originalSidecarStart.call(this, log);
      });

    const mcpStartSpy = vi
      .spyOn(Session.prototype, "startMcpManager")
      .mockImplementation(async function () {
        ordering.push("mcp_manager_started");
        // Don't actually start MCP — it's not relevant to the ordering
        // assertion and keeps the test hermetic.
      });

    const prewarmSpy = vi
      .spyOn(Session.prototype, "newDefaultTurn")
      .mockImplementation(function (
        this: Session,
        ...args: Parameters<Session["newDefaultTurn"]>
      ) {
        ordering.push("prewarm_ran");
        return originalNewDefaultTurn.apply(this, args);
      });

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      // All the instrumented steps must have fired at least once.
      expect(mountSpy).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalled();
      expect(sidecarStartSpy).toHaveBeenCalled();
      expect(mcpStartSpy).toHaveBeenCalled();
      expect(prewarmSpy).toHaveBeenCalled();

      const idx = (label: string): number => ordering.indexOf(label);

      // The recorded step order must match the upstream agenc runtime
      // contract: each step happens strictly before the next. Every
      // label must have been recorded (index >= 0).
      const mountIdx = idx("rollout_store_mounted");
      const configuredIdx = idx("session_configured_emitted");
      const sidecarIdx = idx("sidecars_started");
      const mcpIdx = idx("mcp_manager_started");
      const prewarmIdx = idx("prewarm_ran");

      expect(mountIdx).toBeGreaterThanOrEqual(0);
      expect(configuredIdx).toBeGreaterThan(mountIdx);
      expect(sidecarIdx).toBeGreaterThan(configuredIdx);
      expect(mcpIdx).toBeGreaterThan(sidecarIdx);
      expect(prewarmIdx).toBeGreaterThan(mcpIdx);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves explicit approval config after project trust is accepted", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await writeFile(
      join(home, "config.toml"),
      'config_version = 2\napproval_policy = "never"\n',
      "utf8",
    );
    trustWorkspaceForTest(home, workspace);

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.initialState.sessionConfiguration.approvalPolicy.value).toBe(
        "never",
      );
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
