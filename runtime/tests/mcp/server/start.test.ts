import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ToolRegistry } from "../../tool-registry.js";
import {
  formatMcpSseServeUrl,
  MCP_INBOUND_TOOL_ADMISSION_REQUIRED_CODE,
  MCP_INBOUND_TOOL_ADMISSION_REQUIRED_MESSAGE,
  MCP_INBOUND_TOOL_ADMISSION_REQUIRED_REASON,
  prepareMcpSseServerReconfigurationFromConfig,
  resolveMcpServeDefaults,
  startMcpServerFromConfig,
  startMcpSseServe,
} from "./start.js";

const UNREACHABLE_REGISTRY: ToolRegistry = {
  get tools() {
    throw new Error("unadmitted inbound MCP must not materialize tools");
  },
  toLLMTools() {
    throw new Error("unadmitted inbound MCP must not materialize tools");
  },
  async dispatch() {
    throw new Error("unadmitted inbound MCP must not dispatch tools");
  },
};

function mcpHeaders(sessionId?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  };
}

function mcpRequest(id: number, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

async function initializeMcp(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(),
    body: mcpRequest(1, "initialize"),
  });
  expect(response.status).toBe(200);
  await response.json();
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("missing MCP session id");
  return sessionId;
}

function parseMcpSseData(frame: string): unknown {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return JSON.parse(data);
}

async function callMcpTool(
  url: string,
  sessionId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  id: number,
): Promise<{ readonly status: number; readonly message?: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(sessionId),
    body: mcpRequest(id, "tools/call", {
      name,
      arguments: args,
    }),
  });
  if (response.status !== 200) return { status: response.status };
  return {
    status: response.status,
    message: parseMcpSseData(await response.text()),
  };
}

function admissionRequiredMessage(id: number): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: MCP_INBOUND_TOOL_ADMISSION_REQUIRED_MESSAGE,
        },
      ],
      structuredContent: {
        code: MCP_INBOUND_TOOL_ADMISSION_REQUIRED_CODE,
        reason: MCP_INBOUND_TOOL_ADMISSION_REQUIRED_REASON,
      },
      isError: true,
    },
  };
}

