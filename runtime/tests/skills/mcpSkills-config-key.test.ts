import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchMcpSkillsForClient } from "../../src/skills/mcpSkills.js";
import type { MCPServerConnection } from "../../src/services/mcp/types.js";

// mcpSkills:223 minor (core-todo.md): fetchMcpSkillsForClient memoized on client.name
// alone, so two sessions each configuring a same-named MCP server pointing at DIFFERENT
// servers collided (the second got the first's cached skills). Fixed by keying on
// name + server config.

interface FakeResource {
  uri: string;
  name: string;
}

function makeClient(serverName: string, skill: string, configUrl: string): MCPServerConnection {
  const resources: FakeResource[] = [{ uri: `skill://x/${skill}`, name: skill }];
  const text = `---\ndescription: ${skill}\n---\nbody for ${skill}\n`;
  const request = vi.fn(async (req: { method: string; params?: { uri?: string } }) => {
    if (req.method === "resources/list") return { resources };
    if (req.method === "resources/read") {
      return { contents: [{ uri: req.params?.uri, text }] };
    }
    throw new Error(`unexpected ${req.method}`);
  });
  return {
    type: "connected",
    name: serverName,
    capabilities: { resources: {} },
    client: { request },
    // The real connection carries `config`; distinct configs must not collide.
    config: { type: "stdio", command: configUrl, scope: "project" },
    cleanup: async () => {},
  } as unknown as MCPServerConnection;
}

describe("fetchMcpSkillsForClient — config-aware cache key", () => {
  beforeEach(() => {
    (fetchMcpSkillsForClient as unknown as { cache: { clear(): void } }).cache.clear();
  });

  it("does not collide same-named servers with different configs", async () => {
    const a = makeClient("gh", "alpha", "server-a");
    const b = makeClient("gh", "beta", "server-b");

    const sa = (await fetchMcpSkillsForClient(a)).map((s) => s.name);
    const sb = (await fetchMcpSkillsForClient(b)).map((s) => s.name);

    expect(sa).toContain("mcp__gh__alpha");
    // Under the old name-only key, b returned a's cached 'alpha' skill.
    expect(sb).toContain("mcp__gh__beta");
    expect(sb).not.toContain("mcp__gh__alpha");
  });
});
