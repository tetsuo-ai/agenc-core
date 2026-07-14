import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderFactoryOptions } from "../llm/provider.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import type { ToolEvaluatorContext } from "../permissions/evaluator.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { Session } from "../session/session.js";
import { backgroundTaskLifecycle, isBackgroundTask } from "../tasks/index.js";
import {
  createModelFacingTools,
  __setLiveWebFetchDnsAllLookupForTests,
} from "./model-facing-tools.js";
import { collectSkillsSnapshot } from "../commands/skills.js";
import { createLocalSkillsServices } from "../skills/local-loader.js";
import { buildBootstrapToolRegistry } from "./bootstrap-tool-registry.js";
import { _clearAgentControlCacheForTesting, _setAgentControlForTesting } from "./delegate-tool.js";
import { AgentControl } from "../agents/control.js";
import { AgentRegistry } from "../agents/registry.js";
import {
  checkForLSPDiagnostics,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from "../services/lsp/LSPDiagnosticRegistry.js";
import { normalizeLspServerConfig } from "../services/lsp/config.js";
import {
  _resetLspManagerForTesting,
  initializeLspServerManager,
  shutdownLspServerManager,
} from "../services/lsp/manager.js";
import type { LSPServerInstance } from "../services/lsp/LSPServerInstance.js";
import {
  clearSessionReadState,
  getSessionReadSnapshot,
  SESSION_ID_ARG,
} from "../tools/system/filesystem.js";
import { _resetAgentRolesForTesting, registerAgentRole } from "../agents/role.js";

const { delegateMock } = vi.hoisted(() => ({
  delegateMock: vi.fn(),
}));

vi.mock("../agents/delegate.js", () => ({
  delegate: delegateMock,
}));

function fakeMcpManager() {
  return {
    getTools: () => [],
    effectiveServers: async () => new Map(),
    toolPluginProvenance: async () => null,
    getResources: async () => [
      {
        serverName: "demo",
        uri: "resource://one",
        namespacedName: "mcp.demo.resource://one",
      },
    ],
    getResourcesByServer: async (server: string) => [
      {
        serverName: server,
        uri: "resource://one",
        namespacedName: `mcp.${server}.resource://one`,
      },
    ],
    readResource: async (name: string) => ({
      uri: name,
      text: "resource body",
      truncated: false,
      bytesReturned: 13,
    }),
  };
}

function fakeSession(): Session {
  const modelInfo = {
    slug: "test-model",
    effectiveContextWindowPercent: 95,
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    defaultReasoningLevel: "medium",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  } as const;
  return {
    conversationId: "session-test",
    config: {
      cwd: process.cwd(),
    },
    modelInfo,
    sessionConfiguration: {
      cwd: process.cwd(),
      collaborationMode: {
        model: "test-model",
        reasoningEffort: "medium",
      },
    },
    childInboxes: new Map(),
    mailbox: {
      hasPending: () => false,
      send: () => 1,
    },
    services: {
      modelsManager: {
        tryListModels: () => [modelInfo],
        listModels: async () => [modelInfo],
        getModelInfo: async () => modelInfo,
      },
      mcpManager: fakeMcpManager(),
      skillsManager: {
        skillsForConfig: async () => ({
          invokedSkills: ["demo-skill"],
          availableSkills: [
            {
              name: "demo-skill",
              description: "Demo skill",
              path: join(tmpdir(), "missing-skill.md"),
              root: tmpdir(),
              scope: "user",
            },
          ],
        }),
        resolveSkill: async (name: string) =>
          name === "demo-skill"
            ? {
                name: "demo-skill",
                description: "Demo skill",
                path: join(tmpdir(), "demo-skill", "SKILL.md"),
                root: join(tmpdir(), "demo-skill"),
                scope: "user",
                allowedTools: [],
              }
            : null,
        renderSkill: async ({ name, args }: { name: string; args?: string }) =>
          name === "demo-skill"
            ? {
                skill: {
                  name: "demo-skill",
                  description: "Demo skill",
                  path: join(tmpdir(), "demo-skill", "SKILL.md"),
                  root: join(tmpdir(), "demo-skill"),
                  scope: "user",
                  allowedTools: [],
                },
                content: `Demo content${args ? ` ${args}` : ""}`,
              }
            : null,
        recordInvokedSkill: () => {},
      },
    },
    emit: () => {},
    nextInternalSubId: () => "event-1",
    eventLog: { emit: (event: unknown) => event },
  } as unknown as Session;
}

async function writeTestSkill(
  root: string,
  name: string,
  body = `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\nUse ${name}.\n`,
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
}

function withProvider(session: Session, provider: LLMProvider): Session {
  (session.services as { provider?: LLMProvider }).provider = provider;
  return session;
}

function fakeProvider(
  config: Record<string, unknown>,
  chat = vi.fn(),
): LLMProvider {
  return {
    name: "grok",
    config,
    chat,
    chatStream: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as LLMProvider;
}

function fakeEvaluatorContext(
  toolPermissionContext = createEmptyToolPermissionContext(),
): ToolEvaluatorContext {
  return {
    getAppState() {
      return {
        toolPermissionContext,
        denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
        autoModeActive: false,
      };
    },
    session: {},
  } as ToolEvaluatorContext;
}

function streamTextResponse(text: string, contentType = "text/plain") {
  const encoder = new TextEncoder();
  let consumed = false;
  const cancel = vi.fn(async () => {
    consumed = true;
  });
  const releaseLock = vi.fn();
  const read = vi.fn(async () => {
    if (consumed) return { done: true, value: undefined };
    consumed = true;
    return { done: false, value: encoder.encode(text) };
  });
  const textRead = vi.fn(async () => {
    throw new Error("unbounded text read");
  });
  const response = {
    ok: true,
    status: 200,
    url: "https://github.com/random-org/repo",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    body: {
      getReader: () => ({ read, cancel, releaseLock }),
    },
    text: textRead,
  } as unknown as Response;
  return { response, cancel, textRead };
}

function fetchResponse(opts: {
  readonly status?: number;
  readonly url?: string;
  readonly location?: string;
  readonly text?: string;
  readonly contentType?: string;
  readonly bodyCancel?: boolean;
}) {
  const status = opts.status ?? 200;
  const cancel = vi.fn(async () => undefined);
  const textRead = vi.fn(async () => opts.text ?? "");
  const response = {
    ok: status >= 200 && status < 300,
    status,
    url: opts.url ?? "https://github.com/random-org/repo",
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === "location") return opts.location ?? null;
        if (key === "content-type") return opts.contentType ?? "text/plain";
        return null;
      },
    },
    ...(opts.bodyCancel ? { body: { cancel } } : {}),
    text: textRead,
  } as unknown as Response;
  return { response, textRead, cancel };
}

function codeMode<T>(result: { readonly codeModeResult?: unknown }): T {
  expect(result.codeModeResult).toBeDefined();
  return result.codeModeResult as T;
}

function installDeterministicPublicWebFetchDns(): void {
  __setLiveWebFetchDnsAllLookupForTests((_hostname, callback) => {
    callback(null, [{ address: '192.0.2.1', family: 4 }]);
  });
}

