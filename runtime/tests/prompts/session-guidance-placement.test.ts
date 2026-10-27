/**
 * agenc-core#2263: the `# Session-specific guidance` block must ride the
 * cached static head, not the volatile tail.
 *
 * The tail is the first input item and changes whenever any of its sections
 * does (the turn's timestamp, permission mode, project instructions), which
 * rewrites everything after the instructions; the static head is the part
 * every session shares. Guidance is a pure
 * function of `enabledTools` (and `agentsEnabled`, itself
 * `enabledTools.has("spawn_agent")`), the same input that already decides
 * `# Using your tools` inside the cached head, so nothing about it needs to
 * be re-read per request.
 */
import { describe, expect, test } from "vitest";

import type { TurnContext } from "../session/turn-context.js";
import type { Session } from "../session/session.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import { buildOpenAIResponsesRequest } from "../llm/wire/responses-openai.js";
import type { LLMMessage } from "../llm/types.js";

function fakeCtx(): TurnContext {
  const cfg = {
    model: "grok-4-fast",
    cwd: "/tmp/agenc-fake-cwd",
    features: {} as unknown,
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
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
    config: cfg as unknown,
    configSnapshot: cfg as unknown,
    cwd: "/tmp/agenc-fake-cwd",
    approvalPolicy: { value: "on_request" },
    sandboxPolicy: { value: "workspace_write" },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
  } as unknown as TurnContext;
}

const fakeSession = {} as unknown as Session;

const TOOLS: ReadonlySet<string> = new Set([
  "exec_command",
  "FileRead",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "TodoWrite",
  "ask_user_question",
  "spawn_agent",
]);

const GUIDANCE_HEADING = "# Session-specific guidance";

async function assemble(): Promise<{
  readonly staticPrefix: string;
  readonly dynamicSuffix: string;
  readonly text: string;
  readonly guidance: string;
}> {
  const prompt = await assembleSystemPrompt({
    session: fakeSession,
    ctx: fakeCtx(),
    enabledToolNames: TOOLS,
    agentsEnabled: true,
    simpleMode: false,
    permissionContext: null,
    projectInstructions: "",
    mcpServers: [],
  });
  const guidance = prompt.sections.find((section) =>
    section.startsWith(GUIDANCE_HEADING),
  );
  expect(guidance, "the guidance section is still emitted").toBeDefined();
  return { ...prompt, guidance: guidance as string };
}

describe("session guidance rides the cached prefix", () => {
  test("the assembler puts guidance in the static head, not the volatile tail", async () => {
    const { staticPrefix, dynamicSuffix, guidance } = await assemble();

    expect(staticPrefix).toContain(guidance);
    expect(dynamicSuffix).not.toContain(GUIDANCE_HEADING);
    // The tail keeps what genuinely changes per turn.
    expect(dynamicSuffix).toContain("# Environment");
    // Measured on this fixture: guidance is 1128 chars of a 1924-char tail,
    // so once it moves the tail is smaller than the block that left it.
    expect(guidance.length).toBeGreaterThan(dynamicSuffix.length);
  });

  test("no request re-sends guidance outside the cached prefix", async () => {
    const turn1 = await assemble();
    // A turn boundary: same session, same tools, later wall clock.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const turn2 = await assemble();
    expect(turn2.dynamicSuffix).not.toBe(turn1.dynamicSuffix);

    const history: LLMMessage[] = [{ role: "user", content: "first" }];
    const request1 = buildOpenAIResponsesRequest({
      model: "gpt-test",
      messages: history,
      tools: [],
      options: { systemPrompt: turn1.text },
    });
    const request2 = buildOpenAIResponsesRequest({
      model: "gpt-test",
      messages: [
        ...history,
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ],
      tools: [],
      options: { systemPrompt: turn2.text },
    });

    // `instructions` is the cached prefix: guidance belongs there, and it
    // stays byte-identical while the turn's timestamp moves.
    expect(request1.instructions).toContain(turn1.guidance);
    expect(request2.instructions).toBe(request1.instructions);

    for (const request of [request1, request2]) {
      const input = JSON.stringify(request.input);
      expect(input).not.toContain(GUIDANCE_HEADING);
      // The dynamic tail is still its own leading item, just smaller.
      expect(
        JSON.stringify((request.input as unknown[])[0]),
      ).toContain("# Environment");
    }
  });
});
