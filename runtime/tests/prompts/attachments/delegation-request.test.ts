/**
 * The Light helper-request reminder (prompts/attachments/delegation-request.ts): only a Light root turn that asks for
 * helpers, while spawn_agent is in the catalog but not loaded, carries it; every other turn carries nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { LLMTool } from "../../llm/types.js";
import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import { updateSettingsForSource } from "../../utils/settings/settings.js";
import {
  DELEGATION_REQUEST_REMINDER,
  delegationRequestProducer,
} from "./delegation-request.js";
import { attachmentsToMessages } from "./messages.js";
import { getAttachments, type GetAttachmentsOptions } from "./orchestrator.js";

const HELPERS =
  "Please do these two independent checks in parallel using two helpers.\n" +
  "Helper one: read alpha.txt and report its number.\n" +
  "Helper two: read beta.txt and report its number.\n" +
  "Do not change files. Wait for both helpers and report both results.";
const ORDINARY = "Read alpha.txt and beta.txt and report their numbers.";

function tool(name: string): LLMTool {
  return { type: "function", function: { name, description: name, parameters: { type: "object" } } };
}
const LIGHT_TOOLS = [tool("system.searchTools"), tool("exec_command"), tool("FileRead")];
const CATALOG = new Set(["system.searchTools", "exec_command", "FileRead", "spawn_agent", "wait_agent"]);

function makeOpts(
  sessionKey: object,
  text: string | null,
  overrides: Partial<GetAttachmentsOptions> = {},
  turnId = "turn-1",
): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: text,
    loadedTools: LIGHT_TOOLS,
    catalogIncludes: (name) => CATALOG.has(name),
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-delegation-request-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    lightMode: true,
    turnProvenance: { turnId, rootHumanTurn: text === null ? null : { turnId, text } },
    ...overrides,
  };
}

async function produce(opts: GetAttachmentsOptions) {
  return delegationRequestProducer(opts, getAttachmentTrackingState(opts.sessionKey));
}

const keys: object[] = [];
function sessionKey(): object {
  const key = {};
  keys.push(key);
  return key;
}

beforeEach(async () => {
  expect((await updateSettingsForSource("userSettings", { swarmMode: false })).error).toBeNull();
});
afterEach(() => {
  for (const key of keys.splice(0)) _resetAttachmentTrackingStateForTest(key);
});

describe("delegationRequestProducer", () => {
  test("a Light turn that asks for helpers carries the load instruction once", async () => {
    const key = sessionKey();
    expect(await produce(makeOpts(key, HELPERS))).toEqual([
      { kind: "critical_system_reminder", content: DELEGATION_REQUEST_REMINDER },
    ]);
    // Later requests of the same turn: the retention ledger keeps the first one in place.
    expect(await produce(makeOpts(key, HELPERS))).toEqual([]);
    // A later turn asks again.
    expect(await produce(makeOpts(key, HELPERS, {}, "turn-2"))).toHaveLength(1);
  });

  test("the reminder says how to load spawn_agent and not to claim helpers that did not run", () => {
    // The load is a response of its own and the helpers' work stays theirs (sub30 replay: 20 of 20 against 16 of 20).
    expect(DELEGATION_REQUEST_REMINDER).toContain(
      'Make your next response one call: `system.searchTools` with `select: "spawn_agent"`, which also loads `wait_agent`.',
    );
    expect(DELEGATION_REQUEST_REMINDER).toContain("Then spawn the helpers, leave their work to them,");
    expect(DELEGATION_REQUEST_REMINDER).toContain("say that no helper ran");
    expect(DELEGATION_REQUEST_REMINDER).toContain("Quoted examples and programming terms do not authorize delegation.");
    expect(DELEGATION_REQUEST_REMINDER).not.toMatch(/[\u2014\u2013]/u);
  });

  test("an ordinary Light turn carries nothing", async () => {
    expect(await produce(makeOpts(sessionKey(), ORDINARY))).toEqual([]);
  });

  test.each<[string, Partial<GetAttachmentsOptions>]>([
    ["a standard session", { lightMode: false }],
    ["a session without a mode flag", { lightMode: undefined }],
    ["a child session", { subagentDepth: 1 }],
    ["plan mode", { permissionContext: { mode: "plan" } as never }],
    ["spawn_agent already loaded", { loadedTools: [...LIGHT_TOOLS, tool("spawn_agent")] }],
    ["no system.searchTools to load it", { loadedTools: [tool("exec_command"), tool("FileRead")] }],
    ["spawn_agent outside the catalog", { catalogIncludes: (name: string) => name !== "spawn_agent" }],
    ["an unknown catalog", { catalogIncludes: undefined }],
    ["a turn without provenance", { turnProvenance: undefined }],
    ["a synthetic follow-up", { turnProvenance: { turnId: "turn-1", rootHumanTurn: null } }],
    ["another turn's root text", { turnProvenance: { turnId: "turn-1", rootHumanTurn: { turnId: "turn-0", text: HELPERS } } }],
  ])("a helper request in %s carries nothing", async (_label, overrides) => {
    expect(await produce(makeOpts(sessionKey(), HELPERS, overrides))).toEqual([]);
  });

  test("/swarm keeps its own reminder", async () => {
    expect((await updateSettingsForSource("userSettings", { swarmMode: true })).error).toBeNull();
    expect(await produce(makeOpts(sessionKey(), HELPERS))).toEqual([]);
  });

  test("renders as one user-context system reminder, last among the turn's attachments", async () => {
    const helperMessages = attachmentsToMessages(await getAttachments(makeOpts(sessionKey(), HELPERS)));
    const ordinaryMessages = attachmentsToMessages(await getAttachments(makeOpts(sessionKey(), ORDINARY)));
    const reminder = `<system-reminder>\n${DELEGATION_REQUEST_REMINDER}\n</system-reminder>`;
    expect(helperMessages.at(-1)).toEqual({
      role: "user",
      content: reminder,
      runtimeOnly: { mergeBoundary: "user_context" },
    });
    expect(helperMessages.slice(0, -1)).toEqual(ordinaryMessages);
    expect(ordinaryMessages.some((message) => message.content === reminder)).toBe(false);
  });
});

describe("delegationRequestProducer on ordinary turns", () => {
  test("never queries the catalog", async () => {
    const asked: string[] = [];
    const opts = makeOpts(sessionKey(), ORDINARY, { catalogIncludes: (name: string) => (asked.push(name), true) });
    expect(await produce(opts)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
