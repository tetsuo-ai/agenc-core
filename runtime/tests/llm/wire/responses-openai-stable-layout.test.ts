/**
 * The OpenAI Responses request of one session only ever grows at its end.
 *
 * GPT-5.6 and later write the prompt cache up to the last user message or
 * tool output of a request and read it back only through the same key. The
 * oa Luna race (main c85e49ae4) showed both ways AgenC lost cache: the session
 * tail rode as the LAST input item, so it moved behind the new history on
 * every request and was never cached (283 uncached tokens on each of 131
 * Light calls), and every session sent its own `conv-<id>` key, so no first
 * request read the instructions, tools and tail that the previous session
 * had just written (0 of 22, against 1,821 cached tokens on the same prefix
 * through gateways that send no key).
 *
 * These tests pin the layout that fixes both: instructions = static head,
 * the session tail as the first input item, history appended after it, and
 * the user's cache scope as the key on GPT-5.6 and later.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildOpenAIResponsesRequest } from "../../../src/llm/wire/responses-openai.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER } from "../../../src/llm/wire/shared.js";
import {
  PROMPT_CACHE_SCOPE_FILE,
  promptCacheScopeKeyForHome,
} from "../../../src/llm/prompt-cache-key.js";
import { openAiModelScopesPromptCacheByKey } from "../../../src/llm/registry/openai-reasoning-models.js";
import type { LLMMessage, LLMTool } from "../../../src/llm/types.js";

const SCOPE = "agenc-0123456789abcdef0123456789abcdef";
const STATIC_HEAD = "You are AgenC. Follow user scope.";
const SESSION_TAIL = "Workspace: /workspace\n\nPermission mode: bypassPermissions.";
const SYSTEM_PROMPT = `${STATIC_HEAD}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\n${SESSION_TAIL}`;
const TOOLS: LLMTool[] = [{
  type: "function",
  function: {
    name: "exec_command",
    description: "Run a command",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  },
}];

/** One session: a prompt, two tool rounds, an answer, a follow-up prompt. */
const PROMPT: LLMMessage = { role: "user", content: "What does this repo do?" };
const CALL_1: LLMMessage = {
  role: "assistant",
  content: "",
  toolCalls: [{ id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }],
};
const RESULT_1: LLMMessage = { role: "tool", toolCallId: "call_1", content: "README.md\nsrc" };
const CALL_2: LLMMessage = {
  role: "assistant",
  content: "",
  toolCalls: [{ id: "call_2", name: "exec_command", arguments: "{\"cmd\":\"cat README.md\"}" }],
};
const RESULT_2: LLMMessage = { role: "tool", toolCallId: "call_2", content: "An invoice kit." };
const ANSWER: LLMMessage = { role: "assistant", content: "It builds invoices." };
const FOLLOW_UP: LLMMessage = { role: "user", content: "Where does it start?" };
const SESSION_REQUESTS: LLMMessage[][] = [
  [PROMPT],
  [PROMPT, CALL_1, RESULT_1],
  [PROMPT, CALL_1, RESULT_1, CALL_2, RESULT_2],
  [PROMPT, CALL_1, RESULT_1, CALL_2, RESULT_2, ANSWER, FOLLOW_UP],
];

type Item = Record<string, unknown>;

function request(
  messages: LLMMessage[],
  extra: Partial<Parameters<typeof buildOpenAIResponsesRequest>[0]> = {},
  systemPrompt = SYSTEM_PROMPT,
): Record<string, unknown> {
  return buildOpenAIResponsesRequest({
    model: "gpt-6-luna",
    messages,
    tools: TOOLS,
    ...extra,
    options: {
      systemPrompt,
      promptCacheKey: "conv-abc123",
      promptCacheScopeKey: SCOPE,
      ...extra.options,
    },
  });
}

function items(body: Record<string, unknown>): Item[] {
  return body.input as Item[];
}

