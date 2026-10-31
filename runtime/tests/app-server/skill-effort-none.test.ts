/**
 * `effort: none` in a skill's SKILL.md is the documented opt-out. It reaches
 * the turn a user starts with `$name` through the real path: the skill
 * loader, the TUI's command and invocation settings, the daemon's admission,
 * and the request the OpenAI provider sends.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { admitSkillInvocation } from "../../src/app-server/background-agent-runner/skill-invocation.js";
import { clearCommandMemoizationCaches, getCommands } from "../../src/commands.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import type { LLMTool } from "../../src/llm/types.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { createLocalSkillsServices } from "../../src/skills/local-loader.js";
import { loadDollarSkillCommandForTurn } from "../../src/tui/input/dollar-skill-command.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import {
  deepSeekSkillTurnSession,
  removeSkillTurnHomes,
} from "../helpers/skill-turn-session.js";

const roots: string[] = [];

afterEach(async () => {
  clearCommandMemoizationCaches();
  removeSkillTurnHomes();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The settings the TUI sends when the user runs `$<name>` for a skill in AGENC_HOME/skills. */
async function tuiSkillInvocation(name: string, frontmatter: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "agenc-skill-effort-none-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, "skills", name), { recursive: true });
  await writeFile(join(home, "skills", name, "SKILL.md"), [
    "---",
    `description: The ${name} skill.`,
    ...frontmatter,
    "---",
    "Answer briefly.",
    "",
  ].join("\n"));
  const pluginStorageRoot = join(home, "plugins");
  const services = createLocalSkillsServices({ agencHome: home, pluginStorageRoot, workspaceRoot: root });
  const command = (await getCommands(root, { pluginStorageRoot, skillsManager: services.skillsManager }))
    .find((candidate) => candidate.name === name);
  if (command?.type !== "prompt") throw new Error(`the TUI does not list ${name} as a prompt command`);
  const loaded = await loadDollarSkillCommandForTurn(
    { name, args: "" } as never,
    command,
    { setAppState: vi.fn() } as never,
  );
  return loaded.skillInvocation;
}

function completedResponse(): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      model: "gpt-5.6-sol",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("a skill's effort: none", () => {
  test("an effort-only skill brings its opt-out to the turn and the wire", async () => {
    const invocation = await tuiSkillInvocation("quiet-review", ["effort: none"]);
    expect(invocation).toEqual({ name: "quiet-review", source: "userSettings", effort: "none" });

    // A GPT-5.6 Sol session at high, a model that takes `none`.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => completedResponse());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: "gpt-5.6-sol", fetchImpl });
    const session = deepSeekSkillTurnSession({
      route: {
        provider,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        supportedReasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
        contextWindow: 400_000,
        providerEnvironment: { OPENAI_API_KEY: "sk-test" },
      },
    });
    const store = session.services.configStore!;
    await store.reload();
    const admitted = await runWithCanonicalSettingsAuthority(store, () =>
      admitSkillInvocation(session, store, invocation!),
    );
    const turn = session.newSkillInvocationTurn(admitted.overrides);
    expect(turn.reasoningEffort).toBe("none");

    await runWithCanonicalSettingsAuthority(store, async () => {
      const options = buildProviderOptions(
        {
          input: [{ role: "user", content: "hi" }],
          tools: [] as LLMTool[],
          parallelToolCalls: false,
          baseInstructions: "",
        } as never,
        turn,
        new AbortController().signal,
        session,
      );
      await session.services.provider.chat([{ role: "user", content: "hi" }], options);
    });
    const body = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body)) as {
      readonly model?: string;
      readonly reasoning?: { readonly effort?: string };
    };
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning?.effort).toBe("none");
  });

  test("the loader keeps none next to the other settings", async () => {
    const invocation = await tuiSkillInvocation("quiet-write", [
      "effort: none",
      "allowed-tools: Write",
    ]);
    expect(invocation).toEqual({
      name: "quiet-write",
      source: "userSettings",
      effort: "none",
      allowedTools: ["Write"],
    });
  });
});
