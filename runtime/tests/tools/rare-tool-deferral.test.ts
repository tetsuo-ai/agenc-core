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

function registry(deferRareTools?: boolean) {
  return buildToolRegistry({
    workspaceRoot: "/tmp",
    requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    extraTools: [fakeTool("VerifyPlanExecution"), fakeTool("SendUserMessage"), fakeTool("ImagineImage")],
    ...(deferRareTools !== undefined ? { deferRareTools } : {}),
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
      "Deferred tools you can load with select: ImagineImage (generate or edit images), VerifyPlanExecution (compare progress with an approved plan), SendUserMessage (send the user a progress note).",
    );
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

  test("ignore the daemon's process environment", () => {
    vi.stubEnv(DEFER_RARE_TOOLS_ENV, "1");
    try {
      expect(advertised(registry())).toEqual(expect.arrayContaining(["VerifyPlanExecution", "SendUserMessage", "ImagineImage"]));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(rareToolDeferralEnabled({})).toBe(false);
    expect(rareToolDeferralEnabled({ [DEFER_RARE_TOOLS_ENV]: "1" })).toBe(true);
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

    // The rare tools this session advertises without the switch (the image
    // and video tools, for example, are unavailable without an xAI key).
    const standard = await toolsWith({});
    const rare = RARE_DEFERRED_TOOLS.map(([name]) => name).filter((name) => standard.advertised.includes(name));
    expect(rare.length).toBeGreaterThan(0);
    expect(standard.searchDescription).not.toContain("Deferred tools you can load");

    const deferred = await toolsWith({ [DEFER_RARE_TOOLS_ENV]: "1" });
    for (const name of rare) expect(deferred.advertised).not.toContain(name);
    expect(deferred.searchDescription).toContain("Deferred tools you can load with select:");
    for (const name of rare) expect(deferred.searchDescription).toContain(name);
  });
});
