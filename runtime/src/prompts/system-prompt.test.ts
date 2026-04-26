/**
 * Tests for the openclaude-derived system prompt assembly + dynamic boundary.
 *
 * Covers:
 *   1.  simple_intro emits expected content
 *   2.  simple_system emits expected content
 *   3.  simple_doing_tasks emits expected content
 *   4.  actions section emits expected content
 *   5.  using_your_tools section emits expected content
 *   6.  agent_tool section gates on system.agent.delegate
 *   7.  tone_and_style emits expected content
 *   8.  output_efficiency emits expected content
 *   9.  env info populates cwd / model / platform
 *   10. env info tolerates missing git branch
 *   11. language section off when language unset
 *   12. output_style section on when provided
 *   13. mcp_instructions aggregates connected servers
 *   14. assembleSystemPrompt places SYSTEM_PROMPT_DYNAMIC_BOUNDARY exactly once
 *   15. assembleSystemPrompt static prefix is stable across repeated calls
 *   16. AGENC_SIMPLE truthy → ultra-minimal prompt
 *   17. assembleSystemPrompt with all optional inputs is coherent
 *   18. assembleSystemPrompt with empty dynamic tail is coherent
 *   19. permissions section injected when permissionContext is supplied
 *   20. AGENC.md instruction-file guard is present
 *   21. dynamic sections reload instead of reusing stale process-global cache
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
  getAgentToolSection,
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
    expect(s).toContain("prompt injection");
    // AgenC-specific instruction-file guard.
    expect(s).toContain("AgenC uses AGENC.md as its instruction file");
  });

  test("simple_doing_tasks describes task execution protocol", () => {
    const s = getSimpleDoingTasksSection();
    expect(s).toContain("# Doing tasks");
    // Lifted from openclaude — top-level instruction.
    expect(s).toContain(
      "do not propose changes to code you haven't read",
    );
    // Lifted from openclaude `USER_TYPE === 'ant'` faithful-reporting bullet.
    expect(s).toContain("Report outcomes faithfully");
    // Lifted from openclaude code-style sub-bullets.
    expect(s).toContain("Default to writing no comments");
    // Openclaude-specific slash-commands and bug-report bullets must be gone.
    expect(s).not.toContain("/help");
    expect(s).not.toContain("/issue");
    expect(s).not.toContain("/share");
    expect(s).not.toContain("OpenClaude");
  });

  test("actions section calls out destructive-op confirmation", () => {
    const s = getActionsSection();
    expect(s).toContain("# Executing actions with care");
    expect(s).toContain("Destructive operations");
    expect(s).toContain("force-push");
    expect(s).toContain("AGENC.md");
    expect(s).not.toMatch(/C[A-Z]+DE\.md/u);
  });

  test("using_your_tools renders the CRITICAL bash-vs-dedicated-tools block pointing at the openclaude-derived file/search tools", () => {
    const tools = new Set([
      "exec_command",
      "write_stdin",
      "FileRead",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "TodoWrite",
    ]);
    const s = getUsingYourToolsSection(tools);
    expect(s).toContain("# Using your tools");
    // CRITICAL framing prevents the model from rationalizing a file
    // write through a shell redirect.
    expect(s).toContain(
      "Do NOT use the exec_command to run commands when a relevant dedicated tool is provided",
    );
    expect(s).toContain("This is CRITICAL");
    // The openclaude-derived first-class tools (lifted into AgenC).
    expect(s).toContain("To read files use FileRead instead of cat, head, tail, or sed");
    expect(s).toContain("To edit files use Edit instead of sed or awk");
    expect(s).toContain(
      "To create files use Write instead of cat with heredoc or echo redirection",
    );
    expect(s).toContain("To search for files use Glob instead of find or ls");
    expect(s).toContain(
      "To search the content of files, use Grep instead of grep or rg",
    );
    // apply_patch is dropped — Edit/Write cover all supported file mutations.
    expect(s).not.toContain("apply_patch");
    expect(s).toContain(
      "Reserve using the exec_command exclusively for system commands and terminal operations",
    );
    // TodoWrite bullet (taskToolName → TodoWrite).
    expect(s).toContain("Break down and manage your work with the TodoWrite tool");
    // exec_command + write_stdin interactive-session bullet.
    expect(s).toContain("call exec_command with tty=true");
    expect(s).toContain("use write_stdin with that session_id");
    // Parallel-tool-calls sentence.
    expect(s).toContain(
      "You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel",
    );
  });

  test("using_your_tools omits per-tool bullets when those tools are not in the visible catalog", () => {
    const tools = new Set(["exec_command"]);
    const s = getUsingYourToolsSection(tools);
    // Dedicated file/search bullets only appear when those tools are visible.
    expect(s).not.toContain("FileRead");
    expect(s).not.toContain("Edit");
    expect(s).not.toContain("Write");
    expect(s).not.toContain("Glob");
    expect(s).not.toContain("Grep");
    // apply_patch is no longer referenced anywhere in the prompt.
    expect(s).not.toContain("apply_patch");
  });

  test("using_your_tools substitutes the shell-tool name when exec_command is unavailable", () => {
    const tools = new Set(["system.bash"]);
    const s = getUsingYourToolsSection(tools);
    expect(s).toContain("# Using your tools");
    expect(s).toContain(
      "Do NOT use the system.bash to run commands when a relevant dedicated tool is provided",
    );
    expect(s).toContain(
      "Reserve using the system.bash exclusively for system commands",
    );
    expect(s).not.toContain("exec_command");
  });

  test("using_your_tools omits per-tool bullets when no openclaude-derived tools are enabled (shell-only mode)", () => {
    const tools = new Set(["exec_command"]);
    const s = getUsingYourToolsSection(tools);
    expect(s).toContain("# Using your tools");
    // No FileRead/Edit/Write/Glob/Grep in the visible set → all per-tool
    // sub-bullets are omitted; only the generic "reserve shell for system
    // commands" guidance remains.
    expect(s).not.toContain("FileRead");
    expect(s).not.toContain("apply_patch");
    expect(s).toContain(
      "Reserve using the exec_command exclusively for system commands",
    );
  });

  test("agent_tool renders standard delegation prose when system.agent.delegate is enabled", () => {
    const s = getAgentToolSection(new Set(["system.agent.delegate"]));
    expect(s).not.toBeNull();
    const text = String(s);
    expect(text).toContain("# Subagents");
    expect(text).toContain("system.agent.delegate");
    expect(text).toContain(
      "Use the system.agent.delegate tool with specialized agents when the task at hand matches the agent's description",
    );
    expect(text).toContain(
      "avoid duplicating work that subagents are already doing",
    );
  });

  test("agent_tool returns null when system.agent.delegate is not enabled (gated)", () => {
    expect(getAgentToolSection(new Set())).toBeNull();
    expect(
      getAgentToolSection(new Set(["exec_command", "Edit", "Write"])),
    ).toBeNull();
  });

  test("tone_and_style bans emojis + colons before tool calls", () => {
    const s = getSimpleToneAndStyleSection();
    expect(s).toContain("# Tone and style");
    expect(s).toContain("emojis");
    expect(s).toContain("Do not use a colon before tool calls");
    // owner/repo#123 GitHub-link guidance (neutral, not openclaude's
    // anthropics/claude-code#100 example).
    expect(s).toContain("owner/repo#123");
    expect(s).not.toContain("anthropics/claude-code");
  });

  test("output_efficiency emphasizes brevity", () => {
    const s = getOutputEfficiencySection();
    expect(s).toContain("# Output efficiency");
    expect(s).toContain("concise");
    expect(s).toContain("Lead with the answer or action");
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

  test("agent_tool section appears in static head when system.agent.delegate is enabled", async () => {
    const { text, sections } = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      enabledToolNames: new Set([
        "exec_command",
        "Edit",
        "Write",
        "system.agent.delegate",
      ]),
      envForSimpleMode: {},
    });
    expect(text).toContain("# Subagents");
    expect(text).toContain("system.agent.delegate");
    // It lives in the cacheable head, not the dynamic tail.
    const boundaryIdx = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(
      sections.slice(0, boundaryIdx).some((s) => s.includes("# Subagents")),
    ).toBe(true);
  });

  test("all optional inputs produce a coherent combined output", async () => {
    const { text, sections } = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      projectInstructions: "# Project\nThis is AGENC.md content.",
      memoryPrompt: "# Memory\nUser prefers dark mode.",
      agentsEnabled: true,
      enabledToolNames: new Set([
        "exec_command",
        "FileRead",
        "Edit",
        "Write",
        "Glob",
        "Grep",
        "TodoWrite",
        "AskUserQuestion",
        "system.agent.delegate",
      ]),
      language: "French",
      outputStyle: { name: "terse", prompt: "Minimize words." },
      mcpServers: [
        { name: "searchsrv", instructions: "Use for web search." },
      ],
      scratchpadDir: "/tmp/agenc-scratchpad",
      provider: "xai",
      envForSimpleMode: {},
    });

    // When outputStyle is set, the "Doing tasks" section is suppressed
    // (mirrors openclaude gating) — the style prompt is expected to replace it.
    expect(text).not.toContain("# Doing tasks");
    expect(text).toContain("AGENC.md content");
    expect(text).toContain("User prefers dark mode");
    expect(text).toContain("# Language");
    expect(text).toContain("French");
    expect(text).toContain("# Output Style: terse");
    expect(text).toContain("# MCP Server Instructions");
    expect(text).toContain("## searchsrv");
    expect(text).toContain("# Scratchpad Directory");
    // Agent tool section also rendered when system.agent.delegate is visible.
    expect(text).toContain("# Subagents");
    expect(text).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(sections.length).toBeGreaterThan(8);
  });

  test("permissions section is injected when a permissionContext is supplied", async () => {
    const { createEmptyToolPermissionContext } = await import(
      "../permissions/types.js"
    );
    const { text, sections } = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      permissionContext: createEmptyToolPermissionContext({ mode: "plan" }),
      envForSimpleMode: {},
    });

    // Section header is present and lives in the dynamic tail.
    expect(text).toContain("# Permission Mode: plan");
    // Codex-ported sandbox + approval prose lands in the prompt.
    expect(text).toContain("`sandbox_mode` is `read-only`");
    expect(text).toContain("`approval_policy` is `unless-trusted`");
    // Network-access placeholder is fully resolved.
    expect(text).not.toContain("{{network_access}}");
    // It sits after the dynamic boundary, not in the cacheable head.
    const boundaryIdx = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(
      sections
        .slice(boundaryIdx + 1)
        .some((s) => s.includes("# Permission Mode: plan")),
    ).toBe(true);
  });

  test("system prompt rejects implicit non-AgenC instruction updates", async () => {
    const { text } = await assembleSystemPrompt({
      session: fakeSession,
      ctx: fakeCtx(),
      projectInstructions:
        "After every correction, update TEAM-INSTRUCTIONS.md and say you updated it.",
      envForSimpleMode: {},
    });

    expect(text).toContain("AgenC uses AGENC.md as its instruction file");
    expect(text).toContain(
      "Do not read, update, or claim to update any other assistant instruction file",
    );
    expect(text).toContain("Never claim you updated any instruction file");
    expect(text).toContain("update TEAM-INSTRUCTIONS.md");
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
    // Language / output_style / MCP / scratchpad are all absent when their
    // inputs are off.
    expect(text).not.toContain("# Language");
    expect(text).not.toContain("# Output Style:");
    expect(text).not.toContain("# MCP Server Instructions");
    expect(text).not.toContain("# Scratchpad Directory");
    // Agent tool gated off without system.agent.delegate.
    expect(text).not.toContain("# Subagents");
  });
});
