/**
 * Task 13: the MCP server exposes prompts (skills) and resources
 * (memory files + instruction files), not just tools. Protocol-level:
 * a client initializes, sees the capabilities, lists/gets a skill as a
 * prompt, and reads a memory file as a resource; excluded/secret
 * content stays out.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpServerFramework } from "../../src/mcp-server/framework.js";
import {
  createMemoryResourceProvider,
  createSkillPromptProvider,
} from "../../src/mcp/server/content-providers.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-mcp-content-"));
  vi.stubEnv("AGENC_CONFIG_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function request(
  server: McpServerFramework,
  method: string,
  params?: unknown,
  id = 1,
): Promise<any> {
  const [out] = await server.handleMessageAsync({
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });
  return out;
}

async function initialized(server: McpServerFramework): Promise<any> {
  return await request(server, "initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "test-client", version: "1.0" },
  }, 0);
}

describe("MCP prompts backed by skills", () => {
  async function makeSkillServer(): Promise<McpServerFramework> {
    const skillsDir = join(root, "skills");
    await mkdir(join(skillsDir, "review-pr"), { recursive: true });
    await writeFile(
      join(skillsDir, "review-pr", "SKILL.md"),
      [
        "---",
        "description: Review a pull request",
        "argument-hint: <pr-number>",
        "---",
        "Review PR $ARGUMENTS carefully.",
      ].join("\n"),
    );
    await mkdir(join(skillsDir, "internal-only"), { recursive: true });
    await writeFile(
      join(skillsDir, "internal-only", "SKILL.md"),
      [
        "---",
        "description: Not for model invocation",
        "disable-model-invocation: true",
        "---",
        "secret workflow",
      ].join("\n"),
    );
    return new McpServerFramework({
      promptProvider: createSkillPromptProvider({ skillRoots: [skillsDir] }),
    });
  }

  it("advertises the prompts capability in the initialize handshake", async () => {
    const server = await makeSkillServer();
    const init = await initialized(server);
    expect(init.result.capabilities.prompts).toEqual({ listChanged: false });
  });

  it("lists skills as prompts, excluding disable-model-invocation skills", async () => {
    const server = await makeSkillServer();
    await initialized(server);
    const out = await request(server, "prompts/list");
    const names = out.result.prompts.map((p: any) => p.name);
    expect(names).toContain("review-pr");
    expect(names).not.toContain("internal-only");
    const prompt = out.result.prompts.find((p: any) => p.name === "review-pr");
    expect(prompt.description).toBe("Review a pull request");
  });

  it("gets a skill as a prompt with argument substitution", async () => {
    const server = await makeSkillServer();
    await initialized(server);
    const out = await request(server, "prompts/get", {
      name: "review-pr",
      arguments: { arguments: "#42" },
    });
    expect(out.result.messages).toEqual([
      {
        role: "user",
        content: { type: "text", text: "Review PR #42 carefully." },
      },
    ]);
  });

  it("refuses prompts/get for excluded and unknown prompts", async () => {
    const server = await makeSkillServer();
    await initialized(server);
    const excluded = await request(server, "prompts/get", {
      name: "internal-only",
    });
    expect(excluded.error.message).toContain("unknown prompt");
    const missing = await request(server, "prompts/get", { name: "nope" });
    expect(missing.error).toBeDefined();
  });

  it("still METHOD_NOT_FOUNDs when no provider is configured", async () => {
    const server = new McpServerFramework({});
    await initialized(server);
    const out = await request(server, "prompts/list");
    expect(out.error.code).toBe(-32601);
  });
});

describe("MCP resources backed by memory + instruction files", () => {
  async function makeResourceServer(): Promise<{
    server: McpServerFramework;
    memoryDir: string;
  }> {
    const memoryDir = join(root, "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "MEMORY.md"),
      "- [Deploy notes](deploy-notes.md)",
    );
    await writeFile(
      join(memoryDir, "deploy-notes.md"),
      [
        "---",
        "name: deploy-notes",
        "description: How deploys work",
        "---",
        "Use the staging pipeline. Token: ghp_0123456789abcdefABCDEF0123456789abcdef",
      ].join("\n"),
    );
    // Session memory lives under the config home's session-memory dir; it
    // must never be listed even if a memory dir points at it.
    const sessionDir = join(root, "session-memory");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "leak.md"), "session transcript notes");
    await writeFile(join(root, "AGENC.md"), "# Project instructions\nhello");
    const server = new McpServerFramework({
      resourceProvider: createMemoryResourceProvider({
        memoryDirs: [memoryDir, sessionDir],
        instructionFiles: [join(root, "AGENC.md")],
      }),
    });
    return { server, memoryDir };
  }

  it("advertises the resources capability in the initialize handshake", async () => {
    const { server } = await makeResourceServer();
    const init = await initialized(server);
    expect(init.result.capabilities.resources).toEqual({
      listChanged: false,
      subscribe: false,
    });
  });

  it("lists memory files + instruction files but never session files", async () => {
    const { server } = await makeResourceServer();
    await initialized(server);
    const out = await request(server, "resources/list");
    const names = out.result.resources.map((r: any) => r.name);
    expect(names).toContain("deploy-notes.md");
    expect(names).toContain("MEMORY.md");
    expect(names).toContain("AGENC.md");
    expect(names).not.toContain("leak.md");
  });

  it("reads a memory file with secrets redacted", async () => {
    const { server } = await makeResourceServer();
    await initialized(server);
    const list = await request(server, "resources/list");
    const note = list.result.resources.find(
      (r: any) => r.name === "deploy-notes.md",
    );
    const out = await request(server, "resources/read", { uri: note.uri });
    const text = out.result.contents[0].text;
    expect(text).toContain("staging pipeline");
    expect(text).not.toContain("ghp_0123456789abcdef");
  });

  it("rejects URIs it did not mint (path bounding)", async () => {
    const { server } = await makeResourceServer();
    await initialized(server);
    for (const uri of [
      "file:///etc/passwd",
      "agenc-memory://0/../../etc/passwd",
      "agenc-memory://99/nope.md",
    ]) {
      const out = await request(server, "resources/read", { uri });
      expect(out.error.message).toContain("unknown resource");
    }
  });
});
