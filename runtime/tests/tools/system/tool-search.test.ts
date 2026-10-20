import { describe, expect, test } from "vitest";
import type { ToolCatalogEntry } from "../types.js";
import { encodeMcpToolNameForWire } from "../../llm/wire/mcp-tool-naming.js";
import { catalogSummary, createToolSearchTool } from "./tool-search.js";
import { SESSION_ADVERTISED_TOOL_NAMES_ARG, SESSION_TOOL_CATALOG_SCOPE_ARG } from "./coding-common.js";

function deferredCatalogEntry(name = "system.deepTool"): ToolCatalogEntry {
  return {
    name,
    description: "Deferred deep inspection tool",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    metadata: {
      family: name.startsWith("mcp.") ? "mcp" : "coding",
      source: name.startsWith("mcp.") ? "mcp" : "builtin",
      hiddenByDefault: false,
      mutating: false,
      deferred: true,
      keywords: ["deep", "inspect"],
      preferredProfiles: ["coding"],
    },
  };
}

describe("system.searchTools", () => {
  const searchEntry = (name: string, description: string): ToolCatalogEntry => ({
    ...deferredCatalogEntry(name), description,
    metadata: { ...deferredCatalogEntry(name).metadata, keywords: [] },
  });
  const searchCatalog = [
    searchEntry("WebSearch", "Search the web for current information and sources."),
    searchEntry("web_fetch", "Fetch a web page from a URL."),
    searchEntry("ReadFile", "Read a file from disk."),
    searchEntry("Skill", "Load a skill and its instructions."),
    searchEntry("mcp.inventory.lookup_stock", "Retrieve inventory count and warehouse for a part."),
  ];
  function searchFixture(catalog = searchCatalog) {
    return createToolSearchTool({ allowedPaths: [process.cwd()], persistenceRootDir: process.cwd(),
      getToolCatalog: () => catalog, onDiscoverTools: () => {} });
  }

  test("ranks partial matches for a combined web search and fetch query", async () => {
    const payload = JSON.parse((await searchFixture().execute({ query: "web search fetch url" })).content);
    expect(payload.results.slice(0, 2).map((entry: { name: string }) => entry.name)).toEqual(["web_fetch", "WebSearch"]);
    expect(payload.loaded).toEqual([]);
    expect(payload.results.every((entry: { selected: boolean }) => !entry.selected)).toBe(true);
  });

  test.each([
    ["internet lookup", "WebSearch"],
    ["download webpage", "web_fetch"],
    ["read_file", "ReadFile"],
    ["skills instructions", "Skill"],
    ["inventory stock warehouse unavailableword", "mcp.inventory.lookup_stock"],
  ])("finds %s using names, descriptions and related terms", async (query, name) => {
    const payload = JSON.parse((await searchFixture().execute({ query })).content);
    expect(payload.results[0]?.name).toBe(name);
  });

  test("prefers exact identities and full coverage, then limits searches to the best five", async () => {
    const catalog = [searchEntry("lookup", "Inspect something"),
      searchEntry("lookup_stock", "Inventory warehouse"),
      ...Array.from({ length: 20 }, (_, i) => searchEntry(`misc.${i}`, "lookup unrelated"))];
    const tool = searchFixture(catalog);
    const payload = JSON.parse((await tool.execute({ query: "lookup" })).content);
    expect(payload.results).toHaveLength(5);
    expect(payload.results[0].name).toBe("lookup");
    const full = JSON.parse((await tool.execute({ query: "inventory warehouse" })).content);
    expect(full.results[0].name).toBe("lookup_stock");
    expect(JSON.parse((await tool.execute({ query: "lookup", maxResults: 12 })).content).results).toHaveLength(5);
    expect(JSON.parse((await tool.execute({ query: "lookup", maxResults: 2 })).content).results).toHaveLength(2);
    expect(JSON.parse((await tool.execute({ maxResults: 12 })).content).results).toHaveLength(12);
    expect(JSON.parse((await tool.execute({})).content).results).toHaveLength(22);
    expect(JSON.parse((await tool.execute({ query: "unmatchablezzzz" })).content).results).toEqual([]);
  });

  test("partial matching respects catalog scope, hidden and exact family/source/profile filters", async () => {
    const hidden = { ...searchCatalog[0]!, metadata: { ...searchCatalog[0]!.metadata, hiddenByDefault: true } };
    const tool = searchFixture([hidden, ...searchCatalog.slice(1)]);
    for (const filter of [
      { [SESSION_TOOL_CATALOG_SCOPE_ARG]: ["Skill"] }, { family: "absent" },
      { source: "absent" }, { profile: "absent" },
      { advertisedOnly: true, [SESSION_ADVERTISED_TOOL_NAMES_ARG]: ["Skill"] },
    ]) {
      const payload = JSON.parse((await tool.execute({ query: "web search missing", ...filter })).content);
      expect(payload.results).toEqual([]);
    }
    expect(JSON.parse((await tool.execute({ query: "web search missing" })).content).results
      .some((entry: { name: string }) => entry.name === "WebSearch")).toBe(false);
    expect(JSON.parse((await tool.execute({ query: "web search missing", includeHidden: true })).content).results
      .some((entry: { name: string }) => entry.name === "WebSearch")).toBe(true);
  });

  test("is side-effecting because selected tools update advertised session state", () => {
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry()],
      onDiscoverTools: () => {},
    });

    expect(tool.recoveryCategory).toBe("side-effecting");
  });

  test("selecting a deferred tool calls onDiscoverTools and reports it loaded", async () => {
    const discovered: string[][] = [];
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry()],
      onDiscoverTools: (names) => {
        discovered.push([...names]);
      },
    });

    const result = await tool.execute({ select: "system.deepTool" });

    expect(discovered).toEqual([["system.deepTool"]]);
    const payload = JSON.parse(result.content);
    expect(payload.loaded).toEqual(["system.deepTool"]);
    expect(payload.results[0]).toMatchObject({
      name: "system.deepTool",
      selected: true,
    });
  });

  test.each([
    { select: "mcp.qa-helper.lookup_marker" },
    { query: "select:mcp.qa-helper.lookup_marker" },
    { select: "mcp.qa-helper.lookup_marker", query: " ", maxResults: 1 },
  ])("select-only loading does not dump an unrelated 123-tool catalog (%j)", async args => {
    const selectedName = "mcp.qa-helper.lookup_marker";
    const catalog = [deferredCatalogEntry(selectedName), ...Array.from({ length: 122 }, (_, i) => ({
      ...deferredCatalogEntry(`unrelated.tool${i}`), description: "Unrelated schema documentation. ".repeat(30),
    }))];
    const discovered: string[][] = [];
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()], persistenceRootDir: process.cwd(), getToolCatalog: () => catalog,
      onDiscoverTools: names => discovered.push([...names]),
    });
    const result = await tool.execute({ ...args, [SESSION_ADVERTISED_TOOL_NAMES_ARG]: ["system.searchTools"] });
    const payload = JSON.parse(result.content);
    expect(payload.totalCatalogSize).toBe(123);
    expect(payload.loaded).toEqual([selectedName]);
    expect(payload.missingSelections).toEqual([]);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({ name: selectedName, advertised: false, selected: true });
    expect(payload.results[0].loadHint).toBeUndefined();
    expect(payload.results[0].useHint).toContain("mcp__qa-helper__lookup_marker");
    expect(discovered).toEqual([[selectedName]]);
    expect(result.content.length).toBeLessThan(2_000);
    expect(result.content).not.toContain("unrelated.tool");
  });

  test("deduplicates canonical selection aliases and reports missing identities without browsing", async () => {
    const name = "mcp.qa-helper.lookup_marker";
    const discovered: string[][] = [];
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()], persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry(name), deferredCatalogEntry("system.other")],
      onDiscoverTools: names => discovered.push([...names]),
    });
    const payload = JSON.parse((await tool.execute({
      select: [name, encodeMcpToolNameForWire(name), "qa-helper", "missing.exact"],
      [SESSION_ADVERTISED_TOOL_NAMES_ARG]: [name],
    })).content);
    expect(payload.loaded).toEqual([name]);
    expect(discovered).toEqual([[name]]);
    expect(payload.missingSelections).toEqual(["missing.exact"]);
    expect(payload.results.map((entry: { name: string }) => entry.name)).toEqual([name]);
    expect(payload.results[0]).toMatchObject({ advertised: true, selected: true });
    const missing = JSON.parse((await tool.execute({ select: "missing.exact" })).content);
    expect(missing.loaded).toEqual([]);
    expect(missing.missingSelections).toEqual(["missing.exact"]);
    expect(missing.results).toEqual([]);
  });

  test("empty requests still browse and maxResults does not hide explicitly loaded tools", async () => {
    const catalog = Array.from({ length: 70 }, (_, i) => deferredCatalogEntry(`system.tool${String(i).padStart(2, "0")}`));
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()], persistenceRootDir: process.cwd(), getToolCatalog: () => catalog,
      onDiscoverTools: () => {},
    });
    expect(JSON.parse((await tool.execute({})).content).results).toHaveLength(50);
    expect(JSON.parse((await tool.execute({ maxResults: 2 })).content).results).toHaveLength(2);
    const selected = JSON.parse((await tool.execute({ select: [catalog[0]!.name, catalog[1]!.name], maxResults: 1 })).content);
    expect(selected.loaded).toEqual([catalog[0]!.name, catalog[1]!.name]);
    expect(selected.results).toHaveLength(2);
  });

  test.each([
    { query: "browser" }, { family: "browser" }, { source: "plugin" }, { profile: "operator" },
    { includeHidden: true }, { advertisedOnly: true },
  ])("selection with an explicit search/filter preserves matching behavior (%j)", async filter => {
    const selected = deferredCatalogEntry("system.selected");
    const other = { ...deferredCatalogEntry("browser.inspect"), metadata: {
      ...deferredCatalogEntry().metadata, family: "browser", source: "plugin", preferredProfiles: ["operator"],
    } };
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()], persistenceRootDir: process.cwd(), getToolCatalog: () => [selected, other],
      onDiscoverTools: () => {},
    });
    const payload = JSON.parse((await tool.execute({ select: selected.name, ...filter,
      [SESSION_ADVERTISED_TOOL_NAMES_ARG]: [other.name],
    })).content);
    expect(payload.loaded).toEqual([selected.name]);
    expect(payload.results.map((entry: { name: string }) => entry.name)).toEqual([selected.name, other.name]);
    expect(payload.results[1]).toMatchObject({ advertised: true, selected: false });
  });

  test("MCP search results tell the model to use the encoded provider function", async () => {
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry("mcp.audit-ping.ping")],
      onDiscoverTools: () => {},
    });

    const result = await tool.execute({ select: "mcp.audit-ping.ping" });

    const payload = JSON.parse(result.content);
    expect(payload.results[0]).toMatchObject({
      name: "mcp.audit-ping.ping",
      selected: true,
      useHint: expect.stringContaining("mcp__audit-ping__ping"),
    });
    expect(payload.results[0].useHint).toContain("maps it to mcp.audit-ping.ping");
    expect(payload.results[0].useHint).toContain("Do not use exec_command");
    expect(payload.results[0].useHint).toContain("echo");
    expect(payload.results[0].useHint).toContain("Skill");
  });

  test("a search match does not claim a deferred MCP function is already callable", async () => {
    const discovered: string[][] = [];
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()], persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry("mcp.qa-helper.lookup_marker")],
      onDiscoverTools: names => discovered.push([...names]),
    });
    const searched = JSON.parse((await tool.execute({query:"qa-helper"})).content);
    expect(searched.loaded).toEqual([]);
    expect(discovered).toEqual([]);
    expect(searched.results[0]).toMatchObject({advertised:false,selected:false});
    expect(searched.results[0].useHint).toContain("not loaded yet");
    expect(searched.results[0].useHint).toContain('{"select":"mcp.qa-helper.lookup_marker"}');
    expect(searched.results[0].useHint).not.toContain("now available");
    const loaded = JSON.parse((await tool.execute({select:"mcp.qa-helper.lookup_marker"})).content);
    expect(loaded.results[0].useHint).toContain("now available");
    expect(loaded.results[0].loadHint).toBeUndefined();
    expect(discovered).toEqual([["mcp.qa-helper.lookup_marker"]]);
  });

  test("resolves a long hashed MCP selection through the live catalog", async () => {
    const canonicalName =
      `mcp.plugin:${"shared-segment-".repeat(5)}alpha.fetch_record`;
    const wireName = encodeMcpToolNameForWire(canonicalName);
    const discovered: string[][] = [];
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry(canonicalName)],
      onDiscoverTools: (names) => {
        discovered.push([...names]);
      },
    });

    const result = await tool.execute({ select: wireName });

    expect(wireName).toMatch(/^toolh__/);
    expect(discovered).toEqual([[canonicalName]]);
    const payload = JSON.parse(result.content);
    expect(payload.missingSelections).toEqual([]);
    expect(payload.loaded).toEqual([canonicalName]);
  });

  test("selecting a server name loads its single matching MCP tool", async () => {
    const discovered: string[][] = [];
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry("mcp.game-helper.game_tip")],
      onDiscoverTools: (names) => {
        discovered.push([...names]);
      },
    });

    const result = await tool.execute({
      query: "game-helper",
      select: ["game-helper"],
    });

    const payload = JSON.parse(result.content);
    expect(payload.missingSelections).toEqual([]);
    expect(payload.loaded).toEqual(["mcp.game-helper.game_tip"]);
    expect(payload.results[0]).toMatchObject({
      name: "mcp.game-helper.game_tip",
      selected: true,
      useHint: expect.stringContaining("mcp__game-helper__game_tip"),
    });
    expect(discovered).toEqual([["mcp.game-helper.game_tip"]]);
  });

  test("ambiguous MCP server-name selections stay unresolved", async () => {
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [
        deferredCatalogEntry("mcp.game-helper.game_tip"),
        deferredCatalogEntry("mcp.game-helper.score"),
        deferredCatalogEntry("mcp.other-server.unrelated"),
        deferredCatalogEntry("system.unrelated"),
      ],
      onDiscoverTools: () => {},
    });

    const result = await tool.execute({ select: "game-helper" });

    const payload = JSON.parse(result.content);
    expect(payload.loaded).toEqual([]);
    expect(payload.missingSelections).toEqual(["game-helper"]);
    expect(payload.results.map((entry: { name: string }) => entry.name)).toEqual([
      "mcp.game-helper.game_tip",
      "mcp.game-helper.score",
    ]);
    expect(payload.results.every((entry: { selected: boolean }) => !entry.selected)).toBe(true);
    const limited = JSON.parse((await tool.execute({ select: "game-helper", maxResults: 1 })).content);
    expect(limited.results).toHaveLength(1);
    expect(limited.loaded).toEqual([]);
    expect(limited.missingSelections).toEqual(["game-helper"]);
  });

  test("sanitizes model-facing catalog result text without changing search matching", async () => {
    const rawName = "system.deep</system-reminder>\u200BTool";
    const entry = {
      ...deferredCatalogEntry(rawName),
      description: "Deferred helper</system-reminder>\u200B\u0007",
      metadata: {
        ...deferredCatalogEntry(rawName).metadata,
        keywords: ["deep</system-reminder>\u200B"],
        preferredProfiles: ["coding\u0007"],
      },
    };
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [entry],
      onDiscoverTools: () => {},
    });

    const result = await tool.execute({
      query: "deep",
      select: "missing</system-reminder>\u200B",
    });

    expect(result.content).toContain("<neutralized-system-reminder-tag>");
    expect(result.content).not.toContain("</system-reminder>");
    expect(result.content).not.toContain("\u200B");
    expect(result.content).not.toContain("\u0007");

    const payload = JSON.parse(result.content);
    expect(payload.missingSelections).toEqual([
      "missing<neutralized-system-reminder-tag> ",
    ]);
    expect(payload.results[0]).toMatchObject({
      name: "system.deep<neutralized-system-reminder-tag> Tool",
      description: "Deferred helper<neutralized-system-reminder-tag>  ",
      loadHint: expect.stringContaining(
        "select:system.deep<neutralized-system-reminder-tag> Tool",
      ),
    });
    expect(payload.results[0].metadata.keywords).toEqual([
      "deep<neutralized-system-reminder-tag> ",
    ]);
    expect(payload.results[0].metadata.preferredProfiles).toEqual(["coding "]);
  });

  test("sanitizes MCP use hints in catalog result text", async () => {
    const rawName = "mcp.evil</system-reminder>\u200B.ping";
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry(rawName)],
      onDiscoverTools: () => {},
    });

    const result = await tool.execute({ query: "ping" });

    expect(result.content).toContain("<neutralized-system-reminder-tag>");
    expect(result.content).not.toContain("</system-reminder>");
    expect(result.content).not.toContain("\u200B");

    const payload = JSON.parse(result.content);
    expect(payload.results[0].useHint).toContain(
      "maps it to mcp.evil<neutralized-system-reminder-tag> .ping",
    );
  });

  test("uses raw selected tool names internally while sanitizing loaded output", async () => {
    const rawName = "system.deep</system-reminder>\u200BTool";
    const discovered: string[][] = [];
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry(rawName)],
      onDiscoverTools: (names) => {
        discovered.push([...names]);
      },
    });

    const result = await tool.execute({ select: rawName });

    expect(discovered).toEqual([[rawName]]);
    expect(result.content).not.toContain("</system-reminder>");
    expect(result.content).not.toContain("\u200B");

    const payload = JSON.parse(result.content);
    expect(payload.loaded).toEqual([
      "system.deep<neutralized-system-reminder-tag> Tool",
    ]);
    expect(payload.results[0]).toMatchObject({
      name: "system.deep<neutralized-system-reminder-tag> Tool",
      selected: true,
    });
  });
});

