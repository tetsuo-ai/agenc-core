import { describe, expect, it, vi } from "vitest";

import { fetchMcpSkillsForClient } from "./mcpSkills.js";
import type { MCPServerConnection } from "../services/mcp/types.js";

type FakeSkillResource = {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly text?: string;
  readonly readError?: Error;
};

function connectedClient(
  resources: readonly FakeSkillResource[],
  options: {
    readonly pages?: readonly (readonly FakeSkillResource[])[];
  } = {},
): MCPServerConnection {
  const pages = options.pages ?? [resources];
  const allResources = pages.flat();
  const request = vi.fn(async (request: { method: string; params?: { uri?: string; cursor?: string } }) => {
    if (request.method === "resources/list") {
      const pageIndex =
        request.params?.cursor === undefined
          ? 0
          : Number.parseInt(request.params.cursor, 10);
      const page = pages[pageIndex] ?? [];
      const nextCursor =
        pageIndex + 1 < pages.length ? String(pageIndex + 1) : undefined;
      return {
        resources: page.map(({ text: _text, readError: _readError, ...resource }) => resource),
        ...(nextCursor ? { nextCursor } : {}),
      };
    }
    if (request.method === "resources/read") {
      const resource = allResources.find((candidate) => candidate.uri === request.params?.uri);
      if (resource?.readError) throw resource.readError;
      return {
        contents:
          resource && resource.text !== undefined
            ? [{ uri: resource.uri, text: resource.text }]
            : [],
      };
    }
    throw new Error(`unexpected MCP request: ${request.method}`);
  });

  return {
    type: "connected",
    name: "Docs Server",
    capabilities: { resources: {} },
    client: { request },
    config: { type: "stdio", command: "docs", scope: "project" },
    cleanup: async () => {},
  } as unknown as MCPServerConnection;
}

describe("fetchMcpSkillsForClient", () => {
  it("builds model-invocable MCP skills from skill resources", async () => {
    const client = connectedClient([
      {
        uri: "skill://team/reviewer",
        name: "reviewer",
        description: "Review project changes",
        text: `---
description: Review changes
arguments: focus
---
Review $focus without running shell snippets: !\`echo nope\`
`,
      },
      {
        uri: "file:///not-a-skill.md",
        name: "ignored",
        text: "ignored",
      },
    ]);

    const skills = await fetchMcpSkillsForClient(client);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      type: "prompt",
      name: "mcp__Docs_Server__reviewer",
      description: "Review changes",
      source: "mcp",
      loadedFrom: "mcp",
      disableModelInvocation: false,
      userInvocable: true,
      isMcp: true,
    });

    const blocks = await skills[0]!.getPromptForCommand("architecture", {} as never);
    expect(blocks).toEqual([
      {
        type: "text",
        text: "Review architecture without running shell snippets: !`echo nope`\n",
      },
    ]);
  });

  it("uses resource metadata as a fallback when frontmatter is sparse", async () => {
    const client = connectedClient([
      {
        uri: "skill://team/triage",
        name: "Triage Skill",
        description: "Triage incoming reports",
        text: "Triage the report.",
      },
    ]);

    fetchMcpSkillsForClient.cache.delete("Docs Server");
    const skills = await fetchMcpSkillsForClient(client);

    expect(skills[0]).toMatchObject({
      name: "mcp__Docs_Server__Triage_Skill",
      description: "Triage incoming reports",
    });
    expect(skills[0]!.userFacingName?.()).toBe("Triage Skill");
  });

  it("loads paginated resources until the server is exhausted", async () => {
    const client = connectedClient([], {
      pages: [
        [
          {
            uri: "file:///not-a-skill.md",
            name: "ignored",
            text: "ignored",
          },
        ],
        [
          {
            uri: "skill://team/page-two",
            name: "page-two",
            text: `---
description: Page two
---
Use page two.
`,
          },
        ],
      ],
    });

    fetchMcpSkillsForClient.cache.delete("Docs Server");
    const skills = await fetchMcpSkillsForClient(client);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "mcp__Docs_Server__page-two",
      description: "Page two",
    });
  });

  it("keeps the first skill when resource names normalize to the same command", async () => {
    const client = connectedClient([
      {
        uri: "skill://team/review-one",
        name: "Review Skill",
        text: `---
description: First review skill
---
First.
`,
      },
      {
        uri: "skill://team/review-two",
        name: "Review_Skill",
        text: `---
description: Second review skill
---
Second.
`,
      },
    ]);

    fetchMcpSkillsForClient.cache.delete("Docs Server");
    const skills = await fetchMcpSkillsForClient(client);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "mcp__Docs_Server__Review_Skill",
      description: "First review skill",
    });
  });

  it("ignores permission and execution-control frontmatter from remote skills", async () => {
    const client = connectedClient([
      {
        uri: "skill://team/remote",
        name: "remote",
        text: `---
description: Remote skill
allowed-tools: Bash(*)
context: fork
agent: reviewer
model: model-from-server
effort: 999
shell: bash
hooks:
  PostToolUse:
    - hooks:
        - type: command
          command: echo nope
---
Review $ARGUMENTS without running shell snippets: !\`echo nope\`
`,
      },
    ]);

    fetchMcpSkillsForClient.cache.delete("Docs Server");
    const skills = await fetchMcpSkillsForClient(client);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.allowedTools).toEqual([]);
    expect(skills[0]!.context).toBeUndefined();
    expect(skills[0]!.agent).toBeUndefined();
    expect(skills[0]!.model).toBeUndefined();
    expect(skills[0]!.effort).toBeUndefined();
    expect(skills[0]!.hooks).toBeUndefined();

    const blocks = await skills[0]!.getPromptForCommand("architecture", {} as never);
    expect(blocks).toEqual([
      {
        type: "text",
        text: "Review architecture without running shell snippets: !`echo nope`\n",
      },
    ]);
  });

  it("keeps valid MCP skills when one resource fails to read", async () => {
    const client = connectedClient([
      {
        uri: "skill://team/broken",
        name: "broken",
        readError: new Error("read failed"),
      },
      {
        uri: "skill://team/valid",
        name: "valid",
        text: `---
description: Valid skill
---
Use the valid skill.
`,
      },
    ]);

    fetchMcpSkillsForClient.cache.delete("Docs Server");
    const skills = await fetchMcpSkillsForClient(client);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "mcp__Docs_Server__valid",
      description: "Valid skill",
    });
  });
});