describe("OpenAI Responses requests of one session are append-only", () => {
  it("sends the session tail as the first input item, after the static instructions", () => {
    const body = request([PROMPT]);
    expect(body.instructions).toBe(STATIC_HEAD);
    expect(items(body)[0]).toEqual({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: SESSION_TAIL }],
    });
    expect(items(body)[1]).toMatchObject({ type: "message", role: "user" });
  });

  it("repeats every item of the previous request byte for byte and adds only new history", () => {
    const bodies = SESSION_REQUESTS.map((messages) => request(messages));
    for (let index = 1; index < bodies.length; index += 1) {
      const previous = bodies[index - 1]!;
      const current = bodies[index]!;
      const { input: _previousInput, ...previousStatic } = previous;
      const { input: _currentInput, ...currentStatic } = current;
      // instructions, tools, key and every other field stay identical
      expect(JSON.stringify(currentStatic)).toBe(JSON.stringify(previousStatic));
      const previousItems = items(previous).map((item) => JSON.stringify(item));
      const currentItems = items(current).map((item) => JSON.stringify(item));
      expect(currentItems.length).toBeGreaterThan(previousItems.length);
      expect(currentItems.slice(0, previousItems.length)).toEqual(previousItems);
    }
  });

  it("ends every request with a conversation item, never a system item", () => {
    for (const messages of SESSION_REQUESTS) {
      const last = items(request(messages)).at(-1)!;
      expect(last.role).not.toBe("system");
      expect(JSON.stringify(last)).not.toContain(SESSION_TAIL);
    }
    // The tail appears once per request.
    const body = request(SESSION_REQUESTS.at(-1)!);
    expect(JSON.stringify(body.input).split("Permission mode: bypassPermissions.").length - 1).toBe(1);
  });

  it("a changed tail changes only the first item; instructions and history stay byte-identical", () => {
    const before = request(SESSION_REQUESTS[2]!);
    const after = request(
      SESSION_REQUESTS[3]!,
      {},
      `${STATIC_HEAD}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\nWorkspace: /workspace\n\nPermission mode: default.`,
    );
    expect(after.instructions).toBe(before.instructions);
    expect(JSON.stringify(items(after)[0])).toContain("Permission mode: default.");
    const previousHistory = items(before).slice(1).map((item) => JSON.stringify(item));
    expect(items(after).slice(1, previousHistory.length + 1).map((item) => JSON.stringify(item)))
      .toEqual(previousHistory);
  });

  it("keeps the subscription backend's tail in the instructions (that route rejects system items)", () => {
    const body = request([PROMPT, CALL_1, RESULT_1], { chatgptBackend: true });
    expect(body.instructions).toBe(`${STATIC_HEAD}\n\n${SESSION_TAIL}`);
    expect(JSON.stringify(body.input)).not.toContain('"role":"system"');
  });
});

describe("prompt_cache_key on the OpenAI Responses wire", () => {
  const scope = SCOPE;

  it("sends the user's cache scope to GPT-5.6 and later on the platform API", () => {
    for (const model of ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.6-terra", "openai/gpt-6-luna",
      "gpt-6-luna-2026-09-22"]) {
      expect(openAiModelScopesPromptCacheByKey(model)).toBe(true);
      expect(request([PROMPT], { model }).prompt_cache_key).toBe(scope);
    }
  });

  it("keeps the conversation key for older models, the subscription backend and requests without a scope", () => {
    for (const model of ["gpt-5", "gpt-5.5", "gpt-5.4-nano", "gpt-4.1", "gpt-6-luna-mini"]) {
      expect(openAiModelScopesPromptCacheByKey(model)).toBe(false);
      expect(request([PROMPT], { model }).prompt_cache_key).toBe("conv-abc123");
    }
    expect(request([PROMPT], { chatgptBackend: true }).prompt_cache_key).toBe("conv-abc123");
    const unscoped = buildOpenAIResponsesRequest({
      model: "gpt-6-luna",
      messages: [PROMPT],
      tools: TOOLS,
      options: { systemPrompt: SYSTEM_PROMPT, promptCacheKey: "conv-abc123" },
    });
    expect(unscoped.prompt_cache_key).toBe("conv-abc123");
    const keyless = buildOpenAIResponsesRequest({
      model: "gpt-6-luna",
      messages: [PROMPT],
      tools: TOOLS,
      options: { systemPrompt: SYSTEM_PROMPT },
    });
    expect(keyless).not.toHaveProperty("prompt_cache_key");
  });

});

