import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import type {
  AgenCBackgroundAgentStartParams,
  AgenCBackgroundAgentStartResult,
} from "../../src/app-server/background-agent-runner.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

// The one-shot CLI sends a text-only prompt as objective, instructions and
// initialContent. The daemon keeps a trimmed objective for the agent record,
// and the runner sends `initialContent ?? objective` as the first user
// message, so initialContent must arrive byte for byte.
const prompt = "  keep this indentation\n\tand the final newline\n";
const started: AgenCBackgroundAgentStartResult = {
  agentId: "exact-prompt-agent",
  status: "running",
  startedAt: "2026-09-15T00:00:00.000Z",
};

async function startAgentWith(params: {
  readonly objective: string;
  readonly instructions: string;
  readonly initialContent?: string;
}): Promise<AgenCBackgroundAgentStartParams> {
  const agencHome = mkdtempSync(join(tmpdir(), "agenc-initial-content-"));
  let captured: AgenCBackgroundAgentStartParams | undefined;
  const manager = new AgenCDaemonAgentManager({
    agencHome,
    runner: {
      startAgent: async (request) => {
        captured = request;
        return started;
      },
      stopAgent: async () => {},
    },
  });
  try {
    await manager.createAgent({
      ...params,
      cwd: agencHome,
      runtimeOptions: resolveAgentRuntimeOptions({}),
    });
    expect(captured).toBeDefined();
    return captured!;
  } finally {
    rmSync(agencHome, { recursive: true, force: true });
  }
}

describe("agent.create first user message", () => {
  it("keeps initialContent byte for byte while the objective is trimmed", async () => {
    const request = await startAgentWith({
      objective: prompt,
      instructions: prompt,
      initialContent: prompt,
    });
    expect(request.objective).toBe(prompt.trim());
    expect(request.initialContent).toBe(prompt);
    expect(request.initialContent ?? request.objective).toBe(prompt);
  });

  it("still sends the trimmed objective when initialContent is absent", async () => {
    const request = await startAgentWith({
      objective: prompt,
      instructions: prompt,
    });
    expect(request.initialContent).toBeUndefined();
    expect(request.initialContent ?? request.objective).toBe(prompt.trim());
  });

  it("still rejects a whitespace-only objective", async () => {
    await expect(
      startAgentWith({ objective: " \n\t\n", instructions: " \n\t\n" }),
    ).rejects.toThrow("non-empty objective");
  });
});
