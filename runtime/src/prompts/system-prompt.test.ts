/**
 * Tests for the 15-section system prompt assembly + dynamic boundary.
 *
 * Covers (≥15):
 *   1.  simple_intro emits expected content
 *   2.  simple_system emits expected content
 *   3.  simple_doing_tasks emits expected content
 *   4.  actions section emits expected content
 *   5.  using_your_tools section emits expected content
 *   6.  tone_and_style emits expected content
 *   7.  output_efficiency emits expected content
 *   8.  env info populates cwd / model / platform
 *   9.  env info tolerates missing git branch
 *   10. language section off when language unset
 *   11. output_style section on when provided
 *   12. mcp_instructions aggregates connected servers
 *   13. assembleSystemPrompt places SYSTEM_PROMPT_DYNAMIC_BOUNDARY exactly once
 *   14. assembleSystemPrompt static prefix is stable across repeated calls
 *   15. AGENC_SIMPLE truthy → ultra-minimal prompt
 *   16. assembleSystemPrompt with all optional inputs is coherent
 *   17. assembleSystemPrompt with empty dynamic tail is coherent
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { TurnContext } from "../session/turn-context.js";
import type { Session } from "../session/session.js";
import { clearSystemPromptSections } from "./sections.js";
import {
  assembleSystemPrompt,
  buildEnvInfoSection,
  getActionsSection,
  getLanguageSection,
  getMcpInstructionsSection,
  getOutputEfficiencySection,
  getOutputStyleSection,
  getSimpleDoingTasksSection,
  getSimpleIntroSection,
  getSimpleSystemSection,
  getSimpleToneAndStyleSection,
  getUsingYourToolsSection,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "./system-prompt.js";

// Minimal TurnContext + Session stubs — only the fields the assembler reads.
function fakeCtx(overrides?: Partial<TurnContext>): TurnContext {
  const cfg = {
    model: "grok-4-fast",
    cwd: "/tmp/agenc-fake-cwd",
    features: {} as unknown,
    multiAgentV2: { usageHintEnabled: false, usageHintText: "", hideSpawnAgentMetadata: false },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
  return {
    subId: "sub-test-1",
    realtimeActive: false,
    config: cfg as unknown,
    configSnapshot: cfg as unknown,
    modelInfo: {
      slug: "grok-4-fast",
      effectiveContextWindowPercent: 100,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "head",
      usedFallbackModelMetadata: false,
    },
    sessionTelemetry: {},
    provider: {} as unknown,
    reasoningSummary: "auto",
    sessionSource: "cli_main",
    cwd: "/tmp/agenc-fake-cwd",
    collaborationMode: { model: "grok-4-fast" },
    approvalPolicy: { value: "on_request" },
    sandboxPolicy: { value: "workspace_write" },
    fileSystemSandboxPolicy: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
    windowsSandboxLevel: "none",
    shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
    toolsConfig: { allowLoginShell: false, hasEnvironment: false },
    features: {
      appsEnabledForAuth: () => false,
      useLegacyLandlock: () => false,
    },
    ghostSnapshot: { enabled: false },
    toolCallGate: { isReady: () => true, signal: () => {}, wait: async () => {} } as unknown,
    truncationPolicy: "head",
    jsRepl: { id: "js-0" },
    dynamicTools: [],
    turnMetadataState: {} as unknown,
    turnSkills: {} as unknown,
    turnTimingState: {} as unknown,
    depth: 0,
    ...overrides,
  } as unknown as TurnContext;
}

const fakeSession = {} as unknown as Session;

describe("static section emitters", () => {
  test("simple_intro mentions AgenC + URL guardrail", () => {
    const s = getSimpleIntroSection(false);
    expect(s).toContain("AgenC");
    expect(s).toContain("software engineering tasks");
    expect(s).toContain("NEVER generate or guess URLs");
  });

  test("simple_intro switches wording when output style is set", () => {
    const withStyle = getSimpleIntroSection(true);
    const withoutStyle = getSimpleIntroSection(false);
    expect(withStyle).toContain(`"Output Style"`);
    expect(withoutStyle).not.toContain(`"Output Style"`);
  });

  test("simple_system has system heading + key rules", () => {
    const s = getSimpleSystemSection();
    expect(s.startsWith("# System")).toBe(true);
    expect(s).toContain("<system-reminder>");
    expect(s).toContain("prompt-injection");
  });

  test("simple_doing_tasks describes task execution protocol", () => {
    const s = getSimpleDoingTasksSection();
    expect(s).toContain("# Doing tasks");
    expect(s).toContain("Do not propose changes to code you have not read");
    expect(s).toContain("Report outcomes faithfully");
  });

  test("actions section calls out destructive-op confirmation", () => {
    const s = getActionsSection();
    expect(s).toContain("# Executing actions with care");
    expect(s).toContain("Destructive operations");
    expect(s).toContain("force-push");
  });

  test("using_your_tools surfaces Codex-primary exec/apply_patch guidance", () => {
    const tools = new Set([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "system.searchTools",
    ]);
    const s = getUsingYourToolsSection(tools);
    expect(s).toContain("# Using your tools");
    expect(s).toContain("apply_patch as the primary editing tool");
    expect(s).toContain("Use exec_command for terminal work");
    expect(s).toContain("exec_command with tty=true");
    expect(s).toContain("use write_stdin with that session_id");
    expect(s).toContain("parallel");
  });

  test("using_your_tools treats system.* file tools as compatibility tools", () => {
    const tools = new Set([
      "exec_command",
      "system.readFile",
      "system.editFile",
      "system.writeFile",
      "system.glob",
      "system.grep",
      "apply_patch",
    ]);
    const s = getUsingYourToolsSection(tools);
    expect(s).toContain("Use system.writeFile/system.editFile only as AgenC compatibility tools");
    expect(s).toContain("Normal code changes should go through apply_patch");
    expect(s).toContain("Use exec_command for terminal work");
    expect(s).toContain("Do not answer with only proposed code or prose");
  });

  test("using_your_tools falls back to shell guidance when exec_command is unavailable", () => {
    const tools = new Set(["system.bash"]);
    const s = getUsingYourToolsSection(tools);
    expect(s).toContain("# Using your tools");
    expect(s).toContain("Use the shell/bash tool for terminal work");
    expect(s).not.toContain("Use exec_command for terminal work");
  });

  test("using_your_tools omits edit guidance without apply_patch", () => {
    const tools = new Set(["Read", "Edit"]);
    const s = getUsingYourToolsSection(tools);
    expect(s).toContain("# Using your tools");
    expect(s).not.toContain("primary editing tool");
  });

  test("tone_and_style bans emojis + colons before tool calls", () => {
    const s = getSimpleToneAndStyleSection();
    expect(s).toContain("# Tone and style");
    expect(s).toContain("emojis");
    expect(s).toContain("Do not use a colon before tool calls");
  });

  test("output_efficiency emphasizes brevity", () => {
    const s = getOutputEfficiencySection();
    expect(s).toContain("# Output efficiency");
    expect(s).toContain("concise");
  });
});

describe("dynamic section emitters", () => {
  test("language section off when no language set", () => {
    expect(getLanguageSection(undefined)).toBeNull();
    expect(getLanguageSection("")).toBeNull();
    const s = getLanguageSection("German");
    expect(s).toContain("# Language");
    expect(s).toContain("German");
  });

  test("output_style section wraps prompt with header", () => {
    expect(getOutputStyleSection(null)).toBeNull();
    const s = getOutputStyleSection({
      name: "concise",
      prompt: "Be brief and to the point.",
    });
    expect(s).toContain("# Output Style: concise");
    expect(s).toContain("Be brief and to the point.");
  });

  test("mcp_instructions aggregates connected servers, drops empty", () => {
    expect(getMcpInstructionsSection(undefined)).toBeNull();
    expect(getMcpInstructionsSection([])).toBeNull();
    expect(
      getMcpInstructionsSection([{ name: "empty", instructions: "" }]),
    ).toBeNull();
    const s = getMcpInstructionsSection([
      { name: "alpha", instructions: "do alpha things" },
      { name: "beta", instructions: "do beta things" },
    ]);
    expect(s).toContain("# MCP Server Instructions");
    expect(s).toContain("## alpha");
    expect(s).toContain("## beta");
    expect(s).toContain("do alpha things");
  });
});

describe("env info section", () => {
  let tmpDir = "";
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agenc-envinfo-"));
  });
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  test("env info includes cwd, model, platform", () => {
    const s = buildEnvInfoSection({
      model: "grok-4-fast",
      provider: "xai",
      cwd: tmpDir,
    });
    expect(s).toContain("# Environment");
    expect(s).toContain(tmpDir);
    expect(s).toContain("grok-4-fast");
    expect(s).toContain("xai");
    expect(s).toContain("Platform:");
    expect(s).toContain("OS:");
    expect(s).toContain("Current time (UTC):");
  });

  test("env info tolerates a non-git cwd", () => {
    // tmpDir is a fresh mkdtemp, no .git in it — branch resolution must fail
    // gracefully.
    const s = buildEnvInfoSection({
      model: "grok-4-fast",
      cwd: tmpDir,
    });
    expect(s).toContain("Git branch: <not a git repository>");
  });
});

describe("assembleSystemPrompt", () => {
  afterEach(() => {
    clearSystemPromptSections();
    delete process.env.AGENC_SIMPLE;
  });

  test("places SYSTEM_PROMPT_DYNAMIC_BOUNDARY exactly once", async () => {
    const { text, sections } = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      envForSimpleMode: {},
    });
    const matches = text.match(
      new RegExp(
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "g",
      ),
    );
    expect(matches?.length).toBe(1);
    expect(sections).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    const boundaryIdx = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    // Static prefix contains the intro; dynamic tail contains env info.
    expect(sections.slice(0, boundaryIdx).some((s) => s.includes("AgenC"))).toBe(
      true,
    );
    expect(
      sections.slice(boundaryIdx + 1).some((s) => s.startsWith("# Environment")),
    ).toBe(true);
  });

  test("static prefix is stable across repeated calls (prompt-cache safe)", async () => {
    const opts = {
      session: fakeSession,
      ctx: fakeCtx(),
      envForSimpleMode: {},
    } as const;

    const first = await assembleSystemPrompt(opts);
    const second = await assembleSystemPrompt(opts);

    const boundaryIdxFirst = first.sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    const boundaryIdxSecond = second.sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    expect(boundaryIdxFirst).toBe(boundaryIdxSecond);
    expect(first.sections.slice(0, boundaryIdxFirst)).toEqual(
      second.sections.slice(0, boundaryIdxSecond),
    );
  });

  test("AGENC_SIMPLE truthy → ultra-minimal prompt", async () => {
    const { sections } = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      envForSimpleMode: { AGENC_SIMPLE: "1" },
    });
    // simple_intro + boundary + env_info_simple only.
    expect(sections.length).toBe(3);
    expect(sections[0]).toContain("AgenC");
    expect(sections[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(sections[2]).toContain("# Environment");
  });

  test("all optional inputs produce a coherent combined output", async () => {
    const { text, sections } = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      projectInstructions: "# Project\nThis is AGENTS.md content.",
      memoryPrompt: "# Memory\nUser prefers dark mode.",
      agentsEnabled: true,
      enabledToolNames: new Set(["Bash", "Read", "Edit", "AskUserQuestion"]),
      language: "French",
      outputStyle: { name: "terse", prompt: "Minimize words." },
      mcpServers: [
        { name: "searchsrv", instructions: "Use for web search." },
      ],
      scratchpadDir: "/tmp/agenc-scratchpad",
      functionResultClearingEnabled: true,
      numericLengthAnchors: true,
      tokenBudgetEnabled: true,
      summarizeToolResults: true,
      provider: "xai",
      envForSimpleMode: {},
    });

    // When outputStyle is set, the "Doing tasks" section is suppressed
    // (mirrors openclaude gating) — the style prompt is expected to replace it.
    expect(text).not.toContain("# Doing tasks");
    expect(text).toContain("AGENTS.md content");
    expect(text).toContain("User prefers dark mode");
    expect(text).toContain("# Language");
    expect(text).toContain("French");
    expect(text).toContain("# Output Style: terse");
    expect(text).toContain("# MCP Server Instructions");
    expect(text).toContain("## searchsrv");
    expect(text).toContain("# Scratchpad Directory");
    expect(text).toContain("# Function Result Clearing");
    expect(text).toContain("Length limits");
    expect(text).toContain("token target");
    expect(text).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(sections.length).toBeGreaterThan(10);
  });

  test("dynamic sections reload instead of reusing stale process-global cache", async () => {
    const first = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      projectInstructions: "PROJECT-ONE",
      memoryPrompt: "MEMORY-ONE",
      mcpServers: [{ name: "alpha", instructions: "ALPHA" }],
      envForSimpleMode: {},
    });
    const second = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      projectInstructions: "PROJECT-TWO",
      memoryPrompt: "MEMORY-TWO",
      mcpServers: [{ name: "beta", instructions: "BETA" }],
      envForSimpleMode: {},
    });

    expect(first.text).toContain("PROJECT-ONE");
    expect(first.text).toContain("MEMORY-ONE");
    expect(first.text).toContain("## alpha");
    expect(second.text).toContain("PROJECT-TWO");
    expect(second.text).toContain("MEMORY-TWO");
    expect(second.text).toContain("## beta");
    expect(second.text).not.toContain("PROJECT-ONE");
    expect(second.text).not.toContain("MEMORY-ONE");
    expect(second.text).not.toContain("## alpha");
  });

  test("no optional inputs → coherent minimal prompt (doing_tasks present, tail has env only)", async () => {
    const { text, sections } = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      envForSimpleMode: {},
    });

    expect(text).toContain("# Doing tasks");
    expect(text).toContain("# System");
    expect(text).toContain("# Tone and style");
    expect(text).toContain("# Output efficiency");
    expect(text).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    // Tail should at minimum have env_info_simple.
    const boundaryIdx = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    const tail = sections.slice(boundaryIdx + 1);
    expect(tail.some((s) => s.startsWith("# Environment"))).toBe(true);
    // Language / output_style / MCP / scratchpad / frc / numeric / token /
    // brief / summarize are all absent when their inputs are off.
    expect(text).not.toContain("# Language");
    expect(text).not.toContain("# Output Style:");
    expect(text).not.toContain("# MCP Server Instructions");
    expect(text).not.toContain("# Scratchpad Directory");
  });
});
