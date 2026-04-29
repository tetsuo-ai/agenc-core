import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildBaseSystemPrompt } from "./system-prompt-builder.js";
import type { GatewayConfig } from "./types.js";
import type { Logger } from "../utils/logger.js";

const createdRoots: string[] = [];
const silentLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createWorkspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-prompt-"));
  createdRoots.push(root);
  return root;
}

async function buildDefaultPersonalityPrompt(overrides?: {
  forVoice?: boolean;
}): Promise<string> {
  const workspaceRoot = createWorkspaceRoot();
  return buildBaseSystemPrompt(
    {
      workspace: { hostPath: workspaceRoot },
    } as GatewayConfig,
    {
      yolo: false,
      configPath: join(workspaceRoot, "config.json"),
      logger: silentLogger,
    },
    overrides,
  );
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

describe("buildBaseSystemPrompt", () => {
  it("keeps the core execution-protocol instructions: tool authority, trust prior results, faithful reporting, read-before-write", async () => {
    const prompt = await buildDefaultPersonalityPrompt();

    // The slim protocol keeps five load-bearing ideas. Each is
    // checked as a substring so body copy can evolve without
    // tripping the test, but the instruction must be present.
    expect(prompt).toContain("Do real tool calls");
    expect(prompt).toContain("Trust prior tool results");
    expect(prompt).toContain("End the turn when the answer is ready");
    expect(prompt).toContain("Report outcomes faithfully");
    expect(prompt).toContain(
      "Read-before-Write rule applies to both on paths that already exist",
    );
  });

  it("renders the post-refactor shape: task execution protocol + marketplace rules, no desktop or model disclosure", async () => {
    const prompt = await buildDefaultPersonalityPrompt();

    // Required top-level sections for coding-workflow parity.
    expect(prompt).toContain("## Task Execution Protocol");
    expect(prompt).toContain("## Marketplace Tool Calling Rules");

    // Sections deleted during the refactor must not reappear.
    expect(prompt).not.toMatch(/You have broad access to this machine via the system\.bash tool/);
    expect(prompt).not.toMatch(/DESKTOP AUTOMATION: You can control the entire macOS desktop/);
    expect(prompt).not.toMatch(/AVAILABLE ENVIRONMENTS:/);
    expect(prompt).not.toMatch(/\bPROVIDER\b.*\bMODEL\b/);
    expect(prompt).not.toMatch(/Current model:/i);
    expect(prompt).not.toMatch(/Current provider:/i);

    // The old numbered-rules block with the 270-line defensive
    // accretion must not reappear. The prompt rewrite replaced it
    // with a short balanced instruction set.
    expect(prompt).not.toContain("The user has pre-authorized continuation");
    expect(prompt).not.toContain(
      "### Independent verification before reporting completion",
    );
    expect(prompt).not.toContain("delegationAdmission.verifierObligations");

    // Hard size ceiling from MAX_SYSTEM_PROMPT_CHARS.
    expect(prompt.length).toBeLessThan(60_000);

    // Structural sanity: protocol section must land before the
    // marketplace rules, so the base personality block (if any) comes
    // before both of these trailing instruction sections.
    expect(prompt.indexOf("## Task Execution Protocol")).toBeLessThan(
      prompt.indexOf("## Marketplace Tool Calling Rules"),
    );
  });

  it("emits a voice-mode prompt that uses the Execution Style preamble and suppresses the task protocol", async () => {
    const prompt = await buildDefaultPersonalityPrompt({ forVoice: true });
    expect(prompt).toContain("## Execution Style");
    expect(prompt).toContain("Execute tasks immediately without narrating your plan.");
    expect(prompt).not.toContain("## Task Execution Protocol");
    expect(prompt).toContain("## Marketplace Tool Calling Rules");
  });

  it("stays byte-stable across consecutive calls with the same config (snapshot of trailing injection sections)", async () => {
    const workspaceRoot = createWorkspaceRoot();
    const config = {
      workspace: { hostPath: workspaceRoot },
    } as GatewayConfig;
    const opts = {
      yolo: false,
      configPath: join(workspaceRoot, "config.json"),
      logger: silentLogger,
    };

    const first = await buildBaseSystemPrompt(config, opts);
    const second = await buildBaseSystemPrompt(config, opts);
    expect(second).toBe(first);

    // Lock in the two top-level section headers in order. The slim
    // protocol body intentionally no longer splits into subheadings;
    // the body is a sequence of short instruction paragraphs so the
    // model reads it as one coherent block instead of indexing into
    // individual rules (which was the pattern that produced the 270-
    // line defensive accretion we just removed).
    const taskIdx = first.indexOf("## Task Execution Protocol");
    const marketIdx = first.indexOf("## Marketplace Tool Calling Rules");
    expect(taskIdx).toBeGreaterThanOrEqual(0);
    expect(marketIdx).toBeGreaterThan(taskIdx);
  });
});