describe("the prompt cache scope of an AgenC home", () => {
  const homes: string[] = [];
  function home(): string {
    const path = mkdtempSync(join(tmpdir(), "agenc-scope-home-"));
    homes.push(path);
    return path;
  }
  afterEach(() => {
    for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("is generated once and reused by every later session of the home", () => {
    const agencHome = home();
    const first = promptCacheScopeKeyForHome(agencHome);
    expect(first).toMatch(/^agenc-[0-9a-f]{32}$/u);
    const file = join(agencHome, PROMPT_CACHE_SCOPE_FILE);
    expect(readFileSync(file, "utf8")).toBe(`${first!.slice("agenc-".length)}\n`);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // Later sessions (and later processes) read the same file.
    expect(promptCacheScopeKeyForHome(agencHome)).toBe(first);
    expect(promptCacheScopeKeyForHome(`${agencHome}/`)).toBe(first);
    // No temporary file is left behind.
    expect(readdirSync(agencHome)).toEqual([PROMPT_CACHE_SCOPE_FILE]);
  });

  it("differs between homes", () => {
    const keys = [home(), home(), home()].map((path) => promptCacheScopeKeyForHome(path));
    expect(new Set(keys).size).toBe(3);
  });

  it("carries no path-derived data: the same path gets a new random id once the file is gone", () => {
    const agencHome = home();
    const first = promptCacheScopeKeyForHome(agencHome)!;
    const pathHash = createHash("sha256").update(agencHome).digest("hex");
    const saltedPathHash = createHash("sha256")
      .update(`agenc-prompt-cache-scope-v1\0${agencHome}`)
      .digest("hex");
    for (const digest of [pathHash, saltedPathHash]) {
      expect(first).not.toContain(digest.slice(0, 32));
      expect(digest).not.toContain(first.slice("agenc-".length));
    }
    for (const segment of agencHome.split("/").filter((part) => part.length > 0)) {
      expect(first).not.toContain(segment);
    }
    rmSync(join(agencHome, PROMPT_CACHE_SCOPE_FILE));
    const second = promptCacheScopeKeyForHome(agencHome);
    expect(second).toMatch(/^agenc-[0-9a-f]{32}$/u);
    expect(second).not.toBe(first);
  });

  it("keeps a valid id verbatim and replaces only a malformed one", () => {
    const agencHome = home();
    const file = join(agencHome, PROMPT_CACHE_SCOPE_FILE);
    writeFileSync(file, "fedcba9876543210fedcba9876543210\n", { mode: 0o600 });
    expect(promptCacheScopeKeyForHome(agencHome)).toBe("agenc-fedcba9876543210fedcba9876543210");
    writeFileSync(file, "not an id\n");
    const replaced = promptCacheScopeKeyForHome(agencHome);
    expect(replaced).toMatch(/^agenc-[0-9a-f]{32}$/u);
    expect(readFileSync(file, "utf8")).toBe(`${replaced!.slice("agenc-".length)}\n`);
    expect(promptCacheScopeKeyForHome(agencHome)).toBe(replaced);
  });

  it("leaves an existing file it cannot read alone and gives no scope", () => {
    const agencHome = home();
    const file = join(agencHome, PROMPT_CACHE_SCOPE_FILE);
    mkdirSync(file);
    expect(promptCacheScopeKeyForHome(agencHome)).toBeUndefined();
    expect(statSync(file).isDirectory()).toBe(true);
    expect(readdirSync(agencHome)).toEqual([PROMPT_CACHE_SCOPE_FILE]);
  });

  it("gives no scope when the home cannot hold the file", () => {
    expect(promptCacheScopeKeyForHome(join(home(), "missing", "home"))).toBeUndefined();
  });
});
