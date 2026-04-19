import { describe, expect, it } from "vitest";

import {
  buildAdvertisedToolBundle,
  buildStaticToolRoutingDecision,
} from "./tool-routing.js";

const TOOLS = [
  "system.readFile",
  "agenc.inspectMarketplace",
  "agenc.listTasks",
  "agenc.listSkills",
  "agenc.listDisputes",
] as const;

describe("buildStaticToolRoutingDecision", () => {
  it.each([
    "Inspect the marketplace overview and summarize the available surfaces.",
    "Inspect the marketplace tasks surface.",
    "Inspect the marketplace skills surface.",
    "Inspect the marketplace governance surface.",
    "Inspect the marketplace disputes surface.",
    "Inspect the marketplace reputation surface.",
    "List marketplace tasks and summarize their counts.",
    "Show the top marketplace skills.",
  ])("routes marketplace surface prompt: %s", (content) => {
    const decision = buildStaticToolRoutingDecision({
      content,
      availableToolNames: TOOLS,
      shellProfile: "general",
    });

    expect(decision?.routedToolNames).toEqual(["agenc.inspectMarketplace"]);
    expect(decision?.expandedToolNames).toEqual(["agenc.inspectMarketplace"]);
    expect(decision?.diagnostics.clusterKey).toBe("marketplace-inspect");
  });

  it.each([
    "Create a marketplace task for transcribing this file.",
    "Claim marketplace task 123.",
    "Complete marketplace task 123 with proof.",
    "Purchase marketplace skill abc.",
    "Rate marketplace skill abc with five stars.",
    "Resolve marketplace dispute def.",
    "Build a local TypeScript workspace with packages/core and packages/web.",
  ])("does not route mutation or non-marketplace prompt: %s", (content) => {
    expect(
      buildStaticToolRoutingDecision({
        content,
        availableToolNames: TOOLS,
        shellProfile: "general",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when inspectMarketplace is unavailable", () => {
    expect(
      buildStaticToolRoutingDecision({
        content: "Inspect the marketplace overview.",
        availableToolNames: ["agenc.listTasks", "agenc.listSkills"],
        shellProfile: "general",
      }),
    ).toBeUndefined();
  });

  it("biases default routing toward coding tools for coding sessions", () => {
    const decision = buildStaticToolRoutingDecision({
      content: "Refactor the local TypeScript workspace and run a verification step.",
      availableToolNames: [
        "system.readFile",
        "system.writeFile",
        "system.bash",
        "agenc.inspectMarketplace",
      ],
      shellProfile: "coding",
    });

    expect(decision?.diagnostics.clusterKey).toBe("shell-profile:coding");
    expect(decision?.routedToolNames).toEqual([
      "system.readFile",
      "system.writeFile",
      "system.bash",
    ]);
    expect(decision?.expandedToolNames).toEqual([
      "system.readFile",
      "system.writeFile",
      "system.bash",
    ]);
  });

  it("expands the coding bundle for mixed-mode browser turns", () => {
    const decision = buildStaticToolRoutingDecision({
      content: "Open the website in a browser, click through the flow, and then patch the local repo.",
      availableToolNames: [
        "system.readFile",
        "system.editFile",
        "system.searchTools",
        "playwright.browser_navigate",
        "playwright.browser_click",
      ],
      shellProfile: "coding",
    });

    expect(decision?.routedToolNames).toEqual([
      "system.readFile",
      "system.editFile",
      "system.searchTools",
    ]);
    expect(decision?.expandedToolNames).toEqual([
      "system.readFile",
      "system.editFile",
      "system.searchTools",
      "playwright.browser_navigate",
      "playwright.browser_click",
    ]);
    expect(decision?.diagnostics.clusterKey).toBe("shell-profile:coding:expanded");
  });
});

describe("buildAdvertisedToolBundle", () => {
  it("keeps deferred specialist tools out of the default general bundle", () => {
    const toolNames = buildAdvertisedToolBundle({
      shellProfile: "general",
      toolCatalog: [
        {
          name: "system.readFile",
          description: "Read files",
          inputSchema: {},
          metadata: {
            family: "filesystem",
            source: "builtin",
            hiddenByDefault: false,
            mutating: false,
          },
        },
        {
          name: "system.searchTools",
          description: "Discover tools",
          inputSchema: {},
          metadata: {
            family: "meta",
            source: "builtin",
            hiddenByDefault: false,
            mutating: false,
          },
        },
        {
          name: "mcp.remote.inspect",
          description: "Inspect remote MCP state",
          inputSchema: {},
          metadata: {
            family: "remote",
            source: "mcp",
            hiddenByDefault: false,
            mutating: false,
          },
        },
        {
          name: "system.remoteSession.start",
          description: "Start a remote session",
          inputSchema: {},
          metadata: {
            family: "remote",
            source: "builtin",
            hiddenByDefault: false,
            mutating: true,
          },
        },
      ],
    });

    expect(toolNames).toEqual([
      "system.readFile",
      "system.searchTools",
    ]);
  });

  it("re-advertises discovered deferred tools on later turns", () => {
    const toolNames = buildAdvertisedToolBundle({
      shellProfile: "general",
      discoveredToolNames: ["mcp.remote.inspect"],
      toolCatalog: [
        {
          name: "system.searchTools",
          description: "Discover tools",
          inputSchema: {},
          metadata: {
            family: "meta",
            source: "builtin",
            hiddenByDefault: false,
            mutating: false,
          },
        },
        {
          name: "mcp.remote.inspect",
          description: "Inspect remote MCP state",
          inputSchema: {},
          metadata: {
            family: "remote",
            source: "mcp",
            hiddenByDefault: false,
            mutating: false,
          },
        },
      ],
    });

    expect(toolNames).toEqual([
      "system.searchTools",
      "mcp.remote.inspect",
    ]);
  });
});

// ============================================================================
// Plan-mode tool filtering
// ============================================================================

describe("buildAdvertisedToolBundle — plan-mode filter", () => {
  function catalogEntry(
    name: string,
    overrides: Partial<{
      readonly family: string;
      readonly source: "builtin" | "mcp" | "plugin" | "skill" | "provider_native";
      readonly hiddenByDefault: boolean;
      readonly mutating: boolean;
      readonly deferred: boolean;
    }> = {},
  ) {
    return {
      name,
      description: "",
      inputSchema: {},
      metadata: {
        family: overrides.family ?? "general",
        source: overrides.source ?? ("builtin" as const),
        hiddenByDefault: overrides.hiddenByDefault ?? false,
        mutating: overrides.mutating ?? false,
        deferred: overrides.deferred ?? false,
      },
    };
  }

  const baseCatalog = [
    catalogEntry("system.readFile"),
    catalogEntry("system.grep"),
    catalogEntry("system.listDir"),
    catalogEntry("system.writeFile", { mutating: true }),
    catalogEntry("system.editFile", { mutating: true }),
    catalogEntry("system.bash", { mutating: true }),
    catalogEntry("system.delete", { mutating: true }),
    catalogEntry("system.searchTools"),
    catalogEntry("workflow.enterPlan"),
    catalogEntry("workflow.exitPlan"),
    catalogEntry("task.create", { mutating: true }),
    catalogEntry("task.list"),
  ];

  it("hides mutating tools when stage is 'plan'", () => {
    const toolNames = buildAdvertisedToolBundle({
      shellProfile: "general",
      toolCatalog: baseCatalog,
      workflowStage: "plan",
    });
    // Mutating tools are dropped except the plan-mode allow-list
    // (workflow.exitPlan + task.wait/task.output + TodoWrite stay
    // so the model can finalize a plan, draft a todo list, and pick
    // up delegated subagent results).
    expect(toolNames).toContain("system.readFile");
    expect(toolNames).toContain("system.grep");
    expect(toolNames).toContain("system.listDir");
    expect(toolNames).toContain("system.searchTools");
    expect(toolNames).toContain("workflow.enterPlan");
    expect(toolNames).toContain("workflow.exitPlan");
    // Write-surface task tools are no longer model-advertised under
    // the Phase 5 mutex gate. TodoWrite is the model-facing planning
    // affordance; task.* is runtime-internal except for the
    // read-only wait/output handles.
    expect(toolNames).not.toContain("task.create");
    expect(toolNames).not.toContain("task.list");
    expect(toolNames).not.toContain("task.get");
    expect(toolNames).not.toContain("task.update");
    expect(toolNames).not.toContain("system.writeFile");
    expect(toolNames).not.toContain("system.editFile");
    expect(toolNames).not.toContain("system.bash");
    expect(toolNames).not.toContain("system.delete");
  });

  it("leaves mutating tools in when stage is 'implement'", () => {
    const toolNames = buildAdvertisedToolBundle({
      shellProfile: "general",
      toolCatalog: baseCatalog,
      workflowStage: "implement",
    });
    expect(toolNames).toContain("system.writeFile");
    expect(toolNames).toContain("system.editFile");
    expect(toolNames).toContain("system.bash");
    expect(toolNames).toContain("system.delete");
  });

  it("leaves mutating tools in when workflowStage is omitted", () => {
    const toolNames = buildAdvertisedToolBundle({
      shellProfile: "general",
      toolCatalog: baseCatalog,
    });
    expect(toolNames).toContain("system.writeFile");
    expect(toolNames).toContain("system.bash");
  });

  it("respects explicit metadata.deferred on catalog entries", () => {
    const toolNames = buildAdvertisedToolBundle({
      shellProfile: "general",
      toolCatalog: [
        catalogEntry("system.readFile"),
        catalogEntry("system.searchTools"),
        catalogEntry("agenc.resolveDispute", { deferred: true, mutating: true }),
        catalogEntry("agenc.stakeReputation", { deferred: true, mutating: true }),
      ],
    });
    // Explicit `deferred: true` keeps those tools out of the default
    // advertised set even though they aren't MCP-sourced or covered by
    // the name-prefix heuristics.
    expect(toolNames).toContain("system.readFile");
    expect(toolNames).toContain("system.searchTools");
    expect(toolNames).not.toContain("agenc.resolveDispute");
    expect(toolNames).not.toContain("agenc.stakeReputation");
  });

  it("keeps the plan-mode allow-list tools present even in plan mode", () => {
    const planCatalog = [
      ...baseCatalog,
      catalogEntry("TodoWrite"),
      catalogEntry("execute_with_agent"),
    ];
    const toolNames = buildAdvertisedToolBundle({
      shellProfile: "general",
      toolCatalog: planCatalog,
      workflowStage: "plan",
    });
    for (const essential of [
      "workflow.enterPlan",
      "workflow.exitPlan",
      "TodoWrite",
      "execute_with_agent",
      "system.searchTools",
    ]) {
      expect(toolNames).toContain(essential);
    }
  });
});