describe("system.searchTools compact results (Light)", () => {
  const long = "Spawns an agent to work on the specified task.\n\nNOTE ON AGENT-PATH NAMES: `/root`-prefixed names below refer to the internal AGENT-TREE NAMESPACE. " + "Long contract text. ".repeat(80);
  const entry = (name: string, description: string, deferred = true): ToolCatalogEntry => ({
    ...deferredCatalogEntry(name), description,
    metadata: { ...deferredCatalogEntry(name).metadata, deferred, keywords: ["agent", "spawn"] },
  });
  const catalog = [
    entry("spawn_agent", long),
    entry("TaskCreate", "Create a durable AgenC task on the project task board. New tasks start pending and unowned; assign AgenC agents with TaskUpdate owner."),
    entry("FileRead", "FileRead first. A whole-file read authorizes edits; Edit and Write fail if their change did not land.", false),
    entry("mcp.agent-hub.spawn", "Spawn a remote agent."),
  ];
  function compact(onDiscoverTools: (names: readonly string[]) => void = () => {}) {
    return createToolSearchTool({ allowedPaths: [process.cwd()], persistenceRootDir: process.cwd(),
      getToolCatalog: () => catalog, onDiscoverTools, compactResults: true });
  }

  test("a query returns names and short summaries without catalog metadata", async () => {
    const result = await compact().execute({ query: "spawn agent task",
      [SESSION_ADVERTISED_TOOL_NAMES_ARG]: ["FileRead", "system.searchTools"] });
    const payload = JSON.parse(result.content);
    const spawn = payload.results.find((item: { name: string }) => item.name === "spawn_agent");
    expect(spawn).toEqual({ name: "spawn_agent", description: "Spawns an agent to work on the specified task." });
    expect(payload.hint).toContain("select:<name>");
    expect(payload).not.toHaveProperty("totalCatalogSize");
    expect(payload).not.toHaveProperty("loaded");
    expect(result.content).not.toContain("metadata");
    expect(result.content).not.toContain("loadHint");
    expect(result.content).not.toContain("Long contract text");
    // The same search with full results is several times larger.
    const full = await createToolSearchTool({ allowedPaths: [process.cwd()], persistenceRootDir: process.cwd(),
      getToolCatalog: () => catalog, onDiscoverTools: () => {} }).execute({ query: "spawn agent task",
      [SESSION_ADVERTISED_TOOL_NAMES_ARG]: ["FileRead", "system.searchTools"] });
    expect(result.content.length * 4).toBeLessThan(full.content.length);
  });

  test("listed and just-loaded tools return only their names, since their schemas carry the description", async () => {
    const discovered: string[][] = [];
    const payload = JSON.parse((await compact(names => discovered.push([...names])).execute({
      select: "TaskCreate", query: "read file", [SESSION_ADVERTISED_TOOL_NAMES_ARG]: ["FileRead"],
    })).content);
    expect(discovered).toEqual([["TaskCreate"]]);
    expect(payload.loaded).toEqual(["TaskCreate"]);
    expect(payload.results).toContainEqual({ name: "TaskCreate", loaded: true });
    expect(payload.results).toContainEqual({ name: "FileRead", listed: true });
    expect(payload).not.toHaveProperty("hint");
  });

  test("missing selections and MCP use hints survive the compact form", async () => {
    const payload = JSON.parse((await compact().execute({ select: ["nope", "mcp.agent-hub.spawn"] })).content);
    expect(payload.missingSelections).toEqual(["nope"]);
    expect(payload.results[0]).toMatchObject({ name: "mcp.agent-hub.spawn", loaded: true });
    expect(payload.results[0].useHint).toContain("mcp__agent-hub__spawn");
    const searched = JSON.parse((await compact().execute({ query: "agent-hub" })).content);
    const mcp = searched.results.find((item: { name: string }) => item.name === "mcp.agent-hub.spawn");
    expect(mcp.description).toBe("Spawn a remote agent.");
    expect(mcp.useHint).toContain("not loaded yet");
  });

  test("summaries keep at least one full sentence and stay short", () => {
    expect(catalogSummary("Short. Second sentence carries the rest of the meaning here. Third.")).toBe(
      "Short. Second sentence carries the rest of the meaning here.");
    expect(catalogSummary("No sentence end at all")).toBe("No sentence end at all");
    const summary = catalogSummary(`${"word ".repeat(60)}end.`);
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary.endsWith("...")).toBe(true);
    expect(catalogSummary("Line one\n\nwith   spaces.   Next.")).toBe("Line one with spaces. Next.");
  });
});