describe("model-facing tools", () => {
  beforeEach(() => {
    installDeterministicPublicWebFetchDns();
    delegateMock.mockReset();
    resetAllLSPDiagnosticState();
    _resetLspManagerForTesting();
  });

  afterEach(async () => {
    __setLiveWebFetchDnsAllLookupForTests(undefined);
    await shutdownLspServerManager();
    _resetLspManagerForTesting();
    _resetAgentRolesForTesting();
  });

  it("registers the requested product tools and omits raw system HTTP tools", () => {
    const registry = buildBootstrapToolRegistry({
      workspaceRoot: process.cwd(),
      agencHome: join(tmpdir(), "agenc-tools-test"),
      mcpManager: fakeMcpManager() as never,
      getSession: () => null,
      emitWarning: () => {},
    });

    const allNames = registry.tools.map((tool) => tool.name);
    expect(allNames).toEqual(
      expect.arrayContaining([
        "web_fetch",
        "WebFetch",
        "WebSearch",
        "spawn_agent",
        "wait_agent",
        "close_agent",
        "assign_task",
        "send_message",
        "list_agents",
        "Skill",
        "ListMcpResourcesTool",
        "ReadMcpResourceTool",
        "ListMcpResources",
        "ReadMcpResource",
        "NotebookRead",
        "NotebookEdit",
        "LSP",
        "TaskCreate",
        "TaskGet",
        "TaskUpdate",
        "TaskList",
        "TaskOutput",
        "TaskStop",
        "CronCreate",
        "CronDelete",
        "CronList",
        "WorkflowTool",
        "Brief",
        "SendUserMessage",
        "VerifyPlanExecution",
        "StructuredOutput",
      ]),
    );
    expect(allNames.some((name) => name.startsWith("system.http"))).toBe(false);
    expect(allNames).not.toContain("Agent");
    expect(allNames).not.toContain("SendMessage");
    expect(allNames).not.toContain("send_input");
    expect(allNames).not.toContain("resume_agent");
    expect(allNames).not.toContain("TeamCreate");
    expect(allNames).not.toContain("TeamDelete");

    // followup_task was a dormant deferred alias of assign_task — deleted.
    expect(allNames).not.toContain("followup_task");

    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);

    // Exactly one visible elicitation tool: AskUserQuestion is canonical;
    // request_user_input is registered but deferred + hidden.
    expect(allNames).toContain("request_user_input");
    expect(
      visibleNames.filter(
        (name) => name === "AskUserQuestion" || name === "request_user_input",
      ),
    ).toEqual(["AskUserQuestion"]);
    expect(visibleNames).toEqual(
      expect.arrayContaining([
        "web_fetch",
        "WebSearch",
        "Skill",
        "spawn_agent",
        "assign_task",
        "send_message",
        "wait_agent",
        "close_agent",
        "list_agents",
        "NotebookRead",
      ]),
    );
    expect(visibleNames).not.toContain("WebFetch");
    expect(visibleNames).not.toContain("followup_task");
    expect(allNames).not.toContain("system.agent.delegate");
    expect(visibleNames).not.toContain("system.agent.delegate");
    expect(visibleNames).not.toContain("NotebookEdit");
    expect(visibleNames).not.toContain("TaskCreate");
    const waitAgentTool = registry.tools.find(
      (tool) => tool.name === "wait_agent",
    );
    expect(waitAgentTool?.timeoutBehavior).toBe("tool");
    expect(waitAgentTool?.timeoutMs).toBeUndefined();
    expect(waitAgentTool?.inputSchema).toMatchObject({
      properties: {
        timeout_ms: {
          description: expect.stringContaining(
            "Defaults to 30000, min 10000, max 3600000",
          ),
        },
      },
    });
    expect(
      registry.tools.find((tool) => tool.name === "spawn_agent")?.inputSchema,
    ).toMatchObject({
      required: ["message", "task_name"],
      additionalProperties: false,
    });
    expect(
      (
        registry.tools.find((tool) => tool.name === "spawn_agent")
          ?.inputSchema as { properties?: Record<string, unknown> } | undefined
      )?.properties,
    ).not.toHaveProperty("fork_context");
    expect(
      (
        registry.tools.find((tool) => tool.name === "spawn_agent")
          ?.inputSchema as { properties?: Record<string, unknown> } | undefined
      )?.properties,
    ).toHaveProperty("service_tier");
    expect(
      (
        registry.tools.find((tool) => tool.name === "spawn_agent")
          ?.inputSchema as {
          properties?: Record<string, { description?: string }>;
        } | undefined
      )?.properties?.fork_turns?.description,
    ).toContain("Defaults to `all`");
    expect(
      registry.tools.find((tool) => tool.name === "TaskCreate")?.inputSchema,
    ).toMatchObject({
      required: ["subject", "description"],
      additionalProperties: false,
    });
    expect(
      registry.tools.find((tool) => tool.name === "TaskCreate")?.inputSchema,
    ).not.toMatchObject({
      properties: { owner: expect.anything() },
    });
    expect(
      registry.tools.find((tool) => tool.name === "TaskGet")?.inputSchema,
    ).toMatchObject({
      required: ["taskId"],
      additionalProperties: false,
    });
    expect(
      registry.tools.find((tool) => tool.name === "TaskUpdate")?.inputSchema,
    ).toMatchObject({
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        status: {
          enum: ["pending", "in_progress", "completed", "deleted"],
        },
        owner: { type: ["string", "null"] },
      },
    });
    expect(
      registry.tools.find((tool) => tool.name === "TaskList")?.inputSchema,
    ).toMatchObject({
      properties: {},
      additionalProperties: false,
    });
    expect(allNames).toEqual(
      expect.arrayContaining([
        "system.symbolSearch",
        "system.symbolDefinition",
        "system.symbolReferences",
      ]),
    );
    expect(
      registry.tools.find((tool) => tool.name === "LSP")?.inputSchema,
    ).toMatchObject({
      required: ["operation"],
      additionalProperties: false,
      properties: {
        operation: {
          enum: ["diagnostics", "definition", "references", "symbols"],
        },
      },
    });
  });

  it("exposes LSP in the default visible surface with per-op backing documented", () => {
    const registry = buildBootstrapToolRegistry({
      workspaceRoot: process.cwd(),
      agencHome: join(tmpdir(), "agenc-tools-test"),
      mcpManager: fakeMcpManager() as never,
      getSession: () => null,
      emitWarning: () => {},
    });

    // Not deferred: diagnostics must be reachable without a prior
    // tool-search discovery round-trip.
    const lsp = registry.tools.find((tool) => tool.name === "LSP")!;
    expect(lsp.metadata?.deferred).toBe(false);
    expect(lsp.isReadOnly).toBe(true);
    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).toContain("LSP");

    // The description must let the model calibrate trust per operation:
    // diagnostics is language-server-backed, the navigation ops come from
    // the built-in semantic index.
    expect(lsp.description).toContain("language server");
    expect(lsp.description).toContain("index");
  });

  it("exposes StructuredOutput without discovery when an output schema is configured", async () => {
    const registry = buildBootstrapToolRegistry({
      workspaceRoot: process.cwd(),
      agencHome: join(tmpdir(), "agenc-tools-test"),
      mcpManager: fakeMcpManager() as never,
      getSession: () => null,
      emitWarning: () => {},
      toolRegistryOptions: {
        outputSchema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
          additionalProperties: false,
        },
      },
    });

    const structuredOutput = registry.tools.find(
      (tool) => tool.name === "StructuredOutput",
    );
    expect(structuredOutput?.metadata?.deferred).toBe(false);
    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).toContain("StructuredOutput");

    // The advertised tool is schema-bound, not the passthrough.
    const invalid = await registry.dispatch({
      id: "structured-output-invalid",
      name: "StructuredOutput",
      arguments: JSON.stringify({ wrong: true }),
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain("does not match required schema");
    const valid = await registry.dispatch({
      id: "structured-output-valid",
      name: "StructuredOutput",
      arguments: JSON.stringify({ verdict: "ship it" }),
    });
    expect(valid.isError).toBeUndefined();
    expect(JSON.parse(valid.content).structured_output).toEqual({
      verdict: "ship it",
    });
  });

  it("keeps StructuredOutput deferred when no output schema is configured", () => {
    const registry = buildBootstrapToolRegistry({
      workspaceRoot: process.cwd(),
      agencHome: join(tmpdir(), "agenc-tools-test"),
      mcpManager: fakeMcpManager() as never,
      getSession: () => null,
      emitWarning: () => {},
    });

    expect(registry.tools.map((tool) => tool.name)).toContain(
      "StructuredOutput",
    );
    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).not.toContain("StructuredOutput");
  });

  it("accepts max_concurrency and the upstream max_workers alias", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
    });
    const spawn = tools.find((tool) => tool.name === "spawn_agents_on_csv")!;
    const properties = (
      spawn.inputSchema as { properties: Record<string, unknown> }
    ).properties;

    expect(properties.max_concurrency).toMatchObject({ type: "number" });
    expect(properties.max_workers).toMatchObject({ type: "number" });

    const accepted = await spawn.execute({
      csv_path: "input.csv",
      instruction: "process {value}",
      max_concurrency: 2,
    });
    expect(JSON.parse(accepted.content).error).toBe(
      "tool invoked before session was initialized",
    );

    const aliasAccepted = await spawn.execute({
      csv_path: "input.csv",
      instruction: "process {value}",
      max_workers: 2,
    });
    expect(JSON.parse(aliasAccepted.content).error).toBe(
      "tool invoked before session was initialized",
    );
  });

  it("uses max_workers as the CSV agent concurrency alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-csv-alias-"));
    try {
      const csvPath = join(root, "input.csv");
      await writeFile(csvPath, "id,value\nrow1,a\nrow2,b\n", "utf8");
      const session = fakeSession();
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const report = byName.get("report_agent_job_result")!;
      let activeWorkers = 0;
      let maxActiveWorkers = 0;
      const reports: Promise<void>[] = [];
      delegateMock.mockImplementation(
        async (ctx: { taskPrompt: string; agentName: string }) => {
          activeWorkers += 1;
          maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
          const jobId = /Job ID: ([^\n]+)/.exec(ctx.taskPrompt)?.[1];
          const itemId = /Item ID: ([^\n]+)/.exec(ctx.taskPrompt)?.[1];
          expect(jobId).toBeDefined();
          expect(itemId).toBeDefined();
          reports.push(
            new Promise<void>((resolve) => {
              setTimeout(() => {
                void report
                  .execute({
                    job_id: jobId,
                    item_id: itemId,
                    result: { worker: ctx.agentName },
                  })
                  .finally(() => {
                    activeWorkers -= 1;
                    resolve();
                  });
              }, 5);
            }),
          );
          return {
            kind: "async_launched",
            thread: {
              threadId: `thread-${ctx.agentName}`,
              join: vi.fn(() => new Promise<void>(() => {})),
            },
          };
        },
      );

      const result = await byName.get("spawn_agents_on_csv")!.execute({
        csv_path: csvPath,
        instruction: "process {value}",
        id_column: "id",
        max_workers: 1,
      });

      await Promise.all(reports);
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content).items).toMatchObject([
        { item_id: "row1", status: "completed" },
        { item_id: "row2", status: "completed" },
      ]);
      expect(maxActiveWorkers).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns LSP diagnostics for one file without draining other pending diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-lsp-tool-"));
    try {
      const a = join(root, "a.ts");
      const b = join(root, "b.ts");
      await writeFile(a, "const a = 1;\n", "utf8");
      await writeFile(b, "const b = 1;\n", "utf8");
      registerPendingLSPDiagnostic({
        serverName: "ts",
        files: [
          {
            uri: a,
            diagnostics: [{
              message: "a diag",
              severity: "Error",
            }],
          },
          {
            uri: b,
            diagnostics: [{
              message: "b diag",
              severity: "Warning",
            }],
          },
        ],
      });

      const tools = createModelFacingTools({
        workspaceRoot: root,
        getSession: () => null,
      });
      const lsp = tools.find((tool) => tool.name === "LSP")!;

      const result = await lsp.execute({
        operation: "diagnostics",
        file_path: "a.ts",
      });

      expect(JSON.parse(result.content).diagnostics).toEqual([
        { message: "a diag", severity: "Error" },
      ]);
      expect(
        checkForLSPDiagnostics()[0]!.files.map((file) => file.uri).sort(),
      ).toEqual([a, b]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds model-facing LSP diagnostics for noisy pending files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-lsp-tool-noisy-"));
    try {
      const file = join(root, "a.ts");
      await writeFile(file, "const a = 1;\n", "utf8");
      registerPendingLSPDiagnostic({
        serverName: "ts",
        files: [
          {
            uri: file,
            diagnostics: Array.from({ length: 40 }, (_, index) => ({
              message: `diag ${index}`,
              severity: index % 2 === 0 ? "Warning" : "Error",
            })),
          },
        ],
      });

      const tools = createModelFacingTools({
        workspaceRoot: root,
        getSession: () => null,
      });
      const lsp = tools.find((tool) => tool.name === "LSP")!;
      const result = await lsp.execute({
        operation: "diagnostics",
        file_path: "a.ts",
      });
      const payload = JSON.parse(result.content);

      expect(payload.diagnostics).toHaveLength(10);
      expect(payload.diagnostics[0]!.severity).toBe("Error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps native semantic definition, references, and symbols operations available", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-lsp-tool-code-intel-"));
    try {
      await writeFile(
        join(root, "app.ts"),
        [
          "export function greet(name: string) {",
          "  return `hello ${name}`;",
          "}",
          "export const message = greet('Ada');",
          "",
        ].join("\n"),
        "utf8",
      );
      const tools = createModelFacingTools({
        workspaceRoot: root,
        getSession: () => null,
      });
      const lsp = tools.find((tool) => tool.name === "LSP")!;

      const definition = JSON.parse(
        (
          await lsp.execute({
            operation: "definition",
            symbol: "greet",
          })
        ).content,
      );
      expect(definition.definition).toMatchObject({
        name: "greet",
        filePath: "app.ts",
      });

      const references = JSON.parse(
        (
          await lsp.execute({
            operation: "references",
            symbol: "greet",
          })
        ).content,
      );
      expect(references.references.map((entry: { line: number }) => entry.line)).toEqual([
        1,
        4,
      ]);

      const symbols = JSON.parse(
        (
          await lsp.execute({
            operation: "symbols",
            query: "greet",
          })
        ).content,
      );
      expect(symbols.symbols[0]).toMatchObject({
        name: "greet",
        filePath: "app.ts",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports when no language server is configured for diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-lsp-tool-no-server-"));
    try {
      const file = join(root, "a.ts");
      await writeFile(file, "const a = 1;\n", "utf8");
      const tools = createModelFacingTools({
        workspaceRoot: root,
        getSession: () => null,
      });
      const lsp = tools.find((tool) => tool.name === "LSP")!;

      const result = await lsp.execute({
        operation: "diagnostics",
        file_path: "a.ts",
      });
      const payload = JSON.parse(result.content);

      expect(payload).toMatchObject({
        file_path: file,
        diagnostics: [],
        server: null,
        note: "No language server is configured for this file.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns structured LSP initialization failures with pending diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-lsp-tool-failed-init-"));
    try {
      const file = join(root, "a.ts");
      await writeFile(file, "const a = 1;\n", "utf8");
      initializeLspServerManager({
        configSource: () => {
          throw new Error("cannot load lsp config");
        },
      });
      registerPendingLSPDiagnostic({
        serverName: "ts",
        files: [
          {
            uri: file,
            diagnostics: [{ message: "pending diag", severity: "Error" }],
          },
        ],
      });

      const tools = createModelFacingTools({
        workspaceRoot: root,
        getSession: () => null,
      });
      const lsp = tools.find((tool) => tool.name === "LSP")!;
      const result = await lsp.execute({
        operation: "diagnostics",
        file_path: "a.ts",
      });
      const payload = JSON.parse(result.content);

      expect(payload).toMatchObject({
        file_path: file,
        server: null,
        lsp_status: "failed",
        server_error: { message: "cannot load lsp config" },
        diagnostics: [{ message: "pending diag", severity: "Error" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns structured LSP server startup failures with pending diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-lsp-tool-start-failure-"));
    try {
      const file = join(root, "a.ts");
      await writeFile(file, "const a = 1;\n", "utf8");
      const config = normalizeLspServerConfig("ts", {
        command: "typescript-language-server",
        extensionToLanguage: { ".ts": "typescript" },
      });
      const server = {
        name: "ts",
        config,
        get state() {
          return "stopped";
        },
        start: async () => {
          throw new Error("server start timed out");
        },
        stop: async () => {},
        restart: async () => {},
        isHealthy: () => false,
        sendRequest: async () => ({}),
        sendNotification: async () => {},
        onNotification: () => {},
        onRequest: () => {},
      } as unknown as LSPServerInstance;
      initializeLspServerManager({
        configSource: () => ({ ts: config }),
        instanceFactory: () => server,
      });
      registerPendingLSPDiagnostic({
        serverName: "ts",
        files: [
          {
            uri: file,
            diagnostics: [{ message: "old diag", severity: "Warning" }],
          },
        ],
      });

      const tools = createModelFacingTools({
        workspaceRoot: root,
        getSession: () => null,
      });
      const lsp = tools.find((tool) => tool.name === "LSP")!;
      const result = await lsp.execute({
        operation: "diagnostics",
        file_path: "a.ts",
      });
      const payload = JSON.parse(result.content);

      expect(payload).toMatchObject({
        file_path: file,
        server: null,
        lsp_status: "server_error",
        server_error: { message: "server start timed out" },
        diagnostics: [{ message: "old diag", severity: "Warning" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns language-server diagnostics through the model-visible path when the server runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-lsp-tool-running-"));
    try {
      const file = join(root, "a.ts");
      await writeFile(file, "const a: number = 'oops';\n", "utf8");
      const config = normalizeLspServerConfig("ts", {
        command: "typescript-language-server",
        extensionToLanguage: { ".ts": "typescript" },
      });
      // Running-server fixture: ensureServerStarted sees "running" and
      // returns the instance without spawning a real language server.
      const server = {
        name: "ts",
        config,
        get state() {
          return "running";
        },
        start: async () => {},
        stop: async () => {},
        restart: async () => {},
        isHealthy: () => true,
        sendRequest: async () => ({}),
        sendNotification: async () => {},
        onNotification: () => {},
        onRequest: () => {},
      } as unknown as LSPServerInstance;
      initializeLspServerManager({
        configSource: () => ({ ts: config }),
        instanceFactory: () => server,
      });
      // Server-published diagnostics land in the pending registry; the tool
      // surfaces them attributed to the running server.
      registerPendingLSPDiagnostic({
        serverName: "ts",
        files: [
          {
            uri: file,
            diagnostics: [{
              message: "Type 'string' is not assignable to type 'number'.",
              severity: "Error",
            }],
          },
        ],
      });

      const tools = createModelFacingTools({
        workspaceRoot: root,
        getSession: () => null,
      });
      const lsp = tools.find((tool) => tool.name === "LSP")!;
      const result = await lsp.execute({
        operation: "diagnostics",
        file_path: "a.ts",
      });
      const payload = JSON.parse(result.content);

      expect(result.isError).not.toBe(true);
      expect(payload).toMatchObject({
        file_path: file,
        server: "ts",
        diagnostics: [{
          message: "Type 'string' is not assignable to type 'number'.",
          severity: "Error",
        }],
        note: "Pending language-server diagnostics were returned.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists TaskCreate/TaskGet/TaskUpdate/TaskList against the per-project task board", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-tool-home-"));
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        agencHome: home,
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      const created = await byName.get("TaskCreate")!.execute({
        subject: "Wire tools",
        description: "Add missing model-facing tools",
      });
      expect(created.content).toBe("Task #1 created successfully: Wire tools");
      const task = codeMode<{
        task: {
          id: string;
          owner?: string;
          status: string;
        };
      }>(created).task;
      expect(task.id).toMatch(/^\d+$/);
      expect(task.owner).toBeUndefined();
      expect(task.status).toBe("pending");

      const assigned = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        owner: "/root/task_3",
      });
      expect(assigned.content).toBe(`Updated task #${task.id} owner`);
      const assignedTask = codeMode<{
        task: {
          owner?: string;
        };
      }>(assigned).task;
      expect(assignedTask.owner).toBe("/root/task_3");

      const blocker = await byName.get("TaskCreate")!.execute({
        subject: "B",
        description: "Block Wire tools",
      });
      const blockerTask = codeMode<{
        task: { id: string };
      }>(blocker).task;

      const linked = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        addBlockedBy: [blockerTask.id, blockerTask.id],
      });
      const linkedTask = codeMode<{
        task: {
          blockedBy: readonly string[];
        };
      }>(linked).task;
      expect(linkedTask.blockedBy).toEqual([blockerTask.id]);

      // Auto-mirror under the list lock: blocker.blocks should now
      // contain task.id with no separate update call.
      const blockerAfter = await byName.get("TaskGet")!.execute({
        taskId: blockerTask.id,
      });
      expect(blockerAfter.content).toContain(`Task #${blockerTask.id}: B`);
      expect(
        codeMode<{ task: { blocks: readonly string[] } }>(blockerAfter).task
          .blocks,
      ).toEqual([task.id]);

      const listed = codeMode<{
        tasks: readonly {
          id: string;
          unresolvedBlockers: readonly string[];
        }[];
      }>(await byName.get("TaskList")!.execute({})).tasks;
      const tEntry = listed.find((t) => t.id === task.id);
      expect(tEntry?.unresolvedBlockers).toEqual([blockerTask.id]);

      const completed = await byName.get("TaskUpdate")!.execute({
        taskId: blockerTask.id,
        status: "completed",
      });
      expect(completed.content).toBe(`Updated task #${blockerTask.id} status`);
      expect(
        codeMode<{
          task: { status: string };
          statusChange: { from: string; to: string };
        }>(completed).task.status,
      ).toBe("completed");

      const refreshed = codeMode<{
        tasks: readonly {
          id: string;
          unresolvedBlockers: readonly string[];
        }[];
      }>(await byName.get("TaskList")!.execute({})).tasks;
      expect(
        refreshed.find((t) => t.id === task.id)?.unresolvedBlockers,
      ).toEqual([]);

      const metadataUpdated = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        metadata: { kept: 1, removeMe: "x" },
      });
      expect(
        codeMode<{ task: { metadata?: Record<string, unknown> } }>(
          metadataUpdated,
        ).task.metadata,
      ).toEqual({ kept: 1, removeMe: "x" });
      const metadataDeleted = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        metadata: { removeMe: null },
      });
      expect(
        codeMode<{ task: { metadata?: Record<string, unknown> } }>(
          metadataDeleted,
        ).task.metadata,
      ).toEqual({ kept: 1 });

      const deleted = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        status: "deleted",
      });
      expect(deleted.content).toBe(`Deleted task #${task.id}`);
      expect(
        codeMode<{
          updatedFields: readonly string[];
          statusChange: { from: string; to: string };
        }>(deleted).updatedFields,
      ).toEqual(["deleted"]);

      const visibleAfterDelete = codeMode<{
        tasks: readonly { id: string }[];
      }>(await byName.get("TaskList")!.execute({})).tasks;
      expect(visibleAfterDelete.map((t) => t.id)).not.toContain(task.id);

      const got = await byName.get("TaskGet")!.execute({ taskId: task.id });
      expect(got.isError).toBe(true);
      expect(got.content).toBe("Task not found");

      const missing = await byName.get("TaskGet")!.execute({ taskId: "9999" });
      expect(missing.isError).toBe(true);
      expect(missing.content).toBe("Task not found");
      expect(codeMode<{ error: string }>(missing).error).toBe("Task not found");

      const badRef = await byName.get("TaskUpdate")!.execute({
        taskId: blockerTask.id,
        addBlocks: ["9999"],
      });
      expect(badRef.isError).toBe(true);
      expect(badRef.content).toBe("Unknown task reference");
      expect(codeMode<{ missing: readonly string[] }>(badRef).missing).toEqual([
        "9999",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("TaskCreate auto-expands the tasks panel via the appStateBridge", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-tool-home-"));
    try {
      const expansions: Array<"none" | "tasks"> = [];
      const session = {
        appStateBridge: {
          setExpandedView: (next: "none" | "tasks") => expansions.push(next),
        },
      } as unknown as Session;
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        agencHome: home,
        getSession: () => session,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      await byName.get("TaskCreate")!.execute({
        subject: "auto-expand",
        description: "Check panel expansion",
      });
      expect(expansions).toEqual(["tasks"]);

      // TaskUpdate must NOT auto-expand (only create does).
      const task = codeMode<{ task: { id: string } }>(
        await byName.get("TaskCreate")!.execute({
          subject: "second",
          description: "Second task",
        }),
      ).task;
      expansions.length = 0;
      await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        status: "in_progress",
      });
      expect(expansions).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("TaskCreate is a no-op for the bridge when the TUI is not mounted", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-tool-home-"));
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        agencHome: home,
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const result = await byName
        .get("TaskCreate")!
        .execute({ subject: "no-tui", description: "No TUI mounted" });
      expect(result.isError).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("web_fetch renders HTML through Turndown and reports preapproved hosts", async () => {
    const html =
      "<!doctype html><html><head><title>x</title><style>body{}</style></head><body>" +
      "<h1>Hello</h1>" +
      "<p>This is a <strong>test</strong> with a <a href=\"/docs\">link</a>.</p>" +
      "<ul><li>one</li><li>two</li></ul>" +
      "<script>alert('x')</script>" +
      "</body></html>";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://agenc.tech/docs",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "Text/HTML; charset=utf-8" : null,
      },
      text: async () => html,
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const result = await byName.get("web_fetch")!.execute({
        url: "https://agenc.tech/docs",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.preapproved).toBe(true);
      expect(parsed.rendered_as).toBe("markdown");
      expect(parsed.content).toContain("# Hello");
      expect(parsed.content).toContain("**test**");
      expect(parsed.content).toContain("[link](/docs)");
      // List bullet rendered with the configured "-" marker.
      expect(parsed.content).toMatch(/-\s+one/);
      // Scripts and styles must not leak into the markdown.
      expect(parsed.content).not.toContain("alert");
      expect(parsed.content).not.toContain("<style>");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("WebFetch legacy alias flags non-preapproved hosts as preapproved=false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://github.com/random-org/repo",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/plain" : null,
      },
      text: async () => "plain body",
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const result = await byName.get("WebFetch")!.execute({
        url: "https://github.com/random-org/repo",
      });
      const parsed = JSON.parse(result.content);
      expect(parsed.preapproved).toBe(false);
      expect(parsed.rendered_as).toBe("passthrough");
      expect(parsed.content).toBe("plain body");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("web_fetch truncates streamed bodies before unbounded text reads", async () => {
    const streamed = streamTextResponse("x".repeat(20_000));
    const fetchMock = vi.fn().mockResolvedValue(streamed.response);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const result = await byName.get("web_fetch")!.execute({
        url: "https://github.com/random-org/repo",
        max_chars: 1_000,
      });
      const parsed = JSON.parse(result.content);
      expect(result.isError).toBeUndefined();
      expect(parsed.truncated).toBe(true);
      expect(parsed.content).toContain("[truncated");
      expect(streamed.textRead).not.toHaveBeenCalled();
      expect(streamed.cancel).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("web_fetch returns structured errors for invalid URLs and fetch failures", async () => {
    __setLiveWebFetchDnsAllLookupForTests((_hostname, callback) => {
      callback(null, [{ address: "1.1.1.1", family: 4 }]);
    });

    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      const ftp = await byName.get("web_fetch")!.execute({
        url: "ftp://localhost/file",
      });
      expect(ftp.isError).toBe(true);
      expect(JSON.parse(ftp.content).error).toContain("https");

      const credentials = await byName.get("web_fetch")!.execute({
        url: "https://user:pass@localhost/page",
      });
      expect(credentials.isError).toBe(true);
      expect(JSON.parse(credentials.content).error).toContain("credentials");

      const privateIp = await byName.get("web_fetch")!.execute({
        url: "https://127.0.0.1/page",
      });
      expect(privateIp.isError).toBe(true);
      expect(JSON.parse(privateIp.content).error).toContain("loopback");

      const localHost = await byName.get("web_fetch")!.execute({
        url: "https://localhost/page",
      });
      expect(localHost.isError).toBe(true);
      expect(JSON.parse(localHost.content).error).toContain("loopback");

      const subLocalHost = await byName.get("web_fetch")!.execute({
        url: "https://foo.localhost/page",
      });
      expect(subLocalHost.isError).toBe(true);
      expect(JSON.parse(subLocalHost.content).error).toContain("loopback");
      expect(fetchMock).not.toHaveBeenCalled();

      const failed = await byName.get("web_fetch")!.execute({
        url: "https://github.com/random-org/repo",
      });
      expect(failed.isError).toBe(true);
      expect(JSON.parse(failed.content).error).toContain("network down");
    } finally {
      __setLiveWebFetchDnsAllLookupForTests(undefined);
      globalThis.fetch = previousFetch;
    }
  });

  it("web_fetch denies hostnames that DNS-resolve to private or metadata addresses", async () => {
    // Mixed public + private must fail closed (any blocked address).
    __setLiveWebFetchDnsAllLookupForTests((_hostname, callback) => {
      callback(null, [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]);
    });

    const fetchMock = vi.fn();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const result = await byName.get("web_fetch")!.execute({
        url: "https://evil-rebinding.example/latest/meta-data/",
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toMatch(
        /private|loopback|link-local|resolves/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      __setLiveWebFetchDnsAllLookupForTests(undefined);
      globalThis.fetch = previousFetch;
    }
  });

  it("web_fetch validates redirect targets before following them", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const previousFetch = globalThis.fetch;
    try {
      const privateRedirect = fetchResponse({
        status: 302,
        url: "https://agenc.tech/start",
        location: "https://169.254.169.254/latest",
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(privateRedirect.response) as unknown as typeof globalThis.fetch;
      const privateResult = await byName.get("web_fetch")!.execute({
        url: "https://agenc.tech/start",
      });
      expect(privateResult.isError).toBe(true);
      expect(JSON.parse(privateResult.content).error).toContain("private");
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const downgradeRedirect = fetchResponse({
        status: 302,
        url: "https://agenc.tech/start",
        location: "http://agenc.tech/insecure",
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(downgradeRedirect.response) as unknown as typeof globalThis.fetch;
      const downgradeResult = await byName.get("web_fetch")!.execute({
        url: "https://agenc.tech/start",
      });
      expect(downgradeResult.isError).toBe(true);
      expect(JSON.parse(downgradeResult.content).error).toContain("https");
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const crossHostRedirect = fetchResponse({
        status: 302,
        url: "https://agenc.tech/start",
        location: "https://react.dev/learn",
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(crossHostRedirect.response) as unknown as typeof globalThis.fetch;
      const crossHostResult = await byName.get("web_fetch")!.execute({
        url: "https://agenc.tech/start",
      });
      expect(crossHostResult.isError).toBe(true);
      expect(JSON.parse(crossHostResult.content).error).toContain("changes host");
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const safeRedirect = fetchResponse({
        status: 302,
        url: "https://github.com/modelcontextprotocol",
        location: "/modelcontextprotocol/typescript-sdk",
      });
      const finalResponse = fetchResponse({
        status: 200,
        url: "https://github.com/modelcontextprotocol/typescript-sdk",
        text: "redirected body",
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(safeRedirect.response)
        .mockResolvedValueOnce(finalResponse.response) as unknown as typeof globalThis.fetch;
      const safeResult = await byName.get("web_fetch")!.execute({
        url: "https://github.com/modelcontextprotocol",
      });
      expect(safeResult.isError).toBeUndefined();
      const safeParsed = JSON.parse(safeResult.content);
      expect(safeParsed.content).toBe("redirected body");
      expect(safeParsed.preapproved).toBe(true);
      expect(safeParsed.final_url).toBe(
        "https://github.com/modelcontextprotocol/typescript-sdk",
      );
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);

      const outOfScopeRedirect = fetchResponse({
        status: 302,
        url: "https://github.com/modelcontextprotocol",
        location: "/other-org/repo",
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(outOfScopeRedirect.response) as unknown as typeof globalThis.fetch;
      const outOfScopeResult = await byName.get("web_fetch")!.execute({
        url: "https://github.com/modelcontextprotocol",
      });
      expect(outOfScopeResult.isError).toBe(true);
      expect(JSON.parse(outOfScopeResult.content).error).toContain(
        "outside the preapproved URL scope",
      );
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const redirectChain = Array.from({ length: 6 }, (_, index) =>
        fetchResponse({
          status: 302,
          url: `https://agenc.tech/r${index}`,
          location: `/r${index + 1}`,
          bodyCancel: true,
        }),
      );
      const chainFetch = vi.fn();
      for (const redirect of redirectChain) {
        chainFetch.mockResolvedValueOnce(redirect.response);
      }
      globalThis.fetch = chainFetch as unknown as typeof globalThis.fetch;
      const limitResult = await byName.get("web_fetch")!.execute({
        url: "https://agenc.tech/r0",
      });
      expect(limitResult.isError).toBe(true);
      expect(JSON.parse(limitResult.content).error).toContain("too many redirects");
      expect(globalThis.fetch).toHaveBeenCalledTimes(6);
      expect(redirectChain[5]!.cancel).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("web_fetch permissions auto-allow preapproved hosts and honor domain rules", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
    });
    const tool = tools.find((candidate) => candidate.name === "web_fetch");
    expect(tool).toBeDefined();

    const preapproved = await tool!.checkPermissions?.(
      { url: "HTTP://agenc.tech/docs" },
      fakeEvaluatorContext(),
    );
    expect(preapproved).toMatchObject({
      behavior: "allow",
      updatedInput: { url: "https://agenc.tech/docs" },
    });

    const deniedPreapproved = await tool!.checkPermissions?.(
      { url: "https://agenc.tech/docs" },
      fakeEvaluatorContext(
        createEmptyToolPermissionContext({
          alwaysDenyRules: {
            localSettings: ["web_fetch(domain:agenc.tech)"],
          },
        }),
      ),
    );
    expect(deniedPreapproved).toMatchObject({
      behavior: "deny",
      message: "web_fetch denied access to domain:agenc.tech.",
    });

    const askPreapproved = await tool!.checkPermissions?.(
      { url: "https://agenc.tech/docs" },
      fakeEvaluatorContext(
        createEmptyToolPermissionContext({
          alwaysAskRules: {
            localSettings: ["web_fetch(domain:agenc.tech)"],
          },
        }),
      ),
    );
    expect(askPreapproved).toMatchObject({
      behavior: "ask",
      decisionReason: { type: "rule" },
    });

    const denied = await tool!.checkPermissions?.(
      { url: "https://github.com/random-org/repo" },
      fakeEvaluatorContext(
        createEmptyToolPermissionContext({
          alwaysDenyRules: {
            localSettings: ["web_fetch(domain:github.com)"],
          },
        }),
      ),
    );
    expect(denied).toMatchObject({
      behavior: "deny",
      message: "web_fetch denied access to domain:github.com.",
    });

    const blockedAddress = await tool!.checkPermissions?.(
      { url: "https://169.254.169.254/latest" },
      fakeEvaluatorContext(),
    );
    expect(blockedAddress).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("private, loopback, or link-local address"),
    });

    const blockedLoopback = await tool!.checkPermissions?.(
      { url: "https://127.0.0.1/page" },
      fakeEvaluatorContext(),
    );
    expect(blockedLoopback).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("loopback"),
    });

    for (const url of [
      "https://localhost/page",
      "https://foo.localhost/page",
    ]) {
      const blockedLocalhost = await tool!.checkPermissions?.(
        { url },
        fakeEvaluatorContext(),
      );
      expect(blockedLocalhost).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("private, loopback, or link-local address"),
      });
    }

    for (const url of [
      "https://[::1]/page",
      "https://[fd00::1]/page",
      "https://[fe80::1]/page",
      "https://[::ffff:169.254.169.254]/page",
    ]) {
      const blockedIpv6 = await tool!.checkPermissions?.(
        { url },
        fakeEvaluatorContext(),
      );
      expect(blockedIpv6).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("private, loopback, or link-local address"),
      });
    }

    const legacyAllowed = await tool!.checkPermissions?.(
      { url: "https://github.com/random-org/repo" },
      fakeEvaluatorContext(
        createEmptyToolPermissionContext({
          alwaysAllowRules: {
            localSettings: ["WebFetch(domain:github.com)"],
          },
        }),
      ),
    );
    expect(legacyAllowed).toMatchObject({
      behavior: "allow",
      decisionReason: { type: "rule" },
    });

    const legacyTool = tools.find((candidate) => candidate.name === "WebFetch");
    const legacyDenied = await legacyTool!.checkPermissions?.(
      { url: "https://github.com/random-org/repo" },
      fakeEvaluatorContext(
        createEmptyToolPermissionContext({
          alwaysDenyRules: {
            localSettings: ["web_fetch(domain:github.com)"],
          },
        }),
      ),
    );
    expect(legacyDenied).toMatchObject({
      behavior: "deny",
      decisionReason: { type: "rule" },
    });

    const ask = await tool!.checkPermissions?.(
      { url: "https://github.com/random-org/repo" },
      fakeEvaluatorContext(),
    );
    expect(ask).toMatchObject({
      behavior: "ask",
      suggestions: [
        {
          type: "addRules",
          destination: "localSettings",
          behavior: "allow",
          rules: [{ toolName: "web_fetch", ruleContent: "domain:github.com" }],
        },
      ],
    });
  });

  it("WebSearch uses Grok provider-native web_search when the active model supports it", async () => {
    const nativeResponse: LLMResponse = {
      content: "Use the current docs for this answer.",
      toolCalls: [],
      usage: {
        promptTokens: 10,
        completionTokens: 12,
        totalTokens: 22,
        webSearchRequests: 1,
      },
      model: "grok-4-fast",
      finishReason: "stop",
      providerEvidence: {
        serverSideToolCalls: [
          {
            type: "web_search_call",
            toolType: "web_search",
            raw: {
              type: "web_search_call",
              action: {
                sources: [
                  {
                    title: "Current AgenC docs",
                    url: "https://agenc.tech/current",
                    snippet: "Current reference",
                  },
                  {
                    title: "Local source",
                    url: "https://localhost/out",
                    snippet: "Blocked by filter",
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const nativeChat = vi.fn().mockResolvedValue(nativeResponse);
    let factoryOptions: ProviderFactoryOptions | undefined;
    const providerFactory = vi.fn((
      _provider: string,
      options: ProviderFactoryOptions,
    ) => {
      factoryOptions = options;
      return fakeProvider({}, nativeChat);
    });
    const session = withProvider(
      fakeSession(),
      fakeProvider({
        apiKey: "xai-test",
        model: "grok-4-fast",
      }),
    );
    const fetchMock = vi.fn();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
        providerFactory: providerFactory as never,
      });
      const result = await tools.find((tool) => tool.name === "WebSearch")!.execute({
        query: "current docs",
        allowed_domains: ["agenc.tech", "localhost"],
        blocked_domains: ["localhost"],
        max_results: 1,
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.source).toBe("grok_web_search");
      expect(parsed.answer).toBe(nativeResponse.content);
      expect(parsed.results).toEqual([
        {
          title: "Current AgenC docs",
          url: "https://agenc.tech/current",
          snippet: "Current reference",
        },
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(factoryOptions?.tools).toEqual([]);
    expect(factoryOptions?.extra).toMatchObject({
      webSearch: true,
      searchMode: "on",
      webSearchOptions: {
        allowedDomains: ["agenc.tech", "localhost"],
        excludedDomains: ["localhost"],
      },
    });
    expect(nativeChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        tools: [],
        toolRouting: {
          allowedToolNames: ["web_search"],
        },
      }),
    );
  });

  it("WebSearch falls back when Grok native web_search returns no source URLs", async () => {
    const nativeResponse: LLMResponse = {
      content: "No source URLs were emitted.",
      toolCalls: [],
      usage: {
        promptTokens: 10,
        completionTokens: 12,
        totalTokens: 22,
        webSearchRequests: 1,
      },
      model: "grok-4-fast",
      finishReason: "stop",
      providerEvidence: {
        serverSideToolCalls: [
          {
            type: "web_search_call",
            toolType: "web_search",
          },
        ],
      },
    };
    const nativeChat = vi.fn().mockResolvedValue(nativeResponse);
    const providerFactory = vi.fn((
      _provider: string,
      _options: ProviderFactoryOptions,
    ) => fakeProvider({}, nativeChat));
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        RelatedTopics: [
          {
            Text: "Fallback - source",
            FirstURL: "https://agenc.tech/fallback",
          },
        ],
      }),
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const session = withProvider(
        fakeSession(),
        fakeProvider({
          apiKey: "xai-test",
          model: "grok-4-fast",
        }),
      );
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
        env: {
          AGENC_WEB_SEARCH_ENDPOINT: "http://127.0.0.1/search",
        } as NodeJS.ProcessEnv,
        providerFactory: providerFactory as never,
      });
      const result = await tools.find((tool) => tool.name === "WebSearch")!.execute({
        query: "source required",
      });

      expect(nativeChat).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1/search?q=source%20required",
        expect.any(Object),
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.source).toBe("http://127.0.0.1/search");
      expect(parsed.results[0].url).toBe("https://agenc.tech/fallback");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("WebSearch falls back when the active Grok model lacks native web_search support", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        Heading: "fallback",
        RelatedTopics: [
          {
            Text: "Allowed - kept",
            FirstURL: "https://127.0.0.1/page",
          },
        ],
      }),
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const providerFactory = vi.fn();
      const session = withProvider(
        fakeSession(),
        fakeProvider({
          apiKey: "xai-test",
          model: "grok-code-fast-1",
        }),
      );
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
        env: {
          AGENC_WEB_SEARCH_ENDPOINT: "http://127.0.0.1/search",
        } as NodeJS.ProcessEnv,
        providerFactory: providerFactory as never,
      });
      const result = await tools.find((tool) => tool.name === "WebSearch")!.execute({
        query: "fallback search",
      });

      expect(providerFactory).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1/search?q=fallback%20search",
        expect.any(Object),
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.source).toBe("http://127.0.0.1/search");
      expect(parsed.results[0].url).toBe("https://127.0.0.1/page");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("WebSearch fallback filters blocked domains", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        RelatedTopics: [
          {
            Text: "Blocked - omit",
            FirstURL: "https://127.0.0.1/blocked",
          },
          {
            Text: "Kept - include",
            FirstURL: "https://localhost/kept",
          },
        ],
      }),
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
        env: {
          AGENC_WEB_SEARCH_ENDPOINT: "http://127.0.0.1/search",
        } as NodeJS.ProcessEnv,
      });
      const result = await tools.find((tool) => tool.name === "WebSearch")!.execute({
        query: "filtered search",
        blocked_domains: ["127.0.0.1"],
      });

      const parsed = JSON.parse(result.content);
      expect(parsed.results.map((entry: { url: string }) => entry.url)).toEqual([
        "https://localhost/kept",
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("lists and reads MCP resources through the live session manager", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const listed = await byName.get("ListMcpResourcesTool")!.execute({});
    expect(JSON.parse(listed.content).resources[0].serverName).toBe("demo");

    const read = await byName.get("ReadMcpResourceTool")!.execute({
      server: "demo",
      uri: "resource://one",
    });
    expect(JSON.parse(read.content).resource.text).toBe("resource body");
  });

  it("loads skills through the Skill tool and records invocations", async () => {
    const recordInvokedSkill = vi.fn();
    const session = fakeSession();
    (session.services.skillsManager as {
      recordInvokedSkill?: typeof recordInvokedSkill;
    }).recordInvokedSkill = recordInvokedSkill;
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const skill = tools.find((tool) => tool.name === "Skill")!;

    const result = await skill.execute({
      skill: "demo-skill",
      args: "focus",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("<command-name>demo-skill</command-name>");
    expect(result.content).toContain("Demo content focus");
    expect(recordInvokedSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "demo-skill",
      }),
    );
  });

  it("reports the same available skills as /skills when Skill cannot resolve a name", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-skill-tool-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-skill-tool-ws-"));
    const home = await mkdtemp(join(tmpdir(), "agenc-skill-tool-user-"));
    const legacyUserSkillRoot = ".codex"; // branding-scan: allow legacy user skill root compatibility
    try {
      await writeTestSkill(join(home, ".agents", "skills"), "shared-visible");
      await writeTestSkill(join(home, legacyUserSkillRoot, "skills"), "legacy-visible");
      const localServices = createLocalSkillsServices({
        agencHome,
        workspaceRoot,
        env: { HOME: home },
      });
      const session = fakeSession();
      (session as { config?: unknown }).config = {};
      (session.services as {
        skillsManager: typeof localServices.skillsManager;
        pluginsManager: typeof localServices.pluginsManager;
      }).skillsManager = localServices.skillsManager;
      (session.services as {
        pluginsManager: typeof localServices.pluginsManager;
      }).pluginsManager = localServices.pluginsManager;

      const slashSnapshot = await collectSkillsSnapshot(session);
      const tools = createModelFacingTools({
        workspaceRoot,
        getSession: () => session,
      });
      const skill = tools.find((tool) => tool.name === "Skill")!;
      const missing = await skill.execute({ skill: "missing-skill" });

      expect(missing.isError).toBe(true);
      expect(JSON.parse(missing.content).available).toEqual(
        slashSnapshot.availableSkills.map((entry) => entry.name),
      );

      const loaded = await skill.execute({ skill: "legacy-visible" });
      expect(loaded.isError).toBeUndefined();
      expect(loaded.content).toContain("<command-name>legacy-visible</command-name>");
      expect(loaded.content).toContain("Use legacy-visible.");
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects model-disabled skills", async () => {
    const session = fakeSession();
    (session.services.skillsManager as {
      renderSkill?: (opts: { name: string }) => Promise<unknown>;
    }).renderSkill = async () => ({
      skill: {
        name: "debug",
        path: "/skills/debug/SKILL.md",
        root: "/skills/debug",
        scope: "bundled",
        disableModelInvocation: true,
      },
      content: "debug",
    });
    const skill = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "Skill")!;

    const result = await skill.execute({ skill: "debug" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("not model-invocable");
  });

  it("rejects removed compatibility fields on strict agent tools", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const spawn = await byName.get("spawn_agent")!.execute({
      message: "inspect",
      task_name: "task_1",
      items: [{ text: "removed compatibility field" }],
    });
    expect(spawn.isError).toBe(true);
    expect(JSON.parse(spawn.content).error).toContain("unknown field `items`");

    const send = await byName.get("send_message")!.execute({
      target: "/root/task_1",
      message: "hello",
      interrupt: true,
    });
    expect(send.isError).toBe(true);
    expect(JSON.parse(send.content).error).toContain("unknown field `interrupt`");

    const assign = await byName.get("assign_task")!.execute({
      target: "/root/task_1",
      message: "hello",
      items: [],
    });
    expect(assign.isError).toBe(true);
    expect(JSON.parse(assign.content).error).toContain("unknown field `items`");

    // followup_task (the deferred assign_task alias) no longer exists.
    expect(byName.has("followup_task")).toBe(false);
  });

  it("rejects invalid strict spawn_agent arguments before delegation", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const spawnAgent = tools.find((tool) => tool.name === "spawn_agent")!;

    const missingTaskName = await spawnAgent.execute({ message: "inspect" });
    expect(missingTaskName.isError).toBe(true);
    expect(JSON.parse(missingTaskName.content).error).toBe("task_name is required");

    const forkContext = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      fork_context: true,
    });
    expect(forkContext.isError).toBe(true);
    expect(JSON.parse(forkContext.content).error).toContain(
      "fork_context is not supported",
    );

    const wait = tools.find((tool) => tool.name === "wait_agent")!;
    const zeroTimeout = await wait.execute({ timeout_ms: 0 });
    expect(zeroTimeout.isError).toBe(true);
    expect(JSON.parse(zeroTimeout.content).error).toBe(
      "timeout_ms must be at least 10000",
    );
    const tooLargeTimeout = await wait.execute({ timeout_ms: 3_600_001 });
    expect(tooLargeTimeout.isError).toBe(true);
    expect(JSON.parse(tooLargeTimeout.content).error).toBe(
      "timeout_ms must be at most 3600000",
    );
    for (const timeout_ms of ["1000", {}, []]) {
      const invalidTimeout = await wait.execute({ timeout_ms });
      expect(invalidTimeout.isError).toBe(true);
      expect(JSON.parse(invalidTimeout.content).error).toBe(
        "timeout_ms must be a number",
      );
    }
    const targets = await wait.execute({ targets: ["/root/worker"] });
    expect(targets.isError).toBe(true);
    expect(JSON.parse(targets.content).error).toBe("unknown field `targets`");

    const invalidRole = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      agent_type: "missing-role",
      fork_turns: "none",
    });
    expect(invalidRole.isError).toBe(true);
    expect(JSON.parse(invalidRole.content).error).toBe(
      "unknown agent_type 'missing-role'",
    );

    const forkTurns = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      fork_turns: "0",
    });
    expect(forkTurns.isError).toBe(true);
    expect(JSON.parse(forkTurns.content).error).toBe(
      "fork_turns must be `none`, `all`, or a positive integer string",
    );

    const hiddenModel = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      model: "codex-auto-review", // branding-scan: allow OpenAI model identifier
      fork_turns: "none",
    });
    expect(hiddenModel.isError).toBe(true);
    expect(JSON.parse(hiddenModel.content).error).toBe(
      "Unknown model `codex-auto-review` for spawn_agent. Available models: test-model", // branding-scan: allow OpenAI model identifier
    );

    const fullHistoryWithOverride = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      agent_type: "runner",
      fork_turns: "all",
    });
    expect(fullHistoryWithOverride.isError).toBe(true);
    expect(JSON.parse(fullHistoryWithOverride.content).error).toContain(
      "Full-history forked agents inherit",
    );

    const defaultFullHistoryWithOverride = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      reasoning_effort: "xhigh",
    });
    expect(defaultFullHistoryWithOverride.isError).toBe(true);
    expect(JSON.parse(defaultFullHistoryWithOverride.content).error).toContain(
      "Full-history forked agents inherit",
    );
  });

  it("uses a full-history fork by default for plain spawn_agent calls", async () => {
    const session = fakeSession();
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "thread-reviewer",
          agentPath: "/root/reviewer",
          nickname: "Reviewer",
          role: { name: "default" },
          status: {
            value: {
              status: "running",
              turnId: "turn-reviewer",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(async () => ({
          threadId: "thread-reviewer",
          durationMs: 1,
          outcome: "completed",
          finalMessage: "done",
        })),
      },
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const result = await tools.find((tool) => tool.name === "spawn_agent")!.execute({
      message: "review game.py",
      task_name: "reviewer",
    });

    expect(result.isError).not.toBe(true);
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: session,
        parentPath: "/root",
        taskPrompt: "review game.py",
        agentName: "reviewer",
        runInBackground: true,
        // todo-106: collab workers stay alive for later assign_task
        keepAlive: true,
        forkMode: { kind: "full_history" },
      }),
    );
  });

  it("normalizes common hyphenated spawn_agent task names", async () => {
    const session = fakeSession();
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "thread-reviewer",
          agentPath: "/root/bug_review",
          nickname: "Bug Review",
          role: { name: "default" },
          status: {
            value: {
              status: "running",
              turnId: "turn-reviewer",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(async () => ({
          threadId: "thread-reviewer",
          durationMs: 3,
          outcome: "completed",
          finalMessage: "done",
        })),
      },
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const result = await tools.find((tool) => tool.name === "spawn_agent")!.execute({
      message: "review game.py",
      task_name: "bug-review",
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      task_name: "/root/bug_review",
      nickname: "Bug Review",
    });
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "bug_review",
        forkMode: { kind: "full_history" },
      }),
    );
  });

  it("also accepts explicit all turns for spawn_agent full-history forks", async () => {
    const session = fakeSession();
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "thread-reviewer",
          agentPath: "/root/reviewer",
          nickname: "Reviewer",
          role: { name: "default" },
          status: {
            value: {
              status: "running",
              turnId: "turn-reviewer",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(async () => ({
          threadId: "thread-reviewer",
          durationMs: 1,
          outcome: "completed",
          finalMessage: "done",
        })),
      },
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const result = await tools.find((tool) => tool.name === "spawn_agent")!.execute({
      message: "continue context-heavy work",
      task_name: "reviewer",
      fork_turns: "all",
    });

    expect(result.isError).not.toBe(true);
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        forkMode: { kind: "full_history" },
      }),
    );
  });

  it("accepts explicit service_tier for spawn_agent and validates the effective child model", async () => {
    const supportedModelInfo = {
      ...fakeSession().modelInfo,
      slug: "gpt-5.4",
      serviceTiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
    };
    const unsupportedModelInfo = {
      ...fakeSession().modelInfo,
      slug: "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
      serviceTiers: [],
    };
    const session = fakeSession();
    (session.services as unknown as {
      modelsManager: {
        tryListModels: () => readonly unknown[];
        listModels: () => Promise<readonly unknown[]>;
        getModelInfo: (model: string) => Promise<unknown>;
      };
    }).modelsManager = {
      tryListModels: () => [supportedModelInfo, unsupportedModelInfo],
      listModels: async () => [supportedModelInfo, unsupportedModelInfo],
      getModelInfo: async (model: string) =>
        model === supportedModelInfo.slug
          ? supportedModelInfo
          : unsupportedModelInfo,
    };
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "thread-fast",
          agentPath: "/root/fast_task",
          nickname: "Fast Task",
          role: { name: "default" },
          status: {
            value: {
              status: "running",
              turnId: "turn-fast",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(async () => ({
          threadId: "thread-fast",
          durationMs: 1,
          outcome: "completed",
          finalMessage: "done",
        })),
      },
    });
    const spawn = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "spawn_agent")!;

    const accepted = await spawn.execute({
      message: "inspect",
      task_name: "fast_task",
      model: "gpt-5.4",
      service_tier: "priority",
      fork_turns: "none",
    });

    expect(accepted.isError).not.toBe(true);
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        serviceTier: "priority",
      }),
    );

    const rejected = await spawn.execute({
      message: "inspect",
      task_name: "slow_task",
      model: "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
      service_tier: "priority",
      fork_turns: "none",
    });

    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content).error).toBe(
      "Service tier `priority` is not supported for model `gpt-5.3-codex`. Supported service tiers: none", // branding-scan: allow OpenAI model identifier
    );
    expect(delegateMock).toHaveBeenCalledTimes(1);
  });

  it("applies role model, reasoning, and service tier after valid spawn_agent overrides", async () => {
    const roleModelInfo = {
      ...fakeSession().modelInfo,
      slug: "gpt-5.4",
      supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
      serviceTiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "standard",
          name: "Standard",
          description: "standard queue",
        },
      ],
    };
    const requestedModelInfo = {
      ...fakeSession().modelInfo,
      slug: "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
      supportedReasoningLevels: ["low", "medium"],
      serviceTiers: [
        {
          id: "standard",
          name: "Standard",
          description: "standard queue",
        },
      ],
    };
    const session = fakeSession();
    (session.services as unknown as {
      modelsManager: {
        tryListModels: () => readonly unknown[];
        listModels: () => Promise<readonly unknown[]>;
        getModelInfo: (model: string) => Promise<unknown>;
      };
    }).modelsManager = {
      tryListModels: () => [roleModelInfo, requestedModelInfo],
      listModels: async () => [roleModelInfo, requestedModelInfo],
      getModelInfo: async (model: string) =>
        model === roleModelInfo.slug ? roleModelInfo : requestedModelInfo,
    };
    registerAgentRole({
      name: "priority-reviewer",
      config: {
        description: "Review quickly.",
        configToml: [
          'model = "gpt-5.4"',
          'model_reasoning_effort = "high"',
          'service_tier = "priority"',
        ].join("\n"),
      },
    });
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "thread-priority",
          agentPath: "/root/priority_review",
          nickname: "Priority Review",
          role: { name: "priority-reviewer" },
          status: {
            value: {
              status: "running",
              turnId: "turn-priority",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(async () => ({
          threadId: "thread-priority",
          durationMs: 1,
          outcome: "completed",
          finalMessage: "done",
        })),
      },
    });

    const result = await createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "spawn_agent")!.execute({
      message: "inspect",
      task_name: "priority_review",
      agent_type: "priority-reviewer",
      model: "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
      reasoning_effort: "low",
      service_tier: "standard",
      fork_turns: "none",
    });

    expect(result.isError).not.toBe(true);
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "priority-reviewer",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "priority",
      }),
    );
  });

  it("does not let a role service tier hide an invalid spawn_agent service_tier request", async () => {
    const roleModelInfo = {
      ...fakeSession().modelInfo,
      slug: "gpt-5.4",
      serviceTiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
    };
    const session = fakeSession();
    (session.services as unknown as {
      modelsManager: {
        tryListModels: () => readonly unknown[];
        listModels: () => Promise<readonly unknown[]>;
        getModelInfo: (model: string) => Promise<unknown>;
      };
    }).modelsManager = {
      tryListModels: () => [roleModelInfo],
      listModels: async () => [roleModelInfo],
      getModelInfo: async () => roleModelInfo,
    };
    registerAgentRole({
      name: "priority-reviewer",
      config: {
        description: "Review quickly.",
        configToml: [
          'model = "gpt-5.4"',
          'service_tier = "priority"',
        ].join("\n"),
      },
    });

    const result = await createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "spawn_agent")!.execute({
      message: "inspect",
      task_name: "priority_review",
      agent_type: "priority-reviewer",
      service_tier: "turbo",
      fork_turns: "none",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe(
      "Service tier `turbo` is not supported for model `gpt-5.4`. Supported service tiers: priority",
    );
    expect(delegateMock).not.toHaveBeenCalled();
  });

  it("allows explicit service_tier on full-history spawn_agent forks", async () => {
    const session = fakeSession();
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "thread-history",
          agentPath: "/root/history_task",
          nickname: "History Task",
          role: { name: "default" },
          status: {
            value: {
              status: "running",
              turnId: "turn-history",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(async () => ({
          threadId: "thread-history",
          durationMs: 1,
          outcome: "completed",
          finalMessage: "done",
        })),
      },
    });

    const result = await createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "spawn_agent")!.execute({
      message: "continue context-heavy work",
      task_name: "history_task",
      fork_turns: "all",
      service_tier: "priority",
    });

    expect(result.isError).not.toBe(true);
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        forkMode: { kind: "full_history" },
        serviceTier: "priority",
      }),
    );
  });

  it("uses a clean fork when spawn_agent role or effort overrides explicitly set fork_turns none", async () => {
    const session = fakeSession();
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "thread-reviewer",
          agentPath: "/root/reviewer",
          nickname: "Reviewer",
          role: { name: "worker" },
          status: {
            value: {
              status: "running",
              turnId: "turn-reviewer",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(async () => ({
          threadId: "thread-reviewer",
          durationMs: 1,
          outcome: "completed",
          finalMessage: "done",
        })),
      },
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const result = await tools.find((tool) => tool.name === "spawn_agent")!.execute({
      message: "review game.py",
      task_name: "reviewer",
      agent_type: "runner",
      reasoning_effort: "xhigh",
      fork_turns: "none",
    });

    expect(result.isError).not.toBe(true);
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        reasoningEffort: "xhigh",
      }),
    );
    expect(delegateMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("forkMode");
  });

  it("allows subagent spawn_agent and emits a begin/end lifecycle pair", async () => {
    const session = fakeSession();
    (session.config as { agent_max_depth?: number }).agent_max_depth = 1;
    const emit = vi.fn();
    (session as unknown as { emit: typeof emit }).emit = emit;
    const control = {
      getLive: vi.fn((threadId: string) =>
        threadId === "child-1"
          ? {
              agentId: "child-1",
              agentPath: "/root/child_1",
              depth: 1,
              nickname: "Deckard",
              role: { name: "worker" },
              status: { value: { status: "running", turnId: "t", startedAtMs: 1 } },
            }
          : undefined,
      ),
    };
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "grandchild-1",
          agentPath: "/root/child_1/grandchild",
          nickname: "Molly",
          role: { name: "worker" },
          status: {
            value: {
              status: "running",
              turnId: "turn-grandchild",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(() => new Promise(() => {})),
      },
    });
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const spawn = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "spawn_agent")!;

      const result = await spawn.execute({
        __agencSessionId: "child-1",
        message: "inspect",
        task_name: "grandchild",
        fork_turns: "none",
      });

      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content)).toEqual({
        task_name: "/root/child_1/grandchild",
        nickname: "Molly",
      });
      expect(delegateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: session,
          parentPath: "/root/child_1",
          taskPrompt: "inspect",
          agentName: "grandchild",
          depthCap: 2,
          runInBackground: true,
        }),
      );
      const eventTypes = emit.mock.calls.map((call: readonly unknown[]) => {
        const envelope = call[0] as { msg?: { type?: string } } | undefined;
        return envelope?.msg?.type;
      });
      expect(eventTypes.at(0)).toBe("collab_agent_spawn_begin");
      expect(eventTypes).toContain("collab_agent_status");
      expect(eventTypes.at(-1)).toBe("collab_agent_spawn_end");
      const endEnvelope = emit.mock.calls.at(-1)?.[0] as
        | {
            msg?: {
              payload?: { status?: { status?: string; error?: string } };
            };
          }
        | undefined;
      expect(endEnvelope?.msg?.payload?.status?.status).toBe("running");
      expect(endEnvelope?.msg?.payload?.status?.error).toBeUndefined();
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("launches strict spawn_agent through the delegate runner and stores a joinable thread", async () => {
    const session = fakeSession();
    let status:
      | {
          status: "running";
          turnId: string;
          startedAtMs: number;
        }
      | {
          status: "completed";
          turnId: string;
          endedAtMs: number;
          lastMessage: string;
        } = {
      status: "running" as const,
      turnId: "turn-1",
      startedAtMs: 1,
    };
    const join = vi.fn(async () => ({
      threadId: "thread-1",
      durationMs: 7,
      outcome: "completed",
      finalMessage: "done",
    }));
    const live = {
      agentId: "thread-1",
      agentPath: "/root/task_1",
      nickname: "Snowcrash",
      role: { name: "worker" },
      status: {
        get value() {
          return status;
        },
      },
    };
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live,
        join,
      },
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const spawned = await byName.get("spawn_agent")!.execute({
      message: "inspect",
      task_name: "task_1",
      agent_type: "runner",
      reasoning_effort: "xhigh",
      fork_turns: "none",
    });

    expect(spawned.isError).not.toBe(true);
    expect(JSON.parse(spawned.content)).toEqual({
      task_name: "/root/task_1",
      nickname: "Snowcrash",
    });
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: session,
        parentPath: "/root",
        taskPrompt: "inspect",
        agentName: "task_1",
        role: "worker",
        reasoningEffort: "xhigh",
        runInBackground: true,
      }),
    );

    expect(byName.has("TaskOutput")).toBe(true);
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("mirrors spawned V2 agents into AppState tasks for TUI spinners and task UI", async () => {
    const session = fakeSession();
    const emit = vi.fn();
    (session as unknown as { emit: typeof emit }).emit = emit;
    let appState: unknown = { tasks: {} };
    (
      session as Session & {
        appStateBridge?: {
          setAppState(updater: (prev: unknown) => unknown): void;
        };
      }
    ).appStateBridge = {
      setAppState(updater) {
        appState = updater(appState);
      },
    };
    const live = {
      agentId: "thread-visible-1",
      agentPath: "/root/visible_task",
      nickname: "Visible",
      role: { name: "worker" },
      status: {
        value: {
          status: "running" as const,
          turnId: "turn-visible-1",
          startedAtMs: 1,
        },
      },
    };
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live,
        join: vi.fn(() => new Promise(() => {})),
      },
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const result = await tools.find((tool) => tool.name === "spawn_agent")!.execute({
      message: "inspect visible task",
      task_name: "visible_task",
      fork_turns: "none",
    });

    expect(result.isError).not.toBe(true);
    const task = (
      appState as {
        tasks: Record<string, unknown>;
      }
    ).tasks["thread-visible-1"];
    expect(task).toMatchObject({
      id: "thread-visible-1",
      type: "local_agent",
      status: "running",
      // description is the short humanized task_name (rail/transcript label),
      // not the full prompt; the prompt is preserved separately.
      description: "visible task",
      agentId: "thread-visible-1",
      prompt: "inspect visible task",
      isBackgrounded: true,
    });
    expect(isBackgroundTask(task)).toBe(true);
    expect(
      emit.mock.calls.map((call: readonly unknown[]) => {
        const envelope = call[0] as { msg?: { type?: string } } | undefined;
        return envelope?.msg?.type;
      }),
    ).toContain("collab_agent_status");
    const statusEnvelope = emit.mock.calls.find((call: readonly unknown[]) => {
      const envelope = call[0] as { msg?: { type?: string } } | undefined;
      return envelope?.msg?.type === "collab_agent_status";
    })?.[0] as
      | {
          msg?: {
            payload?: { threadId?: string; status?: string };
          };
        }
      | undefined;
    expect(statusEnvelope?.msg?.payload).toMatchObject({
      threadId: "thread-visible-1",
      status: "running",
    });
  });

  it("launches spawn_agent with a workspace markdown role from the canonical role registry", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-spawn-role-"));
    const agentsDir = join(workspaceRoot, ".agenc", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "reviewer.md"),
      [
        "---",
        "name: project-reviewer",
        "description: Review project diffs",
        "---",
        "Review the active diff before returning.",
      ].join("\n"),
    );

    const session = fakeSession();
    (session.config as { cwd?: string }).cwd = workspaceRoot;
    (
      session.sessionConfiguration as { cwd?: string }
    ).cwd = workspaceRoot;
    const joinThread = vi.fn(async () => ({
      threadId: "thread-custom",
      durationMs: 1,
      outcome: "completed",
      finalMessage: "done",
    }));
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "thread-custom",
          agentPath: "/root/custom_task",
          nickname: "Custom",
          role: { name: "project-reviewer" },
          status: {
            value: {
              status: "running",
              turnId: "turn-custom",
              startedAtMs: 1,
            },
          },
        },
        join: joinThread,
      },
    });

    try {
      const tools = createModelFacingTools({
        workspaceRoot,
        getSession: () => session,
      });
      const result = await tools.find((tool) => tool.name === "spawn_agent")!.execute({
        message: "inspect",
        task_name: "custom_task",
        agent_type: "project-reviewer",
        fork_turns: "none",
      });

      expect(result.isError).not.toBe(true);
      expect(delegateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "project-reviewer",
          taskPrompt: "inspect",
        }),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("lets TaskOutput and TaskStop use the spawn_agent returned task_name", async () => {
    const session = fakeSession();
    const abortController = new AbortController();
    const live = {
      agentId: "thread-handle-1",
      agentPath: "/root/task_handle",
      nickname: "TaskHandle",
      role: { name: "worker" },
      abortController,
      status: {
        value: {
          status: "running" as const,
          turnId: "turn-handle-1",
          startedAtMs: 1,
        },
      },
    };
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live,
        join: vi.fn(() => new Promise(() => {})),
      },
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const spawned = await byName.get("spawn_agent")!.execute({
      message: "inspect handle",
      task_name: "task_handle",
      fork_turns: "none",
    });
    const handle = (JSON.parse(spawned.content) as { task_name: string })
      .task_name;
    expect(handle).toBe("/root/task_handle");
    backgroundTaskLifecycle.appendOutput("thread-handle-1", "alias output");

    const output = await byName.get("TaskOutput")!.execute({
      task_id: handle,
      block: false,
    });
    expect(output.isError).toBeUndefined();
    expect(output.content).toContain(
      "<retrieval_status>not_ready</retrieval_status>",
    );
    expect(output.content).toContain("<task_id>thread-handle-1</task_id>");
    expect(output.content).toContain("<status>running</status>");
    expect(output.content).toContain("<output>\nalias output\n</output>");

    const stopped = await byName.get("TaskStop")!.execute({
      task_id: handle,
    });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).toBe(
      "Successfully stopped task: thread-handle-1 (task handle)",
    );
    expect(abortController.signal.aborted).toBe(true);
  });

  it("hides spawn_agent nickname metadata when configured", async () => {
    const session = fakeSession();
    (session.config as unknown as { multiAgentV2: unknown }).multiAgentV2 = {
      hideSpawnAgentMetadata: true,
    };
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "550e8400-e29b-41d4-a716-446655440000",
          agentPath: "/root/task_1",
          nickname: "Snowcrash",
          role: { name: "default" },
          status: {
            value: {
              status: "running",
              turnId: "turn-1",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(),
      },
    });

    const spawn = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "spawn_agent")!;

    const result = await spawn.execute({
      message: "inspect",
      task_name: "task_1",
      fork_turns: "none",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ task_name: "/root/task_1" });
  });

  it("rejects empty v2 agent messages before dispatch", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const result = await byName.get("send_message")!.execute({
      target: "/root/task_1",
      message: "   ",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe(
      "Empty message can't be sent to an agent",
    );
  });

  it("does not fall back to raw unresolved agent targets", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const result = await byName.get("send_message")!.execute({
      target: "missing_child",
      message: "hello",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      "agent reference cannot be resolved",
    );
  });

  it("send_message emits the interaction end event after delivery failure", async () => {
    const session = fakeSession();
    const emitted: unknown[] = [];
    (session as unknown as { emit: typeof session.emit }).emit = (event) => {
      emitted.push(event);
    };
    const control = {
      registerSessionRoot: vi.fn(),
      getLive: vi.fn((threadId: string) =>
        threadId === "agent-1"
          ? {
              agentId: "agent-1",
              agentPath: "/root/task_1",
              nickname: "TaskOne",
              role: { name: "worker" },
              metadata: {
                agentId: "agent-1",
                agentPath: "/root/task_1",
                agentNickname: "TaskOne",
                agentRole: "worker",
              },
            }
          : undefined,
      ),
      getAgentMetadata: vi.fn(() => ({
        agentId: "agent-1",
        agentPath: "/root/task_1",
        agentNickname: "TaskOne",
        agentRole: "worker",
      })),
      resolveAgentReference: vi.fn(() => "agent-1"),
      sendInterAgentCommunication: vi.fn(async () => {
        throw new Error("agent with id agent-1 is closed");
      }),
      getStatus: vi.fn(async () => ({ status: "shutdown" as const })),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      });
      const result = await tools.find((tool) => tool.name === "send_message")!.execute({
        target: "/root/task_1",
        message: "hello",
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toBe(
        "agent with id agent-1 is closed",
      );
      expect(
        emitted.map((event) => (event as { msg: { type: string } }).msg.type),
      ).toEqual([
        "collab_agent_interaction_begin",
        "collab_agent_interaction_end",
      ]);
      expect(
        (emitted[1] as { msg: { payload: { status: unknown } } }).msg.payload.status,
      ).toEqual({ status: "shutdown" });
    } finally {
      _clearAgentControlCacheForTesting();
    }
  });

  it("wait_agent waits for parent mailbox updates without enumerating agent statuses", async () => {
    const session = fakeSession();
    const emitted: unknown[] = [];
    (session as unknown as { emit: typeof session.emit }).emit = (event) => {
      emitted.push(event);
    };
    const waitForMailboxChange = vi.fn(async () => true);
    const sessionWithMailboxWait = session as unknown as {
      waitForMailboxChange: typeof waitForMailboxChange;
    };
    sessionWithMailboxWait.waitForMailboxChange = waitForMailboxChange;
    const control = {
      listAgents: vi.fn(() => []),
      getLive: vi.fn(() => undefined),
      resolveAgentReference: vi.fn(() => "agent-1"),
      subscribeStatus: vi.fn(),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const wait = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "wait_agent")!;

      const result = await wait.execute({});

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({
        message: "Wait completed.",
        timed_out: false,
      });
      expect(waitForMailboxChange).toHaveBeenCalledWith(30_000);
      expect(control.listAgents).not.toHaveBeenCalled();
      expect(control.subscribeStatus).not.toHaveBeenCalled();
      expect(
        emitted.map((event) => (event as { msg: { type: string } }).msg.type),
      ).toEqual(["collab_waiting_begin", "collab_waiting_end"]);
      expect(
        (
          emitted[0] as {
            msg: { payload: { receiverThreadIds: unknown[] } };
          }
        ).msg.payload.receiverThreadIds,
      ).toEqual([]);
      expect(
        (
          emitted[1] as {
            msg: {
              payload: { statuses: unknown; agentStatuses: unknown[] };
            };
          }
        ).msg.payload.statuses,
      ).toEqual({});
      expect(
        (
          emitted[1] as {
            msg: { payload: { agentStatuses: unknown[] } };
          }
        ).msg.payload.agentStatuses,
      ).toEqual([]);
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("wait_agent returns drained mailbox updates for the current turn", async () => {
    const session = fakeSession();
    const emitted: unknown[] = [];
    (session as unknown as { emit: typeof session.emit }).emit = (event) => {
      emitted.push(event);
    };
    const waitForMailboxChange = vi.fn(async () => true);
    const drainPendingInputMessages = vi.fn(() => [
      {
        role: "user",
        content: "Message from reviewer:\nfinished provider-boundary audit",
      },
    ]);
    const sessionWithMailboxWait = session as unknown as {
      waitForMailboxChange: typeof waitForMailboxChange;
      drainPendingInputMessages: typeof drainPendingInputMessages;
    };
    sessionWithMailboxWait.waitForMailboxChange = waitForMailboxChange;
    sessionWithMailboxWait.drainPendingInputMessages = drainPendingInputMessages;
    _setAgentControlForTesting(session, {
      control: {
        listAgents: vi.fn(() => []),
        getLive: vi.fn(() => undefined),
        resolveAgentReference: vi.fn(() => "agent-1"),
      } as never,
      registry: {} as never,
    });
    try {
      const wait = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "wait_agent")!;

      const result = await wait.execute({});

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({
        message: "Wait completed.",
        timed_out: false,
        updates: [
          {
            role: "user",
            content: "Message from reviewer:\nfinished provider-boundary audit",
          },
        ],
      });
      expect(drainPendingInputMessages).toHaveBeenCalledOnce();
      expect(
        (
          emitted[1] as {
            msg: {
              payload: {
                mailboxUpdates: readonly { readonly content: string }[];
              };
            };
          }
        ).msg.payload.mailboxUpdates[0]?.content,
      ).toContain("finished provider-boundary audit");
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("wait_agent reports timeout when no parent mailbox update arrives", async () => {
    const session = fakeSession();
    const waitForMailboxChange = vi.fn(async () => false);
    const sessionWithMailboxWait = session as unknown as {
      waitForMailboxChange: typeof waitForMailboxChange;
    };
    sessionWithMailboxWait.waitForMailboxChange = waitForMailboxChange;
    const wait = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "wait_agent")!;

    const result = await wait.execute({ timeout_ms: 10_000 });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({
      message: "Wait timed out.",
      timed_out: true,
    });
    expect(waitForMailboxChange).toHaveBeenCalledWith(10_000);
  });

  it("wait_agent uses configured default and max timeout bounds", async () => {
    const session = fakeSession();
    (session as unknown as {
      config: {
        multiAgentV2: {
          minWaitTimeoutMs: number;
          defaultWaitTimeoutMs: number;
          maxWaitTimeoutMs: number;
        };
      };
    }).config = {
      multiAgentV2: {
        minWaitTimeoutMs: 500,
        defaultWaitTimeoutMs: 1_250,
        maxWaitTimeoutMs: 2_000,
      },
    };
    const waitForMailboxChange = vi.fn(async () => true);
    const sessionWithMailboxWait = session as unknown as {
      waitForMailboxChange: typeof waitForMailboxChange;
    };
    sessionWithMailboxWait.waitForMailboxChange = waitForMailboxChange;
    const wait = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "wait_agent")!;

    const defaulted = await wait.execute({});
    const tooLarge = await wait.execute({ timeout_ms: 2_001 });

    expect(defaulted.isError).toBeUndefined();
    expect(waitForMailboxChange).toHaveBeenCalledWith(1_250);
    expect(JSON.parse(tooLarge.content)).toEqual({
      error: "timeout_ms must be at most 2000",
    });
    expect(tooLarge.isError).toBe(true);
    expect(
      wait.inputSchema.properties?.timeout_ms &&
        "description" in wait.inputSchema.properties.timeout_ms
        ? wait.inputSchema.properties.timeout_ms.description
        : undefined,
    ).toBe("Optional timeout in milliseconds. Defaults to 1250, min 500, max 2000.");
  });

  it("wait_agent rejects fractional timeout_ms values", async () => {
    const wait = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => fakeSession(),
    }).find((tool) => tool.name === "wait_agent")!;

    const result = await wait.execute({ timeout_ms: 10_000.5 });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: "timeout_ms must be an integer",
    });
  });

  it("assign_task accepts a completed live agent and triggers the next turn", async () => {
    const session = fakeSession();
    const emitted: unknown[] = [];
    (session as unknown as { emit: typeof session.emit }).emit = (event) => {
      emitted.push(event);
    };
    const completedStatus = {
      status: "completed" as const,
      turnId: "turn-1",
      endedAtMs: 1,
      lastMessage: "done",
    };
    const sendInterAgentCommunication = vi.fn();
    const control = {
      registerSessionRoot: vi.fn(),
      getLive: vi.fn((threadId: string) =>
        threadId === "agent-1"
          ? {
              agentId: "agent-1",
              agentPath: "/root/task_1",
              nickname: "TaskOne",
              role: { name: "worker" },
              status: { value: completedStatus },
              metadata: {
                agentId: "agent-1",
                agentPath: "/root/task_1",
                agentNickname: "TaskOne",
                agentRole: "worker",
              },
            }
          : undefined,
      ),
      getAgentMetadata: vi.fn(() => ({
        agentId: "agent-1",
        agentPath: "/root/task_1",
        agentNickname: "TaskOne",
        agentRole: "worker",
      })),
      resolveAgentReference: vi.fn(() => "agent-1"),
      sendInterAgentCommunication,
      getStatus: vi.fn(async () => completedStatus),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const assign = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "assign_task")!;

      const result = await assign.execute({
        target: "/root/task_1",
        message: "report now",
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(String(result.content))).toMatchObject({
        ok: true,
      });
      expect(sendInterAgentCommunication).toHaveBeenCalledWith("agent-1", {
        author: "/root",
        recipient: "/root/task_1",
        content: "report now",
        triggerTurn: true,
      });
      expect(
        emitted.map((event) => (event as { msg: { type: string } }).msg.type),
      ).toEqual([
        "collab_agent_interaction_begin",
        "collab_agent_interaction_end",
      ]);
      expect(
        (emitted[1] as { msg: { payload: { status: unknown } } }).msg.payload.status,
      ).toEqual(completedStatus);
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("list_agents returns AgenC V2 snake_case entries only", async () => {
    const session = fakeSession();
    const control = {
      registerSessionRoot: vi.fn(),
      listAgents: vi.fn(() => [
        {
          agentName: "/root",
          agentStatus: { status: "pending_init" },
          lastTaskMessage: "Main thread",
        },
        {
          agentName: "/root/worker",
          agentStatus: {
            status: "completed",
            turnId: "t",
            endedAtMs: 1,
            lastMessage: "done",
          },
          lastTaskMessage: "inspect",
        },
      ]),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const byName = new Map(
        createModelFacingTools({
          workspaceRoot: process.cwd(),
          getSession: () => session,
        }).map((tool) => [tool.name, tool]),
      );

      const roleFiltered = await byName.get("list_agents")!.execute({
        role: "worker",
      });
      expect(roleFiltered.isError).toBe(true);
      expect(JSON.parse(roleFiltered.content).error).toBe("unknown field `role`");
      for (const path_prefix of [0, {}, []]) {
        const invalidPathPrefix = await byName.get("list_agents")!.execute({
          path_prefix,
        });
        expect(invalidPathPrefix.isError).toBe(true);
        expect(JSON.parse(invalidPathPrefix.content).error).toBe(
          "path_prefix must be a string",
        );
      }

      const result = await byName.get("list_agents")!.execute({});
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({
        agents: [
          {
            agent_name: "/root",
            agent_status: "pending_init",
            last_task_message: "Main thread",
          },
          {
            agent_name: "/root/worker",
            agent_status: { completed: "done" },
            last_task_message: "inspect",
          },
        ],
      });
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("list_agents registers the current root before listing", async () => {
    const session = fakeSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    expect(control.listAgents()).toEqual([]);
    _setAgentControlForTesting(session, { control, registry });
    try {
      const listAgents = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "list_agents")!;

      const result = await listAgents.execute({});

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({
        agents: [
          {
            agent_name: "/root",
            agent_status: "pending_init",
            last_task_message: "Main thread",
          },
        ],
      });
      expect(control.listAgents().some((agent) => agent.agentName === "/root")).toBe(true);
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("send_message resolves the current root target from child context", async () => {
    const session = fakeSession();
    const mailboxSend = vi.fn(() => 1);
    (session as unknown as { mailbox: { hasPending: () => boolean; send: typeof mailboxSend } }).mailbox = {
      hasPending: () => false,
      send: mailboxSend,
    };
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const child = await control.spawn({
      parentPath: "/root",
      threadId: "agent-worker",
      agentName: "worker",
    });
    expect(control.listAgents().some((agent) => agent.agentName === "/root")).toBe(
      false,
    );
    _setAgentControlForTesting(session, { control, registry });
    try {
      const sendMessage = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "send_message")!;

      const result = await sendMessage.execute({
        [SESSION_ID_ARG]: child.agentId,
        target: "/root",
        message: "done",
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(String(result.content))).toMatchObject({
        ok: true,
      });
      expect(mailboxSend).toHaveBeenCalledWith(
        expect.objectContaining({
          author: "/root/worker",
          recipient: "/root",
          content: "done",
          triggerTurn: false,
          direction: "up",
        }),
      );
      expect(control.listAgents().some((agent) => agent.agentName === "/root")).toBe(
        true,
      );
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("assign_task rejects the current root target from child context", async () => {
    const session = fakeSession();
    const mailboxSend = vi.fn(() => 1);
    (session as unknown as { mailbox: { hasPending: () => boolean; send: typeof mailboxSend } }).mailbox = {
      hasPending: () => false,
      send: mailboxSend,
    };
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    const child = await control.spawn({
      parentPath: "/root",
      threadId: "agent-worker",
      agentName: "worker",
    });
    _setAgentControlForTesting(session, { control, registry });
    try {
      const assign = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "assign_task")!;

      const result = await assign.execute({
        [SESSION_ID_ARG]: child.agentId,
        target: "/root",
        message: "run this",
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toBe(
        "Tasks can't be assigned to the root agent",
      );
      expect(mailboxSend).not.toHaveBeenCalled();
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("close_agent rejects the current root target after resolving it", async () => {
    const session = fakeSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry });
    _setAgentControlForTesting(session, { control, registry });
    try {
      const close = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "close_agent")!;

      const result = await close.execute({ target: "/root" });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toBe(
        "root is not a spawned agent",
      );
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("rejects closing the root agent", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const close = tools.find((tool) => tool.name === "close_agent")!;

    const result = await close.execute({ target: "/root" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe("root is not a spawned agent");
  });

  it("close_agent emits receiver nickname and role metadata", async () => {
    const session = fakeSession();
    const emit = vi.fn();
    (session as unknown as { emit: typeof emit }).emit = emit;
    const status = {
      status: "running" as const,
      turnId: "turn-1",
      startedAtMs: 1,
    };
    const control = {
      registerSessionRoot: vi.fn(),
      resolveAgentReference: vi.fn(() => "550e8400-e29b-41d4-a716-446655440003"),
      getLive: vi.fn(() => ({
        agentId: "550e8400-e29b-41d4-a716-446655440003",
        agentPath: "/root/live",
        nickname: "Neuromancer",
        role: { name: "worker" },
        status: { value: status },
      })),
      getAgentMetadata: vi.fn(() => ({
        agentId: "550e8400-e29b-41d4-a716-446655440003",
        agentPath: "/root/live",
        agentNickname: "Neuromancer",
        agentRole: "worker",
        depth: 1,
      })),
      shutdown: vi.fn(),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const close = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "close_agent")!;

      const result = await close.execute({ target: "/root/live" });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({ previous_status: "running" });
      expect(emit.mock.calls.map((call) => call[0].msg.payload)).toEqual([
        expect.objectContaining({
          receiverAgentNickname: "Neuromancer",
          receiverAgentRole: "worker",
        }),
        expect.objectContaining({
          receiverAgentNickname: "Neuromancer",
          receiverAgentRole: "worker",
          status,
        }),
      ]);
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("close_agent emits the close end event after shutdown failure", async () => {
    const session = fakeSession();
    const emit = vi.fn();
    (session as unknown as { emit: typeof emit }).emit = emit;
    const status = {
      status: "running" as const,
      turnId: "turn-1",
      startedAtMs: 1,
    };
    const unsubscribe = vi.fn();
    const control = {
      registerSessionRoot: vi.fn(),
      resolveAgentReference: vi.fn(() => "550e8400-e29b-41d4-a716-446655440004"),
      getLive: vi.fn((threadId: string) =>
        threadId === "550e8400-e29b-41d4-a716-446655440004"
          ? {
              agentId: "550e8400-e29b-41d4-a716-446655440004",
              agentPath: "/root/failing_close",
              nickname: "ShutdownProbe",
              role: { name: "worker" },
              status: { value: status },
            }
          : undefined,
      ),
      getAgentMetadata: vi.fn((threadId: string) =>
        threadId === "550e8400-e29b-41d4-a716-446655440004"
          ? {
              agentId: "550e8400-e29b-41d4-a716-446655440004",
              agentPath: "/root/failing_close",
              agentNickname: "ShutdownProbe",
              agentRole: "worker",
              depth: 1,
            }
          : undefined,
      ),
      subscribeStatus: vi.fn(async () => ({ value: status, unsubscribe })),
      shutdown: vi.fn(async () => {
        throw new Error("close failed");
      }),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const close = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "close_agent")!;

      const result = await close.execute({ target: "/root/failing_close" });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toBe("close failed");
      expect(unsubscribe).toHaveBeenCalled();
      expect(emit.mock.calls.map((call) => call[0].msg.type)).toEqual([
        "collab_close_begin",
        "collab_close_end",
      ]);
      expect(emit.mock.calls[1]?.[0].msg.payload).toEqual(
        expect.objectContaining({
          receiverThreadId: "550e8400-e29b-41d4-a716-446655440004",
          receiverAgentNickname: "ShutdownProbe",
          receiverAgentRole: "worker",
          status,
        }),
      );
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  function notebookSource(cells: readonly Record<string, unknown>[]): string {
    return JSON.stringify({
      cells,
      metadata: { language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    });
  }

  function findModelFacingTool(workspace: string, name: string) {
    const tool = createModelFacingTools({
      workspaceRoot: workspace,
      getSession: () => null,
    }).find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    return tool!;
  }

  it("edits notebook cells structurally", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-ws-"));
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        notebookSource([
          {
            cell_type: "code",
            id: "cell-a",
            metadata: {},
            source: "print('old')\n",
            execution_count: 12,
            outputs: [{ output_type: "stream", name: "stdout", text: "old\n" }],
          },
        ]),
        "utf8",
      );

      const tool = findModelFacingTool(workspace, "NotebookEdit");

      const result = await tool.execute({
        notebook_path: notebookPath,
        cell_id: "cell-a",
        new_source: "print('new')",
      });

      expect(result.isError).toBeUndefined();
      const updated = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(updated.cells[0].source).toBe("print('new')");
      expect(updated.cells[0].execution_count).toBeNull();
      expect(updated.cells[0].outputs).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires a full NotebookRead before session-backed NotebookEdit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-read-edit-ws-"));
    const sessionId = "notebook-read-edit-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        notebookSource([
          {
            cell_type: "code",
            id: "cell-a",
            metadata: {},
            source: "print('old')",
            execution_count: 7,
            outputs: [{ output_type: "stream", name: "stdout", text: "old\n" }],
          },
        ]),
        "utf8",
      );
      const readTool = findModelFacingTool(workspace, "NotebookRead");
      const editTool = findModelFacingTool(workspace, "NotebookEdit");

      const readResult = await readTool.execute({
        notebook_path: notebookPath,
        __agencSessionId: sessionId,
      });
      expect(readResult.isError).toBeUndefined();

      const editResult = await editTool.execute({
        notebook_path: notebookPath,
        cell_id: "cell-a",
        new_source: "print('new')",
        __agencSessionId: sessionId,
      });

      expect(editResult.isError).toBeUndefined();
      const updatedRaw = await readFile(notebookPath, "utf8");
      const updated = JSON.parse(updatedRaw);
      expect(updated.cells[0].source).toBe("print('new')");
      expect(updated.cells[0].execution_count).toBeNull();
      expect(updated.cells[0].outputs).toEqual([]);
      expect(getSessionReadSnapshot(sessionId, notebookPath)?.rawContent).toBe(
        updatedRaw,
      );
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects session-backed NotebookEdit without a prior full read", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-no-read-ws-"));
    const sessionId = "notebook-no-read-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      const original = notebookSource([
        {
          cell_type: "code",
          id: "cell-a",
          metadata: {},
          source: "print('old')",
          execution_count: null,
          outputs: [],
        },
      ]);
      await writeFile(notebookPath, original, "utf8");
      const editTool = findModelFacingTool(workspace, "NotebookEdit");

      const result = await editTool.execute({
        notebook_path: notebookPath,
        cell_id: "cell-a",
        new_source: "print('new')",
        __agencSessionId: sessionId,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("File has not been read yet");
      await expect(readFile(notebookPath, "utf8")).resolves.toBe(original);
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects NotebookEdit after a partial NotebookRead", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-partial-ws-"));
    const sessionId = "notebook-partial-read-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      const original = notebookSource([
        {
          cell_type: "markdown",
          id: "intro",
          metadata: {},
          source: "# Intro",
        },
        {
          cell_type: "code",
          id: "cell-a",
          metadata: {},
          source: "print('old')",
          execution_count: null,
          outputs: [],
        },
      ]);
      await writeFile(notebookPath, original, "utf8");
      const readTool = findModelFacingTool(workspace, "NotebookRead");
      const editTool = findModelFacingTool(workspace, "NotebookEdit");

      await readTool.execute({
        notebook_path: notebookPath,
        offset: 1,
        limit: 4,
        __agencSessionId: sessionId,
      });
      const result = await editTool.execute({
        notebook_path: notebookPath,
        cell_id: "cell-a",
        new_source: "print('new')",
        __agencSessionId: sessionId,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("File has not been read yet");
      await expect(readFile(notebookPath, "utf8")).resolves.toBe(original);
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects NotebookEdit when the notebook changed since read", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-stale-ws-"));
    const sessionId = "notebook-stale-read-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      const original = notebookSource([
        {
          cell_type: "code",
          id: "cell-a",
          metadata: {},
          source: "print('old')",
          execution_count: null,
          outputs: [],
        },
      ]);
      const externallyChanged = notebookSource([
        {
          cell_type: "code",
          id: "cell-a",
          metadata: {},
          source: "print('external')",
          execution_count: null,
          outputs: [],
        },
      ]);
      await writeFile(notebookPath, original, "utf8");
      const readTool = findModelFacingTool(workspace, "NotebookRead");
      const editTool = findModelFacingTool(workspace, "NotebookEdit");

      await readTool.execute({
        notebook_path: notebookPath,
        __agencSessionId: sessionId,
      });
      await writeFile(notebookPath, externallyChanged, "utf8");
      const result = await editTool.execute({
        notebook_path: notebookPath,
        cell_id: "cell-a",
        new_source: "print('new')",
        __agencSessionId: sessionId,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("File has been modified since read");
      await expect(readFile(notebookPath, "utf8")).resolves.toBe(
        externallyChanged,
      );
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("handles notebook cell addressing and edit modes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-modes-ws-"));
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        notebookSource([
          {
            cell_type: "markdown",
            id: "intro",
            metadata: {},
            source: "# Intro",
          },
          {
            cell_type: "code",
            id: "code-a",
            metadata: {},
            source: "print('old')",
            execution_count: 3,
            outputs: [{ output_type: "stream", name: "stdout", text: "old\n" }],
          },
          {
            cell_type: "markdown",
            id: "tail",
            metadata: {},
            source: "Tail",
          },
        ]),
        "utf8",
      );
      const tool = findModelFacingTool(workspace, "NotebookEdit");

      await tool.execute({
        notebook_path: notebookPath,
        cell_id: "cell-1",
        new_source: "print('numeric')",
      });
      await tool.execute({
        notebook_path: notebookPath,
        edit_mode: "insert",
        cell_type: "markdown",
        new_source: "# Start",
      });
      await tool.execute({
        notebook_path: notebookPath,
        cell_id: "intro",
        edit_mode: "insert",
        cell_type: "code",
        new_source: "print('after intro')",
      });
      await tool.execute({
        notebook_path: notebookPath,
        cell_id: "tail",
        edit_mode: "delete",
        new_source: "",
      });

      const updated = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(updated.cells.map((cell: Record<string, unknown>) => cell.source))
        .toEqual([
          "# Start",
          "# Intro",
          "print('after intro')",
          "print('numeric')",
        ]);
      expect(updated.cells[2]).toMatchObject({
        cell_type: "code",
        execution_count: null,
        outputs: [],
      });
      expect(updated.cells.some((cell: Record<string, unknown>) => cell.id === "tail"))
        .toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reads notebook cells through NotebookRead", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-read-ws-"));
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "markdown",
              id: "intro",
              metadata: {},
              source: ["# Demo\n", "Notebook body\n"],
            },
            {
              cell_type: "code",
              id: "code-a",
              metadata: {},
              source: ["print('hi')\n"],
              execution_count: 1,
              outputs: [
                {
                  output_type: "stream",
                  name: "stdout",
                  text: ["hi\n"],
                },
              ],
            },
          ],
          metadata: { language_info: { name: "python" } },
          nbformat: 4,
          nbformat_minor: 5,
        }),
        "utf8",
      );

      const tool = createModelFacingTools({
        workspaceRoot: workspace,
        getSession: () => null,
      }).find((candidate) => candidate.name === "NotebookRead")!;

      const result = await tool.execute({
        notebook_path: notebookPath,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Notebook:");
      expect(result.content).toContain("Cell 1 [markdown] id=intro");
      expect(result.content).toContain("Notebook body");
      expect(result.content).toContain("Cell 2 [code] id=code-a execution_count=1");
      expect(result.content).toContain("Output 1 [stream]:");
      expect(result.content).toContain("hi");
      expect(result.metadata).toMatchObject({
        mediaType: "application/x-ipynb+json",
        cellCount: 2,
        language: "python",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("dispatches NotebookRead with a raw string notebook path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-dispatch-ws-"));
    try {
      await writeFile(
        join(workspace, "demo.ipynb"),
        JSON.stringify({
          cells: [
            {
              cell_type: "markdown",
              id: "intro",
              metadata: {},
              source: ["# Dispatch\n"],
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        }),
        "utf8",
      );
      const registry = buildBootstrapToolRegistry({
        workspaceRoot: workspace,
        mcpManager: fakeMcpManager() as never,
        getSession: () => null,
        emitWarning: () => {},
      });

      const result = await registry.dispatch({
        id: "notebook-read-string",
        name: "NotebookRead",
        arguments: "demo.ipynb",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Cell 1 [markdown] id=intro");
      expect(result.content).toContain("# Dispatch");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("dispatches NotebookEdit with a raw string notebook path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-edit-dispatch-ws-"));
    try {
      await writeFile(
        join(workspace, "demo.ipynb"),
        notebookSource([
          {
            cell_type: "markdown",
            id: "intro",
            metadata: {},
            source: "# Dispatch",
          },
        ]),
        "utf8",
      );
      const registry = buildBootstrapToolRegistry({
        workspaceRoot: workspace,
        mcpManager: fakeMcpManager() as never,
        getSession: () => null,
        emitWarning: () => {},
      });

      const result = await registry.dispatch({
        id: "notebook-edit-string",
        name: "NotebookEdit",
        arguments: "demo.ipynb",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("new_source must be a string");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("delegates NotebookRead path permissions to FileRead", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-perm-ws-"));
    const outside = await mkdtemp(join(tmpdir(), "agenc-notebook-perm-out-"));
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      const outsidePath = join(outside, "demo.ipynb");
      const tool = createModelFacingTools({
        workspaceRoot: workspace,
        getSession: () => null,
      }).find((candidate) => candidate.name === "NotebookRead")!;
      const context = fakeEvaluatorContext();

      const allowed = await tool.checkPermissions?.(
        { notebook_path: notebookPath },
        context,
      );
      expect(allowed?.behavior).toBe("allow");
      expect(
        (allowed as { updatedInput?: Record<string, unknown> } | undefined)
          ?.updatedInput,
      ).toMatchObject({
        file_path: notebookPath,
        notebook_path: notebookPath,
      });

      const blocked = await tool.checkPermissions?.(
        { notebook_path: outsidePath },
        context,
      );
      expect(blocked).toMatchObject({
        behavior: "ask",
        blockedPath: outsidePath,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("delegates NotebookEdit path permissions to Write", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-edit-perm-ws-"));
    const outside = await mkdtemp(join(tmpdir(), "agenc-notebook-edit-perm-out-"));
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      const outsidePath = join(outside, "demo.ipynb");
      const outsideOriginal = notebookSource([
        {
          cell_type: "markdown",
          id: "intro",
          metadata: {},
          source: "# Outside",
        },
      ]);
      await writeFile(outsidePath, outsideOriginal, "utf8");
      const tool = findModelFacingTool(workspace, "NotebookEdit");
      const context = fakeEvaluatorContext(
        createEmptyToolPermissionContext({ mode: "acceptEdits" }),
      );

      const allowed = await tool.checkPermissions?.(
        {
          notebook_path: notebookPath,
          cell_id: "intro",
          new_source: "# Updated",
        },
        context,
      );
      expect(allowed?.behavior).toBe("allow");
      expect(
        (allowed as { updatedInput?: Record<string, unknown> } | undefined)
          ?.updatedInput,
      ).toMatchObject({
        file_path: notebookPath,
        notebook_path: notebookPath,
      });

      const blocked = await tool.checkPermissions?.(
        {
          notebook_path: outsidePath,
          cell_id: "intro",
          new_source: "# Updated",
        },
        context,
      );
      expect(blocked).toMatchObject({
        behavior: "ask",
        blockedPath: outsidePath,
      });
      await expect(readFile(outsidePath, "utf8")).resolves.toBe(outsideOriginal);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("WebSearch real backends (task 4)", () => {
  const withFetchMock = async (
    fetchMock: ReturnType<typeof vi.fn>,
    run: () => Promise<void>,
  ) => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = previousFetch;
    }
  };

  it("keyless default scrapes DuckDuckGo HTML for real SERP results", async () => {
    const html = [
      '<div class="result">',
      '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fagenc.tech%2Fdocs&amp;rut=abc">AgenC <b>Docs</b></a>',
      '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fagenc.tech%2Fdocs">The <b>docs</b> for AgenC.</a>',
      "</div>",
      '<div class="result">',
      '<a rel="nofollow" class="result__a" href="https://example.com/page">Example Page</a>',
      '<a class="result__snippet" href="https://example.com/page">An example snippet.</a>',
      "</div>",
    ].join("\n");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => html,
      json: async () => ({}),
    });
    await withFetchMock(fetchMock, async () => {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const result = await tools
        .find((tool) => tool.name === "WebSearch")!
        .execute({ query: "agenc docs" });
      const parsed = JSON.parse(result.content);
      // Real SERP path, not the instant-answer API.
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        "html.duckduckgo.com/html/",
      );
      expect(parsed.source).toBe("duckduckgo_html");
      expect(parsed.results).toEqual([
        {
          title: "AgenC Docs",
          url: "https://agenc.tech/docs",
          snippet: "The docs for AgenC.",
        },
        {
          title: "Example Page",
          url: "https://example.com/page",
          snippet: "An example snippet.",
        },
      ]);
    });
  });

  it("falls back to the instant-answer API when the HTML scrape yields nothing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        text: async () => "<html><body>captcha wall</body></html>",
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          Heading: "AgenC",
          AbstractText: "abstract",
          RelatedTopics: [
            { Text: "AgenC - protocol", FirstURL: "https://agenc.tech" },
          ],
        }),
      });
    await withFetchMock(fetchMock, async () => {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const result = await tools
        .find((tool) => tool.name === "WebSearch")!
        .execute({ query: "agenc" });
      const parsed = JSON.parse(result.content);
      expect(parsed.source).toBe("duckduckgo_instant_answer");
      expect(parsed.results[0].url).toBe("https://agenc.tech");
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        "api.duckduckgo.com",
      );
    });
  });

  it("supports SearXNG endpoints via AGENC_WEB_SEARCH_KIND=searxng", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        results: [
          {
            title: "Result One",
            url: "https://one.example",
            content: "first snippet",
          },
        ],
      }),
    });
    await withFetchMock(fetchMock, async () => {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
        env: {
          AGENC_WEB_SEARCH_ENDPOINT: "https://searx.local/search",
          AGENC_WEB_SEARCH_KIND: "searxng",
        } as NodeJS.ProcessEnv,
      });
      const result = await tools
        .find((tool) => tool.name === "WebSearch")!
        .execute({ query: "one" });
      const parsed = JSON.parse(result.content);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "https://searx.local/search?q=one&format=json",
      );
      expect(parsed.kind).toBe("searxng");
      expect(parsed.results).toEqual([
        {
          title: "Result One",
          url: "https://one.example",
          snippet: "first snippet",
        },
      ]);
    });
  });

  it("supports Brave endpoints with the subscription token header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        web: {
          results: [
            {
              title: "Brave Result",
              url: "https://brave.example",
              description: "brave snippet",
            },
          ],
        },
      }),
    });
    await withFetchMock(fetchMock, async () => {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
        env: {
          AGENC_WEB_SEARCH_ENDPOINT:
            "https://api.search.brave.com/res/v1/web/search",
          AGENC_WEB_SEARCH_KIND: "brave",
          AGENC_WEB_SEARCH_API_KEY: "brave-key",
        } as NodeJS.ProcessEnv,
      });
      const result = await tools
        .find((tool) => tool.name === "WebSearch")!
        .execute({ query: "brave" });
      const parsed = JSON.parse(result.content);
      const init = fetchMock.mock.calls[0]?.[1] as
        | { headers?: Record<string, string> }
        | undefined;
      expect(init?.headers?.["X-Subscription-Token"]).toBe("brave-key");
      expect(parsed.results[0].url).toBe("https://brave.example");
    });
  });

  it("reads the endpoint from config.toml tools config when env is unset", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        results: [
          { title: "Cfg", url: "https://cfg.example", snippet: "from config" },
        ],
      }),
    });
    await withFetchMock(fetchMock, async () => {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
        toolsConfig: {
          web_search_endpoint: "https://cfg.local/search",
          web_search_endpoint_kind: "json",
        },
      });
      const result = await tools
        .find((tool) => tool.name === "WebSearch")!
        .execute({ query: "cfg" });
      const parsed = JSON.parse(result.content);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        "https://cfg.local/search?q=cfg",
      );
      expect(parsed.results[0].url).toBe("https://cfg.example");
    });
  });
});

