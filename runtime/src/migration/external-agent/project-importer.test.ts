import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseToml } from "../../config/loader.js";
import { validateHooksConfig } from "../../config/schema.js";
import {
  buildMcpConfigFromSource,
  importCommands,
  importExternalAgentProject,
  importHooks,
  missingSubagentNames,
  renderMcpConfigToml,
  type SourceAgentLayout,
} from "./project-importer.js";

const SOURCE_LAYOUT: SourceAgentLayout = {
  configDirName: ".cursor",
  projectConfigFileName: ".cursor.json",
  projectDirEnvVar: "CURSOR_PROJECT_DIR",
  docFileName: "SOURCE.md",
  termVariants: ["source agent", "source-agent", "source_agent", "sourceagent"],
};

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-external-agent-"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("external agent project migration", () => {
  test("imports a source project end-to-end into AgenC-shaped files", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    const sourceHome = join(project, ".cursor");
    const targetHome = join(root, "agenc-home");
    await mkdir(join(sourceHome, "hooks"), { recursive: true });
    await mkdir(join(sourceHome, "agents"), { recursive: true });
    await mkdir(join(sourceHome, "commands", "pr"), { recursive: true });

    await writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        local: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "${TOKEN}", STATIC_FLAG: "1" },
        },
        web: {
          type: "streamable_http",
          url: "http://127.0.0.1:39123/mcp",
          headers: { "X-Team": "runtime" },
        },
        skipped: {
          command: "node",
          args: ["${TOKEN}"],
        },
      },
    });
    await writeJson(join(project, ".cursor.json"), {
      projects: {
        [project]: {
          mcpServers: {
            "home-only": { command: "home-server" },
          },
        },
      },
    });
    await writeJson(join(sourceHome, "settings.json"), {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                command: "python3 .cursor/hooks/check.py",
                timeoutSec: 7,
                statusMessage: "source agent ready",
              },
            ],
          },
        ],
      },
    });
    await writeFile(join(sourceHome, "hooks", "check.py"), "print('new')\n");
    await writeFile(
      join(sourceHome, "agents", "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Review source agent work",
        "permissionMode: acceptEdits",
        "effort: max",
        "---",
        "Read AGENTS.md and review source agent changes.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sourceHome, "commands", "pr", "review.md"),
      "---\ndescription: Review a change\n---\nRun source agent review.\n",
      "utf8",
    );

    const result = await importExternalAgentProject({
      sourceRoot: project,
      sourceAgentHome: sourceHome,
      targetAgencHome: targetHome,
    });

    expect(result.importedSubagents).toBe(1);
    expect(result.importedCommands).toBe(1);
    expect(result.wroteHooks).toBe(true);
    expect(result.mcpConfigFile).toBe(join(targetHome, "mcp-servers.toml"));

    const mcpToml = parseToml(await readFile(result.mcpConfigFile!, "utf8"));
    expect(mcpToml).toMatchObject({
      mcp_servers: {
        "home-only": { command: "home-server", transport: "stdio" },
        local: {
          command: "node",
          args: ["server.js"],
          env: { STATIC_FLAG: "1" },
          transport: "stdio",
        },
        web: {
          endpoint: "http://127.0.0.1:39123/mcp",
          headers: { "X-Team": "runtime" },
          transport: "http",
        },
      },
    });
    expect(
      (mcpToml as Record<string, Record<string, unknown>>).mcp_servers,
    ).not.toHaveProperty("skipped");

    const hooksPayload = JSON.parse(
      await readFile(join(targetHome, "hooks.json"), "utf8"),
    ) as { hooks: unknown };
    expect(validateHooksConfig(hooksPayload.hooks).SessionStart?.[0]).toMatchObject({
      matcher: "startup",
      hooks: [
        {
          type: "command",
          command: `python3 '${join(targetHome, "hooks", "check.py")}'`,
          timeout_ms: 7000,
          statusMessage: "AgenC ready",
        },
      ],
    });
    expect(await readFile(join(targetHome, "hooks", "check.py"), "utf8")).toBe(
      "print('new')\n",
    );

    const agentToml = parseToml(
      await readFile(join(targetHome, "agents", "reviewer.toml"), "utf8"),
    );
    expect(agentToml).toMatchObject({
      name: "reviewer",
      description: "Review AgenC work",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "workspace-write",
      developer_instructions: "Read AGENC.md and review AgenC changes.",
    });

    const skill = await readFile(
      join(targetHome, "skills", "source-command-pr-review", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain('name: "source-command-pr-review"');
    expect(skill).toContain("Run AgenC review.");
  });

  test("default layout imports a cursor-style project without custom layout injection", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    const sourceHome = join(project, ".cursor");
    const targetHome = join(root, "agenc-home");
    await mkdir(join(sourceHome, "agents"), { recursive: true });
    await writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        local: { command: "default-server" },
      },
    });
    await writeFile(
      join(sourceHome, "agents", "default.md"),
      "---\nname: default\ndescription: Default import\n---\nRead AGENTS.md.\n",
      "utf8",
    );

    const result = await importExternalAgentProject({
      sourceRoot: project,
      sourceAgentHome: sourceHome,
      targetAgencHome: targetHome,
    });

    expect(result.mcpToml).toContain("[mcp_servers.local]");
    expect(result.importedSubagents).toBe(1);
    const agentToml = parseToml(
      await readFile(join(targetHome, "agents", "default.toml"), "utf8"),
    );
    expect(agentToml).toMatchObject({
      developer_instructions: "Read AGENC.md.",
    });
  });

  test("filters unsupported MCP servers and honors enabled settings", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        enabled: { command: "enabled-server" },
        disabled: { command: "disabled-server", disabled: true },
        placeholder: { command: "run", args: ["${TOKEN}"] },
        unsupported: { type: "sse", url: "http://127.0.0.1:39124/sse" },
        "__proto__": { command: "pollute" },
      },
    });

    const config = await buildMcpConfigFromSource({
      sourceRoot: project,
      settings: { enabledMcpjsonServers: ["enabled", "placeholder", "unsupported"] },
      layout: SOURCE_LAYOUT,
    });

    expect(Object.keys(config.mcp_servers ?? {})).toEqual(["enabled"]);
    expect(config.mcp_servers?.enabled).toMatchObject({
      command: "enabled-server",
      transport: "stdio",
    });
  });

  test("preserves source-root MCP servers over home-level project entries", async () => {
    const root = await tempRoot();
    const project = join(root, "project");
    const sourceHome = join(root, ".cursor");
    await mkdir(project, { recursive: true });
    await mkdir(sourceHome, { recursive: true });
    await writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        shared: { command: "project-server" },
      },
    });
    await writeJson(join(root, ".cursor.json"), {
      projects: {
        [project]: {
          mcpServers: {
            "home-only": { command: "home-server" },
            shared: { command: "home-server" },
          },
        },
      },
    });

    const config = await buildMcpConfigFromSource({
      sourceRoot: project,
      sourceAgentHome: sourceHome,
      layout: SOURCE_LAYOUT,
    });

    expect(config.mcp_servers).toMatchObject({
      "home-only": { command: "home-server", transport: "stdio" },
      shared: { command: "project-server", transport: "stdio" },
    });
  });

  test("rejects TOML strings with unsupported control characters", () => {
    expect(() =>
      renderMcpConfigToml({
        mcp_servers: {
          bad: { command: "node\u0001server", transport: "stdio" },
        },
      }),
    ).toThrow(/control character U\+0001/);
  });

  test("preserves existing hook scripts and refuses unsafe hook path rewrites", async () => {
    const root = await tempRoot();
    const sourceHome = join(root, "project", ".cursor");
    const targetHome = join(root, "agenc-home");
    await mkdir(join(sourceHome, "hooks"), { recursive: true });
    await mkdir(join(targetHome, "hooks"), { recursive: true });
    await writeFile(join(sourceHome, "hooks", "check.py"), "new\n", "utf8");
    await writeFile(join(targetHome, "hooks", "check.py"), "existing\n", "utf8");
    await writeJson(join(sourceHome, "settings.json"), {
      hooks: {
        PermissionRequest: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "python3 .cursor/hooks/check.py" },
              { type: "command", command: "python3 .cursor/hooks/../escape.py" },
              { type: "command", command: "python3 .cursor/hooks/${SCRIPT}.py" },
            ],
          },
        ],
      },
    });

    await expect(
      importHooks(sourceHome, join(targetHome, "hooks.json"), SOURCE_LAYOUT),
    ).resolves.toBe(true);

    expect(await readFile(join(targetHome, "hooks", "check.py"), "utf8")).toBe(
      "existing\n",
    );
    const hooksPayload = JSON.parse(
      await readFile(join(targetHome, "hooks.json"), "utf8"),
    ) as { hooks: { PermissionRequest: Array<{ hooks: Array<{ command: string }> }> } };
    const commands = hooksPayload.hooks.PermissionRequest[0]!.hooks.map(
      (hook) => hook.command,
    );
    expect(commands).toContain(`python3 '${join(targetHome, "hooks", "check.py")}'`);
    expect(commands).toContain("python3 .cursor/hooks/../escape.py");
    expect(commands).toContain("python3 .cursor/hooks/${SCRIPT}.py");
  });

  test("skips incomplete agents and command slug collisions", async () => {
    const root = await tempRoot();
    const sourceHome = join(root, "project", ".cursor");
    const targetHome = join(root, "agenc-home");
    await mkdir(join(sourceHome, "agents"), { recursive: true });
    await mkdir(join(sourceHome, "commands"), { recursive: true });
    await writeFile(
      join(sourceHome, "agents", "complete.md"),
      "---\nname: complete\ndescription: Complete agent\n---\nAct carefully.\n",
      "utf8",
    );
    await writeFile(
      join(sourceHome, "agents", "missing-description.md"),
      "---\nname: incomplete\n---\nAct carefully.\n",
      "utf8",
    );
    await writeFile(
      join(sourceHome, "commands", "foo-bar.md"),
      "---\ndescription: First\n---\nRun first.\n",
      "utf8",
    );
    await writeFile(
      join(sourceHome, "commands", "foo_bar.md"),
      "---\ndescription: Second\n---\nRun second.\n",
      "utf8",
    );
    await writeFile(
      join(sourceHome, "commands", "deploy.md"),
      "---\ndescription: Deploy\n---\nDeploy $ARGUMENTS from @release.yaml\n",
      "utf8",
    );

    await expect(
      missingSubagentNames(
        join(sourceHome, "agents"),
        join(targetHome, "agents"),
        SOURCE_LAYOUT,
      ),
    ).resolves.toEqual(["complete"]);
    await expect(
      importCommands(
        join(sourceHome, "commands"),
        join(targetHome, "skills"),
        SOURCE_LAYOUT,
      ),
    ).resolves.toBe(0);
  });
});
