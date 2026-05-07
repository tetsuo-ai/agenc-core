import { describe, expect, it, vi } from "vitest";

import { fetchMcpSkillsForClient } from "./mcpSkills.js";
import type { MCPServerConnection } from "../services/mcp/types.js";

function connectedClient(
  resources: readonly {
    readonly uri: string;
    readonly name?: string;
    readonly description?: string;
    readonly text?: string;
  }[],
): MCPServerConnection {
  const request = vi.fn(async (request: { method: string; params?: { uri?: string } }) => {
    if (request.method === "resources/list") {
      return {
        resources: resources.map(({ text: _text, ...resource }) => resource),
      };
    }
    if (request.method === "resources/read") {
      const resource = resources.find((candidate) => candidate.uri === request.params?.uri);
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
});
