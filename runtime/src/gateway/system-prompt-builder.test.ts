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
  it("includes the independent verifier rule in the main execution protocol", async () => {
    const prompt = await buildDefaultPersonalityPrompt();
    expect(prompt).toContain(
      "do not self-certify completion. Wait for independent verifier confirmation before claiming the implementation is done.",
    );
  });

  it("renders the post-refactor shape: task execution protocol + marketplace rules, no desktop or model disclosure", async () => {
    const prompt = await buildDefaultPersonalityPrompt();

    // Required sections for coding-workflow parity.
    expect(prompt).toContain("## Task Execution Protocol");
    expect(prompt).toContain("## Marketplace Tool Calling Rules");
    expect(prompt).toContain("### File modification: prefer editFile over writeFile");
    expect(prompt).toContain(
      "### Tool calls must be real tool calls, not narrated prose",
    );
    expect(prompt).toContain("### Report outcomes faithfully");
    expect(prompt).toContain(
      "BOTH `system.writeFile` (for existing files) AND `system.editFile` REQUIRE that you have called `system.readFile`",
    );

    // Sections deleted during the refactor must not reappear.
    expect(prompt).not.toMatch(/You have broad access to this machine via the system\.bash tool/);
    expect(prompt).not.toMatch(/DESKTOP AUTOMATION: You can control the entire macOS desktop/);
    expect(prompt).not.toMatch(/AVAILABLE ENVIRONMENTS:/);
    expect(prompt).not.toMatch(/\bPROVIDER\b.*\bMODEL\b/);
    expect(prompt).not.toMatch(/Current model:/i);
    expect(prompt).not.toMatch(/Current provider:/i);

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

    // Lock in the exact structural tail — task execution protocol
    // header, then the marketplace rules header. Changes to either
    // copy body are allowed, but the ordering + headers cannot drift
    // without updating this test deliberately.
    const tail = first.slice(first.indexOf("## Task Execution Protocol"));
    const headerOrder = [
      "## Task Execution Protocol",
      "### Report outcomes faithfully",
      "### File modification: prefer editFile over writeFile",
      "### Tool calls must be real tool calls, not narrated prose",
      "## Marketplace Tool Calling Rules",
    ];
    let cursor = 0;
    for (const header of headerOrder) {
      const index = tail.indexOf(header, cursor);
      expect(index).toBeGreaterThanOrEqual(cursor);
      cursor = index + header.length;
    }
  });
});
