import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { buildToolRegistry } from "../tool-registry.js";
import type { Tool } from "./types.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import { SYSTEM_SEARCH_TOOLS_NAME } from "./system/tool-search-name.js";
import {
  DEFER_RARE_TOOLS_ENV,
  DELEGATION_COMPANION_TOOLS,
  PROCESS_SESSION_TOOLS,
  RARE_DEFERRED_TOOLS,
  rareToolDeferralEnabled,
} from "../../src/tools/rare-tool-deferral.js";
import { buildBootstrapToolRegistry } from "../../src/bin/bootstrap-tool-registry.js";
import {
  getSelectedProviderEnvironment,
  runWithStartupProviderSelection,
} from "../../src/utils/model/providers.js";

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    recoveryCategory: "read-only",
    execute: async () => ({ content: "ok" }),
  } as unknown as Tool;
}

function registry(deferRareTools?: boolean, lightMode?: boolean) {
  return buildToolRegistry({
    workspaceRoot: "/tmp",
    requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    extraTools: [
      fakeTool("VerifyPlanExecution"), fakeTool("SendUserMessage"), fakeTool("ImagineImage"),
      fakeTool("spawn_agent"), ...DELEGATION_COMPANION_TOOLS.map(fakeTool),
    ],
    ...(deferRareTools !== undefined ? { deferRareTools } : {}),
    ...(lightMode !== undefined ? { lightMode } : {}),
  });
}

function advertised(tools: ReturnType<typeof registry>): string[] {
  return tools.toLLMTools().map((tool) => tool.function.name);
}

describe("deferred rare tools", () => {
  test("advertise every tool when the switch is off", () => {
    const tools = registry(false);
    expect(advertised(tools)).toEqual(expect.arrayContaining(["VerifyPlanExecution", "SendUserMessage", "ImagineImage"]));
    const search = tools.toLLMTools().find((tool) => tool.function.name === SYSTEM_SEARCH_TOOLS_NAME);
    expect(search?.function.description).not.toContain("Deferred tools you can load");
  });

  test("load through system.searchTools and are named in its description", async () => {
    const tools = registry(true);
    expect(advertised(tools)).not.toEqual(expect.arrayContaining(["VerifyPlanExecution"]));
    expect(advertised(tools)).not.toContain("SendUserMessage");
    expect(advertised(tools)).not.toContain("ImagineImage");
    expect(advertised(tools)).toContain("exec_command");
    const search = tools.toLLMTools().find((tool) => tool.function.name === SYSTEM_SEARCH_TOOLS_NAME);
    expect(search?.function.description).toContain(
      "Deferred tools you can load with select: TodoWrite (a plan for long work), Orient (rank files for a question in a large repository), AskUserQuestion (multiple-choice question to the user), EnterPlanMode (plan a large change first), ExitPlanMode (present a plan for approval), ImagineImage (generate or edit images), VerifyPlanExecution (check progress against a plan), SendUserMessage (progress note to the user).",
    );
    expect(search?.function.description).toContain(
      "To hand a self-contained task to a helper agent, load spawn_agent with select:spawn_agent; it loads wait_agent, send_message, assign_task, close_agent, list_agents with it.",
    );
    // The process tools load by themselves; exec_command's own description names them.
    expect(search?.function.description).not.toContain("write_stdin");
    const exec = tools.toLLMTools().find((tool) => tool.function.name === "exec_command");
    expect(exec?.function.description).toContain("Yielded session_id exposes write_stdin; kill_process stops it.");
    for (const name of ["spawn_agent", ...DELEGATION_COMPANION_TOOLS, ...PROCESS_SESSION_TOOLS]) {
      expect(advertised(tools)).not.toContain(name);
    }
    expect(advertised(tools)).toContain("MultiEdit");
    // The question and plan-mode tools load on demand outside plan mode.
    for (const name of ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]) {
      expect(advertised(tools)).not.toContain(name);
    }
    // Tools that are not registered are not named.
    expect(search?.function.description).not.toContain("XSearch");

    const result = await tools.dispatch({
      id: "load-image",
      name: SYSTEM_SEARCH_TOOLS_NAME,
      arguments: JSON.stringify({ select: "ImagineImage" }),
    });
    expect((JSON.parse(result.content) as { loaded: string[] }).loaded).toEqual(["ImagineImage"]);
    expect(advertised(tools)).toContain("ImagineImage");
    // The description stays the same once a tool is loaded.
    const after = tools.toLLMTools().find((tool) => tool.function.name === SYSTEM_SEARCH_TOOLS_NAME);
    expect(after?.function.description).toBe(search?.function.description);
  });

  test("a session in plan mode sees AskUserQuestion and ExitPlanMode without a search", () => {
    let mode = "default";
    const tools = buildToolRegistry({
      workspaceRoot: "/tmp",
      requireAdmission: false,
      sandboxExecutionBroker: explicitDangerBroker,
      deferRareTools: true,
      getSession: () => ({ services: { permissionModeRegistry: { current: () => ({ mode }) } } }) as never,
    });
    expect(advertised(tools)).not.toContain("ExitPlanMode");
    expect(advertised(tools)).not.toContain("AskUserQuestion");
    mode = "plan";
    expect(advertised(tools)).toEqual(expect.arrayContaining(["ExitPlanMode", "AskUserQuestion"]));
    expect(advertised(tools)).not.toContain("EnterPlanMode");
    mode = "default";
    expect(advertised(tools)).not.toContain("ExitPlanMode");
  });

  test("ignore the daemon's process environment", () => {
    vi.stubEnv(DEFER_RARE_TOOLS_ENV, "1");
    try {
      expect(advertised(registry())).toEqual(expect.arrayContaining(["VerifyPlanExecution", "SendUserMessage", "ImagineImage"]));
    } finally {
      vi.unstubAllEnvs();
    }
    // Unset: on for standard sessions, off for Light; the switch decides both.
    expect(rareToolDeferralEnabled({})).toBe(true);
    expect(rareToolDeferralEnabled({}, { lightMode: true })).toBe(false);
    expect(rareToolDeferralEnabled({ [DEFER_RARE_TOOLS_ENV]: "0" })).toBe(false);
    expect(rareToolDeferralEnabled({ [DEFER_RARE_TOOLS_ENV]: "1" })).toBe(true);
    expect(rareToolDeferralEnabled({ [DEFER_RARE_TOOLS_ENV]: "1" }, { lightMode: true })).toBe(true);
  });
});