async function postMcpJson(
  url: string,
  sessionId: string,
  id: number,
  method: string,
  params?: unknown,
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(sessionId),
    body: mcpRequest(id, method, params),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("mcp server start config", () => {
  test("resolves disabled stdio defaults and safe malformed fallbacks", () => {
    expect(resolveMcpServeDefaults(undefined)).toEqual({
      enabled: false,
      transport: "stdio",
      host: "127.0.0.1",
      port: 3334,
    });
    expect(
      resolveMcpServeDefaults({
        enabled: true,
        transport: "http" as never,
        host: "   ",
        port: -1,
      }),
    ).toEqual({
      enabled: true,
      transport: "stdio",
      host: "127.0.0.1",
      port: 3334,
    });
  });

  test("keeps valid configured port boundaries", () => {
    expect(resolveMcpServeDefaults({ port: 0 }).port).toBe(0);
    expect(resolveMcpServeDefaults({ port: 65_535 }).port).toBe(65_535);
  });

  test("does not autostart disabled or daemon-unsupported stdio modes", async () => {
    await expect(startMcpServerFromConfig(undefined)).resolves.toMatchObject({
      kind: "disabled",
      defaults: { enabled: false, transport: "stdio" },
    });
    await expect(
      startMcpServerFromConfig({ mcp: { server: { enabled: true } } }),
    ).resolves.toMatchObject({
      kind: "unsupported",
      defaults: { enabled: true, transport: "stdio" },
    });
    await expect(
      startMcpServerFromConfig({
        mcp: { server: { enabled: true, transport: "sse", port: 0 } },
      }),
    ).resolves.toMatchObject({
      kind: "unsupported",
      defaults: { enabled: true, transport: "sse" },
      reason: expect.stringContaining("mcp.server.workspace"),
    });
    await expect(
      startMcpServerFromConfig({
        mcp: {
          server: {
            enabled: true,
            transport: "sse",
            port: 0,
            workspace: ".",
          },
        },
      }),
    ).rejects.toThrow(
      "mcp.server.workspace must be an absolute filesystem path",
    );
  });

  test("starts enabled SSE mode on a real loopback HTTP server", async () => {
    const result = await startMcpServerFromConfig(
      {
        mcp: {
          server: {
            enabled: true,
            transport: "sse",
            host: "127.0.0.1",
            port: 0,
            workspace: process.cwd(),
          },
        },
      },
      { toolRegistry: UNREACHABLE_REGISTRY },
    );
    if (result.kind !== "started") {
      throw new Error(`expected started result, got ${result.kind}`);
    }
    try {
      expect(result.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const response = await fetch(result.server.url, {
        method: "GET",
        headers: { accept: "text/event-stream" },
      });
      expect(response.status).toBe(400);

      const session = await initializeMcp(result.server.url);
      await expect(
        postMcpJson(result.server.url, session, 2, "tools/list"),
      ).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [], nextCursor: null },
      });
      await expect(
        callMcpTool(
          result.server.url,
          session,
          "system.listDir",
          { path: process.cwd() },
          3,
        ),
      ).resolves.toEqual({
        status: 200,
        message: admissionRequiredMessage(3),
      });
    } finally {
      await result.server.close();
    }
  });

  test("atomically replaces workspace context, revokes old sessions, and preserves the old context on prepare failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-mcp-workspaces-"));
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const invalidWorkspace = join(root, "not-a-directory");
    const globalHome = join(root, "global-home");
    await Promise.all([
      mkdir(join(workspaceA, ".agenc", "skills", "workspace-only"), {
        recursive: true,
      }),
      mkdir(join(workspaceA, ".agenc", "memory"), { recursive: true }),
      mkdir(join(workspaceB, ".agenc", "skills", "workspace-b"), {
        recursive: true,
      }),
      mkdir(join(globalHome, "skills", "global-only"), { recursive: true }),
      mkdir(join(globalHome, "commands"), { recursive: true }),
      mkdir(join(globalHome, "memory"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(invalidWorkspace, "file"),
      writeFile(
        join(workspaceA, ".agenc", "skills", "workspace-only", "SKILL.md"),
        "---\ndescription: Workspace-only prompt\n---\nWorkspace prompt sentinel",
      ),
      writeFile(
        join(workspaceB, ".agenc", "skills", "workspace-b", "SKILL.md"),
        "---\ndescription: Workspace B prompt\n---\nWorkspace B prompt sentinel",
      ),
      writeFile(
        join(globalHome, "skills", "global-only", "SKILL.md"),
        "---\ndescription: Global prompt\n---\nGlobal prompt sentinel",
      ),
      writeFile(
        join(globalHome, "commands", "outside-command.md"),
        "---\ndescription: Outside command\n---\nOutside command sentinel",
      ),
      writeFile(
        join(workspaceA, ".agenc", "memory", "workspace-note.md"),
        "Workspace memory sentinel",
      ),
      writeFile(
        join(globalHome, "memory", "global-note.md"),
        "Global memory sentinel",
      ),
      writeFile(join(globalHome, "AGENC.md"), "Global instruction sentinel"),
    ]);
    await Promise.all([
      symlink(
        join(globalHome, "skills", "global-only", "SKILL.md"),
        join(workspaceA, ".agenc", "skills", "leak-prompt.md"),
      ),
      symlink(
        join(globalHome, "commands"),
        join(workspaceA, ".agenc", "commands"),
        "dir",
      ),
      symlink(
        join(globalHome, "memory", "global-note.md"),
        join(workspaceA, ".agenc", "memory", "leak-memory.md"),
      ),
      symlink(join(globalHome, "AGENC.md"), join(workspaceA, "AGENC.md")),
    ]);

    const configFor = (workspace: string) => ({
      mcp: {
        server: {
          enabled: true as const,
          transport: "sse" as const,
          host: "127.0.0.1",
          port: 0,
          workspace,
        },
      },
    });
    const originalAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = globalHome;
    const result = await startMcpServerFromConfig(configFor(workspaceA));
    if (result.kind !== "started") {
      throw new Error(`expected started result, got ${result.kind}`);
    }

    try {
      const oldSession = await initializeMcp(result.server.url);
      const promptList = await postMcpJson(
        result.server.url,
        oldSession,
        2,
        "prompts/list",
      );
      expect(JSON.stringify(promptList)).toContain("workspace-only");
      expect(JSON.stringify(promptList)).not.toContain("global-only");
      expect(JSON.stringify(promptList)).not.toContain("leak-prompt");
      expect(JSON.stringify(promptList)).not.toContain("outside-command");
      const promptGet = await postMcpJson(
        result.server.url,
        oldSession,
        3,
        "prompts/get",
        { name: "workspace-only" },
      );
      expect(JSON.stringify(promptGet)).toContain("Workspace prompt sentinel");
      expect(JSON.stringify(promptGet)).not.toContain("Global prompt sentinel");

      const resourceList = await postMcpJson(
        result.server.url,
        oldSession,
        4,
        "resources/list",
      );
      const serializedResources = JSON.stringify(resourceList);
      expect(serializedResources).toContain("workspace-note.md");
      expect(serializedResources).not.toContain("global-note.md");
      expect(serializedResources).not.toContain("leak-memory.md");
      expect(serializedResources).not.toContain("AGENC.md");
      const workspaceNote = resourceList.result.resources.find(
        (resource: { readonly name: string }) =>
          resource.name === "workspace-note.md",
      );
      const resourceRead = await postMcpJson(
        result.server.url,
        oldSession,
        5,
        "resources/read",
        { uri: workspaceNote.uri },
      );
      expect(JSON.stringify(resourceRead)).toContain("Workspace memory sentinel");
      expect(JSON.stringify(resourceRead)).not.toContain("Global memory sentinel");

      const listResponse = await fetch(result.server.url, {
        method: "POST",
        headers: mcpHeaders(oldSession),
        body: mcpRequest(6, "tools/list"),
      });
      await expect(listResponse.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 6,
        result: { tools: [], nextCursor: null },
      });
      const symbolCall = await callMcpTool(
        result.server.url,
        oldSession,
        "system.symbolSearch",
        { query: "anything", workspace_root: workspaceA },
        7,
      );
      expect(symbolCall).toEqual({
        status: 200,
        message: admissionRequiredMessage(7),
      });
      await expect(stat(join(workspaceA, "code-intel"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await expect(
        prepareMcpSseServerReconfigurationFromConfig(
          result.server,
          configFor(invalidWorkspace),
        ),
      ).rejects.toThrow("must resolve to a directory");
      const afterRejectedPrepare = await postMcpJson(
        result.server.url,
        oldSession,
        8,
        "prompts/get",
        { name: "workspace-only" },
      );
      expect(JSON.stringify(afterRejectedPrepare)).toContain(
        "Workspace prompt sentinel",
      );

      const prepared = await prepareMcpSseServerReconfigurationFromConfig(
        result.server,
        configFor(workspaceB),
      );
      expect(prepared.apply()).toBe(1);
      const revoked = await fetch(result.server.url, {
        method: "POST",
        headers: mcpHeaders(oldSession),
        body: mcpRequest(9, "prompts/list"),
      });
      expect(revoked.status).toBe(404);

      const newSession = await initializeMcp(result.server.url);
      const secondPromptList = await postMcpJson(
        result.server.url,
        newSession,
        10,
        "prompts/list",
      );
      expect(JSON.stringify(secondPromptList)).toContain("workspace-b");
      expect(JSON.stringify(secondPromptList)).not.toContain("workspace-only");

    } finally {
      await result.server.close();
      if (originalAgencHome === undefined) {
        delete process.env.AGENC_HOME;
      } else {
        process.env.AGENC_HOME = originalAgencHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pins foreground SSE prompt scope while tools remain fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-mcp-pinned-sse-"));
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    await Promise.all([
      mkdir(join(workspaceA, ".agenc", "skills", "a-only"), {
        recursive: true,
      }),
      mkdir(join(workspaceB, ".agenc", "skills", "b-only"), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      writeFile(
        join(workspaceA, ".agenc", "skills", "a-only", "SKILL.md"),
        "---\ndescription: A-only prompt\n---\nPrompt from workspace A",
      ),
      writeFile(
        join(workspaceB, ".agenc", "skills", "b-only", "SKILL.md"),
        "---\ndescription: B-only prompt\n---\nPrompt from workspace B",
      ),
    ]);
    const originalCwd = process.cwd();
    let started: Awaited<ReturnType<typeof startMcpSseServe>> | undefined;
    try {
      process.chdir(workspaceA);
      const starting = startMcpSseServe({
        transport: "sse",
        host: "127.0.0.1",
        port: 0,
      });
      process.chdir(workspaceB);
      started = await starting;

      const session = await initializeMcp(started.url);
      const prompts = await postMcpJson(
        started.url,
        session,
        2,
        "prompts/list",
      );
      expect(JSON.stringify(prompts)).toContain("a-only");
      expect(JSON.stringify(prompts)).not.toContain("b-only");
      const prompt = await postMcpJson(
        started.url,
        session,
        3,
        "prompts/get",
        { name: "a-only" },
      );
      expect(JSON.stringify(prompt)).toContain("Prompt from workspace A");
      expect(JSON.stringify(prompt)).not.toContain("Prompt from workspace B");
      await expect(
        postMcpJson(started.url, session, 4, "tools/list"),
      ).resolves.toEqual({
        jsonrpc: "2.0",
        id: 4,
        result: { tools: [], nextCursor: null },
      });
      await expect(
        callMcpTool(
          started.url,
          session,
          "system.listDir",
          { path: workspaceA },
          5,
        ),
      ).resolves.toEqual({
        status: 200,
        message: admissionRequiredMessage(5),
      });
    } finally {
      process.chdir(originalCwd);
      await started?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-loopback SSE hosts", () => {
    expect(() => formatMcpSseServeUrl("0.0.0.0", 3334)).toThrow(
      "only binds to loopback hosts",
    );
  });
});
