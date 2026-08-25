import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { validateStrictConfigDocument } from "../../src/config/repository.js";
import {
  KNOWN_CONFIG_KEYS,
  validateAgenCConfigBlocks,
  type AgenCConfig,
} from "../../src/config/schema.js";
import { STRICT_VALIDATED_CONFIG_KEYS } from "../../src/config/strict-schema.js";
import type { JsonRecord } from "../../src/config/json.js";

function malformed(value: unknown): AgenCConfig {
  return value as AgenCConfig;
}

describe("strict schema-v2 validation coverage", () => {
  test("keeps the strict root registry exhaustive with AgenCConfig and the v2 key catalog", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../src/config/schema.ts"),
      "utf8",
    );
    const body = source.match(
      /export interface AgenCConfig \{([\s\S]*?)\n\}/u,
    )?.[1] ?? "";
    const interfaceFields = Array.from(
      body.matchAll(/^  readonly ([A-Za-z_][A-Za-z0-9_]*)\??:/gmu),
      (match) => match[1]!,
    ).filter((field) => field !== "_unknown").sort();

    expect([...STRICT_VALIDATED_CONFIG_KEYS].sort()).toEqual(interfaceFields);
    expect([...STRICT_VALIDATED_CONFIG_KEYS].sort()).toEqual(
      KNOWN_CONFIG_KEYS.filter((field) => field !== "_unknown").sort(),
    );
  });

  test.each([
    ["model", { model: 42 }, /Invalid model/u],
    ["approval policy", { approval_policy: "sometimes" }, /approval_policy/u],
    ["sandbox mode", { sandbox_mode: "container" }, /sandbox_mode/u],
    ["reasoning effort", { reasoning_effort: "max" }, /reasoning_effort/u],
    ["retired minimal reasoning effort", { reasoning_effort: "minimal" }, /reasoning_effort/u],
    ["agent threads", { agent_max_threads: 0 }, /agent_max_threads/u],
    ["agent depth", { agent_max_depth: -1 }, /agent_max_depth/u],
    ["project markers", { project_root_markers: [".git", 4] }, /project_root_markers/u],
    ["document bytes", { project_doc_max_bytes: 0 }, /project_doc_max_bytes/u],
    ["auto updates", { autoUpdates: "yes" }, /autoUpdates/u],
    ["watchdog", { stream_watchdog_timeout_ms: -1 }, /stream_watchdog_timeout_ms/u],
    ["max output", { max_output_tokens: 0 }, /max_output_tokens/u],
    ["max turns", { max_turns: 0 }, /max_turns/u],
    ["budget cap", { max_budget_usd: Number.NaN }, /max_budget_usd/u],
    ["autonomous mode", { autonomous_mode: "true" }, /autonomous_mode/u],
    ["coordinator mode", { coordinator_mode: 1 }, /coordinator_mode/u],
  ])("rejects an invalid root %s", (_label, config, error) => {
    expect(() => validateAgenCConfigBlocks(malformed(config))).toThrow(error);
  });

  test.each([
    [
      "shell environment unknown field",
      { shell_environment_policy: { typo: true } },
      /shell_environment_policy\.typo.*unknown field/u,
    ],
    [
      "shell environment set value",
      { shell_environment_policy: { set: { NODE_ENV: false } } },
      /shell_environment_policy\.set\.NODE_ENV/u,
    ],
    [
      "tool unknown nested field",
      { tools_config: { "system.bash": { enabled: true } } },
      /tools_config\.system\.bash\.enabled.*unknown field/u,
    ],
    [
      "tool endpoint kind",
      { tools_config: { web_search_endpoint_kind: "xml" } },
      /web_search_endpoint_kind/u,
    ],
    ["daemon unknown field", { daemon: { socket: true } }, /daemon\.socket/u],
    ["daemon unknown transport", { daemon: { transport: "unix" } }, /daemon\.transport.*unknown field/u],
    [
      "LSP unknown field",
      {
        lsp_servers: {
          ts: {
            command: "typescript-language-server",
            extensionToLanguage: { ".ts": "typescript" },
            restartOnCrash: true,
          },
        },
      },
      /lsp_servers\.ts\.restartOnCrash.*unknown field/u,
    ],
    [
      "LSP required extension map",
      { lsp_servers: { ts: { command: "typescript-language-server" } } },
      /lsp_servers\.ts\.extensionToLanguage.*required/u,
    ],
    ["attachments unknown field", { attachments: { roots: ["/tmp"] } }, /attachments\.roots/u],
    ["TUI unknown field", { tui: { vimMode: true, mystery: "dark" } }, /tui\.mystery/u],
    ["browser unknown field", { browser: { executable: "/bin/chrome" } }, /browser\.executable/u],
    [
      "durable turn unknown field",
      { durableTurns: { resume: { replayTools: true } } },
      /durableTurns\.resume\.replayTools/u,
    ],
    ["budget unknown field", { budget: { weekly_usd: 5 } }, /budget\.weekly_usd/u],
    ["budget threshold", { budget: { soft_threshold: 1 } }, /budget\.soft_threshold/u],
    [
      "heartbeat active hours",
      { heartbeat: { active_hours: [22, 8] } },
      /heartbeat\.active_hours/u,
    ],
    [
      "heartbeat incomplete target",
      { heartbeat: { target_channel: "ops" } },
      /target_channel and target_conversation/u,
    ],
    [
      "heartbeat empty target channel",
      { heartbeat: { target_channel: "", target_conversation: "thread" } },
      /heartbeat\.target_channel.*non-empty/u,
    ],
    [
      "heartbeat empty target conversation",
      { heartbeat: { target_channel: "ops", target_conversation: "  " } },
      /heartbeat\.target_conversation.*non-empty/u,
    ],
    [
      "LLM collection range",
      { providers: { grok: { collections: { max_num_results: 0 } } } },
      /grok\.collections\.max_num_results/u,
    ],
    [
      "LLM remote MCP required label",
      { providers: { grok: { remote_mcp: { servers: [{ server_url: "https://mcp.example" }] } } } },
      /remote_mcp\.servers\.0\.server_label.*required/u,
    ],
    [
      "LLM remote MCP plaintext authorization",
      {
        providers: {
          grok: {
            remote_mcp: {
              servers: [
                {
                  server_url: "https://mcp.example",
                  server_label: "docs",
                  authorization: "Bearer plaintext-secret",
                },
              ],
            },
          },
        },
      },
      /remote_mcp\.servers\.0\.authorization.*unknown field/u,
    ],
    [
      "LLM remote MCP invalid authorization environment name",
      {
        providers: {
          grok: {
            remote_mcp: {
              servers: [
                {
                  server_url: "https://mcp.example",
                  server_label: "docs",
                  authorization_env: "NOT-AN-ENV-NAME",
                },
              ],
            },
          },
        },
      },
      /remote_mcp\.servers\.0\.authorization_env.*AGENC_CREDENTIAL/u,
    ],
    [
      "hook matcher unknown field",
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "check" }], typo: true }],
        },
      },
      /hooks\.PreToolUse\.0\.typo.*unknown field/u,
    ],
    [
      "hook command unknown field",
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "check", shell: true }] }],
        },
      },
      /hooks\.PreToolUse\.0\.hooks\.0\.shell.*unknown field/u,
    ],
    [
      "MCP server unknown field",
      { mcp_servers: { docs: { command: "node", mystery: true } } },
      /mcp_servers\.docs\.mystery.*unknown field/u,
    ],
    [
      "operator-supplied MCP plugin sandbox metadata",
      {
        mcp_servers: {
          docs: {
            command: "node",
            pluginSandbox: {
              mode: "stdio-child-process",
              pluginName: "spoofed",
              pluginRoot: "/tmp",
              pluginDataDir: "/tmp/data",
              serverName: "docs",
              scopedServerName: "plugin:spoofed:docs",
            },
          },
        },
      },
      /mcp_servers\.docs\.pluginSandbox.*unknown field/u,
    ],
  ])("rejects %s", (_label, config, error) => {
    expect(() => validateAgenCConfigBlocks(malformed(config))).toThrow(error);
  });

  test.each([
    ["empty", ""],
    ["whitespace", "bad name"],
    ["tool-namespace delimiter", "bad.name"],
    ["terminal control", "bad\nname"],
    ["overlong", "a".repeat(257)],
  ])("rejects an %s MCP server name", (_label, serverName) => {
    expect(() =>
      validateAgenCConfigBlocks(
        malformed({
          mcp_servers: {
            [serverName]: { command: "node" },
          },
        }),
      ),
    ).toThrow(/Invalid mcp_servers: server name/u);
  });

  test("accepts canonical plugin-scoped MCP server names", () => {
    expect(
      validateAgenCConfigBlocks({
        mcp_servers: {
          "plugin:sample:local": { command: "node" },
        },
      }).mcp_servers,
    ).toHaveProperty("plugin:sample:local");
  });

  test("ordinary strict loading rejects the retired llm.xai surface", () => {
    expect(() =>
      validateStrictConfigDocument({
        config_version: 2,
        llm: { xai: { web_search: true } },
      }),
    ).toThrow(/unknown schema-v2 key: llm/u);
  });

  test("accepts every newly closed block and documented extension maps", () => {
    const config = validateAgenCConfigBlocks({
      shell_environment_policy: {
        set: { LANG: "en_CA.UTF-8" },
      },
      tools_config: {
        "system.bash": { default_permission_mode: "on-request" },
        web_search_endpoint: "https://search.example/api",
        web_search_endpoint_kind: "json",
        enabled_tools: ["system.bash"],
      },
      daemon: { autostart: true },
      lsp_servers: {
        ts: {
          command: "typescript-language-server",
          args: ["--stdio"],
          env: { NODE_ENV: "production" },
          extensionToLanguage: { ".ts": "typescript" },
          initializationOptions: { preferences: { quoteStyle: "single" } },
          startupTimeout: 10_000,
          maxRestarts: 0,
        },
      },
      attachments: { allowedRoots: ["/specs"] },
      tui: {
        theme: "dark",
        showTurnDuration: true,
        terminalProgressBarEnabled: true,
        copyOnSelect: true,
        flickerFreeMode: true,
        prStatusFooterEnabled: true,
      },
      durableTurns: {
        checkpoint: { enabled: true, minIntervalMs: 0 },
        resume: {
          onRestart: true,
          requireLease: true,
          buildPinning: true,
        },
      },
      budget: {
        enabled: true,
        daily_usd: 0,
        monthly_tokens: 1_000,
        soft_threshold: 0.8,
        enforce_interactive: false,
      },
      heartbeat: {
        enabled: true,
        interval_seconds: 60,
        active_hours: [8, 22],
        target_channel: "ops",
        target_conversation: "daily",
      },
      providers: {
        grok: {
          web_search: true,
          collections: {
            enabled: true,
            vector_store_ids: ["vs-1"],
            max_num_results: 5,
          },
          remote_mcp: {
            enabled: true,
            servers: [
              {
                server_url: "https://mcp.example",
                server_label: "docs",
                allowed_tools: ["search"],
                authorization_env: "AGENC_CREDENTIAL_DOCS_MCP",
              },
            ],
          },
        },
      },
      ideConnector: { autoInstallExtension: true },
      teammates: {
        mode: "auto",
        defaultModel: "grok-4.5",
        preferTmuxOverIterm2: false,
      },
      speculationEnabled: true,
      fileCheckpointingEnabled: true,
      sandbox: {
        network: {
          allowedDomains: ["api.example.com"],
          allowManagedDomainsOnly: true,
          httpProxyPort: 8_080,
        },
        filesystem: {
          allowWrite: ["/repo"],
          allowManagedReadPathsOnly: true,
        },
        ripgrep: { command: "rg", args: ["--hidden"] },
      },
    });

    expect(config.daemon).toEqual({ autostart: true });
    expect(config.durableTurns?.resume?.onRestart).toBe(true);
    expect(config.providers?.grok?.remote_mcp?.servers?.[0]?.server_label).toBe("docs");
    expect(config.providers?.grok?.remote_mcp?.servers?.[0]?.authorization_env).toBe(
      "AGENC_CREDENTIAL_DOCS_MCP",
    );
  });

  test("strict repository validation reports nested paths instead of accepting typed garbage", () => {
    expect(() =>
      validateStrictConfigDocument({
        config_version: 2,
        daemon: { autostart: "yes" },
      } as unknown as JsonRecord, "/tmp/config.toml"),
    ).toThrow(/invalid schema-v2 config.*daemon\.autostart.*expected boolean/u);
  });
});