describe("delegation discovery in Light", () => {
  test.each([undefined, false, true])("loading spawn also exposes its wait and collection tools (deferral %s)", async (defer) => {
    const tools = registry(defer, true);
    expect(advertised(tools)).not.toContain("wait_agent");
    await tools.dispatch({ id: "load-light-spawn", name: SYSTEM_SEARCH_TOOLS_NAME, arguments: '{"select":"spawn_agent"}' });
    expect(advertised(tools)).toEqual(expect.arrayContaining(["spawn_agent", ...DELEGATION_COMPANION_TOOLS]));
  });

  test("companion loading respects disabled tools", async () => {
    const tools = buildToolRegistry({ workspaceRoot: "/tmp", requireAdmission: false,
      sandboxExecutionBroker: explicitDangerBroker, lightMode: true,
      extraTools: [fakeTool("spawn_agent"), ...DELEGATION_COMPANION_TOOLS.map(fakeTool)],
      toolsConfig: { disabled_tools: ["wait_agent"] },
    });
    await tools.dispatch({ id: "load-light-spawn", name: SYSTEM_SEARCH_TOOLS_NAME, arguments: '{"select":"spawn_agent"}' });
    expect(advertised(tools)).toContain("list_agents");
    expect(advertised(tools)).not.toContain("wait_agent");
  });
});