describe("WebFetch prompt extraction (task 4)", () => {
  beforeEach(() => {
    installDeterministicPublicWebFetchDns();
  });

  afterEach(() => {
    __setLiveWebFetchDnsAllLookupForTests(undefined);
  });

  it("runs the prompt against fetched content instead of echoing it", async () => {
    const paragraph =
      "<p>The current release is version 9.9.9 and it shipped today.</p>";
    const html = `<!doctype html><html><body><h1>Release notes</h1>${paragraph.repeat(400)}</body></html>`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://agenc.tech/releases",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/html" : null,
      },
      text: async () => html,
    });
    const chat = vi.fn().mockResolvedValue({
      content: "The current release is 9.9.9.",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model",
      finishReason: "stop",
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const session = withProvider(fakeSession(), fakeProvider({}, chat));
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      });
      const result = await tools
        .find((tool) => tool.name === "web_fetch")!
        .execute({
          url: "https://agenc.tech/releases",
          prompt: "What is the current release version?",
        });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      // The prompt was EXECUTED, not merely echoed back.
      expect(parsed.extracted).toBe("The current release is 9.9.9.");
      expect(parsed.content).toBeUndefined();
      expect(String(parsed.content_preview).length).toBeLessThanOrEqual(2_000);
      // Raw content is recoverable from disk.
      expect(typeof parsed.full_content_path).toBe("string");
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(parsed.full_content_path, "utf8")).toContain(
        "version 9.9.9",
      );
      // The extraction model saw the page and the task.
      const chatMessages = chat.mock.calls[0]?.[0] as Array<{
        content: string;
      }>;
      expect(chatMessages[0]?.content).toContain("version 9.9.9");
      expect(chatMessages[0]?.content).toContain(
        "What is the current release version?",
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("keeps the raw-content shape when no prompt is given or content is small", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://agenc.tech/small",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/plain" : null,
      },
      text: async () => "tiny content",
    });
    const chat = vi.fn();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const session = withProvider(fakeSession(), fakeProvider({}, chat));
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      });
      const result = await tools
        .find((tool) => tool.name === "web_fetch")!
        .execute({
          url: "https://agenc.tech/small",
          prompt: "summarize",
        });
      const parsed = JSON.parse(result.content);
      expect(parsed.content).toBe("tiny content");
      expect(parsed.extracted).toBeUndefined();
      expect(chat).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
