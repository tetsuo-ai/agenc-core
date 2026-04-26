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
  getAmbitionVsPrecisionSection,
  getEditingConstraintsSection,
  getFinalAnswerVerbositySection,
  getFrontendTasksSection,
  getLanguageSection,
  getMcpInstructionsSection,
  getOrchestrationSection,
  getOutputEfficiencySection,
  getOutputStyleSection,
  getResponsivenessSection,
  getSimpleDoingTasksSection,
  getSimpleIntroSection,
  getSimpleSystemSection,
  getSimpleToneAndStyleSection,
  getToolGuidelinesSection,
  getUsingYourToolsSection,
  getValidatingYourWorkSection,
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

  test("using_your_tools renders the CRITICAL bash-vs-dedicated-tools block pointing at the openclaude-derived file/search tools", () => {
    const tools = new Set([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "FileRead",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "TodoWrite",
      "system.searchTools",
    ]);
    const s = getUsingYourToolsSection(tools);
    expect(s).toContain("# Using your tools");
    // CRITICAL framing prevents the model from rationalizing a file
    // write through a shell redirect.
    expect(s).toContain(
      "Do NOT use the exec_command to run commands when a relevant dedicated tool is provided",
    );
    expect(s).toContain("This is CRITICAL");
    // The new openclaude-derived first-class tools (lifted into AgenC).
    // FileRead/Edit/Write/Glob/Grep replace the previous deferred
    // `system.readFile`/`system.editFile`/`system.writeFile`/`system.glob`/
    // `system.grep` mentions — they're now visible by default in
    // tool-registry.ts.
    expect(s).toContain("To read files use FileRead instead of cat, head, tail, or sed");
    expect(s).toContain("To edit files use Edit instead of sed or awk");
    expect(s).toContain(
      "To create files use Write instead of cat with heredoc or echo redirection",
    );
    expect(s).toContain("To search for files use Glob instead of find or ls");
    expect(s).toContain(
      "To search the content of files, use Grep instead of grep or rg",
    );
    // apply_patch becomes the rare-case multi-file atomic-patch tool.
    expect(s).toContain("For multi-file atomic patches");
    expect(s).toContain("apply_patch");
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
    // No FileRead/Edit/Write/Glob/Grep, only legacy deferred system.*
    // (which the prompt no longer references — the model can't see them
    // by default, so prompting their use is the original visibility-mismatch
    // bug we fixed).
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
    // The deferred system.* tools should NOT appear in the prompt anymore.
    expect(s).not.toContain("system.readFile");
    expect(s).not.toContain("system.editFile");
    expect(s).not.toContain("system.writeFile");
    expect(s).not.toContain("system.glob");
    expect(s).not.toContain("system.grep");
    // apply_patch is still mentioned (it IS visible in this set).
    expect(s).toContain("apply_patch");
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
    // No FileRead/Edit/Write/Glob/Grep/apply_patch in the visible set →
    // all per-tool sub-bullets are omitted; only the generic "reserve
    // shell for system commands" guidance remains.
    expect(s).not.toContain("FileRead");
    expect(s).not.toContain("apply_patch");
    expect(s).toContain(
      "Reserve using the exec_command exclusively for system commands",
    );
  });

  test("editing_constraints renders codex gpt-5.4 ## Editing constraints verbatim when apply_patch is enabled", () => {
    const tools = new Set(["apply_patch", "exec_command"]);
    const s = getEditingConstraintsSection(tools);
    expect(s).not.toBeNull();
    const text = String(s);
    expect(text).toContain("## Editing constraints");
    // Verbatim line from codex gpt-5.4 base_instructions:31 — the rule that
    // would have prevented the model from using `cat >> docs/feature-matrix.md`
    // in the failing scrollback session.
    expect(text).toContain(
      "Always use apply_patch for manual code edits. Do not use cat or any other commands when creating or editing files",
    );
    expect(text).toContain(
      "Do not use Python to read/write files when a simple shell command or apply_patch would suffice",
    );
    expect(text).toContain("You may be in a dirty git worktree");
    // Nested dirty-worktree sub-bullets (rendered via prependBullets nesting).
    expect(text).toContain(
      "NEVER revert existing changes you did not make unless explicitly requested",
    );
    expect(text).toContain(
      "**NEVER** use destructive commands like `git reset --hard`",
    );
    expect(text).toContain("**ALWAYS** prefer using non-interactive git commands");
  });

  test("editing_constraints returns null without apply_patch (gated)", () => {
    expect(getEditingConstraintsSection(new Set(["exec_command"]))).toBeNull();
  });

  test("tool_guidelines renders codex gpt-5.2 # Tool Guidelines verbatim when shell + apply_patch are enabled", () => {
    const tools = new Set(["exec_command", "apply_patch"]);
    const s = getToolGuidelinesSection(tools);
    expect(s).not.toBeNull();
    const text = String(s);
    expect(text).toContain("# Tool Guidelines");
    expect(text).toContain("## Shell commands");
    // Codex gpt-5.2 base_instructions:250 — verbatim.
    expect(text).toContain(
      "When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster",
    );
    expect(text).toContain(
      "Do not use python scripts to attempt to output larger chunks of a file",
    );
    // The codex `multi_tool_use.parallel` reference is adapted to AgenC's
    // parallel mechanism (multiple tool calls in the same assistant message).
    expect(text).toContain("Make multiple tool calls in the same assistant message");
    expect(text).toContain("## apply_patch");
    expect(text).toContain("*** Begin Patch");
    expect(text).toContain("*** End Patch");
    expect(text).toContain("*** Add File:");
    expect(text).toContain("*** Delete File:");
    expect(text).toContain("*** Update File:");
    expect(text).toContain("You must include a header with your intended action");
  });

  test("tool_guidelines drops apply_patch subsection when apply_patch is unavailable", () => {
    const s = getToolGuidelinesSection(new Set(["exec_command"]));
    expect(s).not.toBeNull();
    const text = String(s);
    expect(text).toContain("# Tool Guidelines");
    expect(text).toContain("## Shell commands");
    expect(text).not.toContain("## apply_patch");
  });

  test("tool_guidelines returns null when no shell and no apply_patch", () => {
    expect(getToolGuidelinesSection(new Set())).toBeNull();
  });

  test("responsiveness renders codex gpt-5.2 ## Responsiveness header verbatim", () => {
    const s = getResponsivenessSection();
    expect(s).toContain("## Responsiveness");
    // Codex gpt-5.2 publishes the heading with no body — mirror that exactly.
    expect(s.trim()).toBe("## Responsiveness");
  });

  test("validating_your_work renders codex gpt-5.2 ## Validating your work verbatim", () => {
    const s = getValidatingYourWorkSection();
    expect(s).toContain("## Validating your work");
    // Verbatim line from codex gpt-5.2 base_instructions:138.
    expect(s).toContain(
      "If the codebase has tests, or the ability to build or run tests, consider using them to verify changes once your work is complete.",
    );
    // Verbatim line from codex gpt-5.2 base_instructions:140.
    expect(s).toContain(
      "When testing, your philosophy should be to start as specific as possible to the code you changed",
    );
    // The non-interactive vs interactive bullet pair.
    expect(s).toContain(
      "When running in non-interactive approval modes like **never** or **on-failure**",
    );
    expect(s).toContain(
      "When working in interactive approval modes like **untrusted**, or **on-request**",
    );
  });

  test("ambition_vs_precision renders codex gpt-5.2 ## Ambition vs. precision verbatim", () => {
    const s = getAmbitionVsPrecisionSection();
    expect(s).toContain("## Ambition vs. precision");
    // Verbatim line from codex gpt-5.2 base_instructions:154.
    expect(s).toContain(
      "For tasks that have no prior context (i.e. the user is starting something brand new), you should feel free to be ambitious and demonstrate creativity with your implementation.",
    );
    // Verbatim line from codex gpt-5.2 base_instructions:156 — surgical precision rule.
    expect(s).toContain(
      "If you're operating in an existing codebase, you should make sure you do exactly what the user asks with surgical precision.",
    );
    expect(s).toContain("gold-plating");
  });

  test("frontend_tasks renders codex gpt-5.4 ## Frontend tasks verbatim", () => {
    const s = getFrontendTasksSection();
    expect(s).toContain("## Frontend tasks");
    // Verbatim opening line from codex gpt-5.4 base_instructions:55.
    expect(s).toContain(
      `When doing frontend design tasks, avoid collapsing into "AI slop" or safe, average-looking layouts.`,
    );
    // Bullet content checks — each major bullet from upstream.
    expect(s).toContain(
      "Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).",
    );
    expect(s).toContain("avoid purple-on-white defaults");
    expect(s).toContain("useEffectEvent, startTransition, and useDeferredValue");
    // Verbatim closing exception from codex gpt-5.4 base_instructions:65.
    expect(s).toContain(
      "Exception: If working within an existing website or design system, preserve the established patterns, structure, and visual language.",
    );
  });

  test("final_answer_verbosity renders codex gpt-5.2 **Verbosity** block verbatim", () => {
    const s = getFinalAnswerVerbositySection();
    expect(s).toContain("**Verbosity**");
    // Verbatim line from codex gpt-5.2 base_instructions:227 — the
    // tiny/small change compactness rule.
    expect(s).toContain(
      "Tiny/small single-file change (≤ ~10 lines): 2–5 sentences or ≤3 bullets.",
    );
    expect(s).toContain("Medium change (single area or a few files): ≤6 bullets");
    expect(s).toContain("Large/multi-file change: Summarize per file with 1–2 bullets");
    // Verbatim never-do clause from codex gpt-5.2 base_instructions:230.
    expect(s).toContain(
      `Never include "before/after" pairs, full method bodies, or large/scrolling code blocks in the final message.`,
    );
  });

  test("orchestration renders codex orchestrator.md verbatim when system.agent.delegate is enabled", () => {
    const tools = new Set(["system.agent.delegate"]);
    const s = getOrchestrationSection(tools);
    expect(s).not.toBeNull();
    const text = String(s);
    expect(text).toContain("## Orchestration");
    // Verbatim opening bullet from orchestrator.md:1.
    expect(text).toContain(
      "If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as `date`), you should do so.",
    );
    // Verbatim co-builder bullet from orchestrator.md:2.
    expect(text).toContain(
      "Treat the user as an equal co-builder; preserve the user's intent and coding style rather than rewriting everything.",
    );
    // User Updates Spec sub-section from orchestrator.md:7-9.
    expect(text).toContain("### User Updates Spec");
    expect(text).toContain("heads‑down note");
    // Reviews section from orchestrator.md:19-21.
    expect(text).toContain("# Reviews");
    expect(text).toContain(
      "When the user asks for a review, you default to a code-review mindset.",
    );
    // General guidelines closing block from orchestrator.md:37-43.
    expect(text).toContain("## General guidelines");
    expect(text).toContain(
      "Prefer multiple sub-agents to parallelize your work.",
    );
    expect(text).toContain("**wait for them before yielding**");
  });

  test("orchestration returns null when system.agent.delegate is not enabled (gated)", () => {
    expect(getOrchestrationSection(new Set())).toBeNull();
    expect(getOrchestrationSection(new Set(["exec_command", "apply_patch"]))).toBeNull();
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
      projectInstructions: "# Project\nThis is AGENC.md content.",
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
    expect(text).toContain("AGENC.md content");
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
    // Language / output_style / MCP / scratchpad / frc / numeric / token /
    // brief / summarize are all absent when their inputs are off.
    expect(text).not.toContain("# Language");
    expect(text).not.toContain("# Output Style:");
    expect(text).not.toContain("# MCP Server Instructions");
    expect(text).not.toContain("# Scratchpad Directory");
  });
});
