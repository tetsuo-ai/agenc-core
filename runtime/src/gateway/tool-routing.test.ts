import { describe, expect, it } from "vitest";

import { buildStaticToolRoutingDecision } from "./tool-routing.js";

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
        "system.applyPatch",
        "system.searchTools",
        "playwright.browser_navigate",
        "playwright.browser_click",
      ],
      shellProfile: "coding",
    });

    expect(decision?.routedToolNames).toEqual([
      "system.readFile",
      "system.applyPatch",
      "system.searchTools",
    ]);
    expect(decision?.expandedToolNames).toEqual([
      "system.readFile",
      "system.applyPatch",
      "system.searchTools",
      "playwright.browser_navigate",
      "playwright.browser_click",
    ]);
    expect(decision?.diagnostics.clusterKey).toBe("shell-profile:coding:expanded");
  });
});