describe("standard deferral", () => {
  test("select:spawn_agent loads the delegation tools, appended after the initial tools in load order", async () => {
    const tools = registry(true);
    const before = advertised(tools);
    await tools.dispatch({
      id: "load-spawn",
      name: SYSTEM_SEARCH_TOOLS_NAME,
      arguments: JSON.stringify({ select: "spawn_agent" }),
    });
    const after = advertised(tools);
    // The tools the session started with keep their order; the loaded ones follow.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(["spawn_agent", ...DELEGATION_COMPANION_TOOLS]);
    await tools.dispatch({
      id: "load-image",
      name: SYSTEM_SEARCH_TOOLS_NAME,
      arguments: JSON.stringify({ select: "ImagineImage" }),
    });
    expect(advertised(tools).slice(0, after.length)).toEqual(after);
    expect(advertised(tools).at(-1)).toBe("ImagineImage");
  });

  test("names the deferred tools as fixed for the session", () => {
    const tools = registry(true);
    const deferred = tools.getDeferredToolNames?.() ?? new Set<string>();
    for (const name of ["spawn_agent", ...DELEGATION_COMPANION_TOOLS, ...PROCESS_SESSION_TOOLS, "ImagineImage"]) {
      expect(deferred.has(name), name).toBe(true);
    }
    expect(deferred.has("exec_command")).toBe(false);
    expect(registry(false).getDeferredToolNames?.().has("spawn_agent")).toBe(false);
  });

  test("Light keeps its own tool set and pointer", () => {
    const light = registry(true, true);
    const search = light.toLLMTools().find((tool) => tool.function.name === SYSTEM_SEARCH_TOOLS_NAME);
    expect(search?.function.description).not.toContain("spawn_agent");
    expect(search?.function.description).not.toContain("load by themselves");
  });

  test("a policy without system.searchTools keeps every tool advertised", () => {
    const tools = buildToolRegistry({
      workspaceRoot: "/tmp",
      requireAdmission: false,
      sandboxExecutionBroker: explicitDangerBroker,
      extraTools: [fakeTool("spawn_agent"), ...DELEGATION_COMPANION_TOOLS.map(fakeTool)],
      deferRareTools: true,
      toolsConfig: { disabled_tools: [SYSTEM_SEARCH_TOOLS_NAME] },
    });
    const names = advertised(tools);
    expect(names).not.toContain(SYSTEM_SEARCH_TOOLS_NAME);
    expect(names).toEqual(expect.arrayContaining(["spawn_agent", "wait_agent", "write_stdin"]));
  });
});

describe("the session switch reaches a session's tools", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("through the captured session environment", async () => {
    // runWithStartupProviderSelection captures the environment through the
    // daemon client allowlist, as a daemon-owned (Desktop) session does; the
    // bootstrap registry reads the switch from that environment.
    root = await mkdtemp(join(tmpdir(), "agenc-defer-rare-tools-"));
    const toolsWith = (environment: Record<string, string>) =>
      runWithStartupProviderSelection(
        { provider: "deepseek", model: "deepseek-flash", environment },
        async () => {
          const tools = buildBootstrapToolRegistry({
            workspaceRoot: root,
            agencHome: join(root, "home"),
            environment: getSelectedProviderEnvironment(),
            mcpManager: {
              getTools: () => [],
              effectiveServers: async () => new Map(),
              toolPluginProvenance: async () => null,
            } as never,
            csvAgentJobsRepositories: {
              async withRepository(): Promise<never> {
                throw new Error("CSV repositories are not used by this test");
              },
            },
            getSession: () => null,
            emitWarning: () => {},
          });
          const llmTools = tools.toLLMTools();
          return {
            advertised: llmTools.map((tool) => tool.function.name),
            searchDescription: llmTools.find((tool) => tool.function.name === SYSTEM_SEARCH_TOOLS_NAME)
              ?.function.description ?? "",
          };
        },
      );

    // The rare tools this session advertises with the switch off (the image
    // and video tools, for example, are unavailable without an xAI key).
    const off = await toolsWith({ [DEFER_RARE_TOOLS_ENV]: "0" });
    const rare = RARE_DEFERRED_TOOLS.map(([name]) => name).filter((name) => off.advertised.includes(name));
    expect(rare.length).toBeGreaterThan(0);
    expect(off.advertised).toEqual(expect.arrayContaining(["spawn_agent", "wait_agent", "write_stdin"]));
    expect(off.searchDescription).not.toContain("Deferred tools you can load");

    // Unset is on for a standard session.
    const deferred = await toolsWith({});
    for (const name of [...rare, "spawn_agent", "wait_agent", "write_stdin", "kill_process"]) {
      expect(deferred.advertised).not.toContain(name);
    }
    expect(deferred.searchDescription).toContain("Deferred tools you can load with select:");
    for (const name of [...rare, "spawn_agent"]) expect(deferred.searchDescription).toContain(name);
  });
});
