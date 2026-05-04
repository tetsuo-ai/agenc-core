import fs from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { submitViaElicitationBridge } from "../elicitation-submit-routing.js";

const APP_SOURCE_PATH = path.resolve(import.meta.dirname, "../components/App.tsx");
const SESSION_TYPES_PATH = path.resolve(
  import.meta.dirname,
  "../session-types.ts",
);
const ELICITATION_BRIDGE_PATH = path.resolve(
  import.meta.dirname,
  "../elicitation-bridge.tsx",
);

function readSource(p: string): string {
  return fs.readFileSync(p, "utf8");
}

describe("AgenC App conversation id", () => {
  test("session-types.ts exposes readonly conversationId: string on AgenCBridgeSession", () => {
    const source = readSource(SESSION_TYPES_PATH);
    const interfaceMatch = source.match(
      /export\s+interface\s+AgenCBridgeSession\s*\{([\s\S]*?)\n\}/,
    );
    expect(interfaceMatch, "AgenCBridgeSession interface declaration not found").not.toBeNull();
    const body = interfaceMatch![1]!;
    expect(body).toMatch(/readonly\s+conversationId\s*:\s*string\s*;/);
  });

  test("App.tsx no longer hard-codes conversationId={\"agenc\"}", () => {
    const source = readSource(APP_SOURCE_PATH);
    expect(source).not.toMatch(/conversationId\s*=\s*\{\s*"agenc"\s*\}/);
    expect(source).not.toMatch(/conversationId\s*=\s*\{\s*'agenc'\s*\}/);
  });

  test("App.tsx sources Messages conversationId prop from props.session.conversationId", () => {
    const source = readSource(APP_SOURCE_PATH);
    expect(source).toMatch(
      /conversationId\s*=\s*\{\s*props\.session\.conversationId\s*\}/,
    );
  });
});

describe("AgenC App initial submit startup messages", () => {
  function extractUseInitialSubmit(source: string): string {
    const start = source.indexOf("function useInitialSubmit");
    expect(start, "useInitialSubmit declaration not found").toBeGreaterThan(-1);
    const slice = source.slice(start);
    const closeIdx = slice.indexOf("\n}\n");
    expect(closeIdx, "useInitialSubmit body close not found").toBeGreaterThan(-1);
    return slice.slice(0, closeIdx + 2);
  }

  test("useInitialSubmit no longer routes the !hasPrompt branch through submit(\"\")", () => {
    const source = readSource(APP_SOURCE_PATH);
    const body = extractUseInitialSubmit(source);
    expect(body).not.toMatch(/submit\(\s*hasPrompt\s*\?\s*initialPrompt\s*:\s*""\s*\)/);
    expect(body).not.toMatch(/\bsubmit\(\s*""\s*\)/);
  });

  test("useInitialSubmit enqueues each startup message via session.enqueueIdleInput", () => {
    const source = readSource(APP_SOURCE_PATH);
    const body = extractUseInitialSubmit(source);
    expect(body).toMatch(/session\.enqueueIdleInput\?\.\(\s*message\s*\)/);
  });

  test("useInitialSubmit triggers the empty-prompt turn through the session API with displayUserMessage: null", () => {
    const source = readSource(APP_SOURCE_PATH);
    const body = extractUseInitialSubmit(source);
    expect(body).toMatch(
      /session\.submit\?\.\(\s*""\s*,\s*\{\s*displayUserMessage\s*:\s*null\s*\}\s*\)/,
    );
  });

  test("useInitialSubmit still preserves the submitted ref guard so it fires at most once per mount", () => {
    const source = readSource(APP_SOURCE_PATH);
    const body = extractUseInitialSubmit(source);
    expect(body).toMatch(/submitted\.current\s*=\s*true/);
    expect(body).toMatch(/if\s*\(\s*submitted\.current\s*\)\s*return/);
  });

  test("useInitialSubmit still routes the hasPrompt branch through the local submit(initialPrompt)", () => {
    const source = readSource(APP_SOURCE_PATH);
    const body = extractUseInitialSubmit(source);
    expect(body).toMatch(/\bsubmit\(\s*initialPrompt\s*\)/);
  });
});

describe("AgenC App elicitation bridge", () => {
  test("App.tsx installs the elicitation bridge and routes submit through it first", () => {
    const source = readSource(APP_SOURCE_PATH);
    expect(source).toMatch(/useElicitationBridge\(props\.session\)/);
    expect(source).toMatch(/<ElicitationOverlay\s+prompt=\{elicitation\.prompt\}\s*\/>/);
    expect(source).toMatch(
      /submitViaElicitationBridge\(elicitation,\s*submit,\s*value,\s*helpers\)/,
    );
  });

  test("submit routing consumes elicitation prompts before normal session submit", async () => {
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    const submit = vi.fn();
    const elicitation = {
      submit: vi.fn().mockReturnValue(true),
    };

    await submitViaElicitationBridge(elicitation, submit, "answer", helpers);

    expect(elicitation.submit).toHaveBeenCalledWith("answer");
    expect(submit).not.toHaveBeenCalled();
    expect(helpers.clearBuffer).toHaveBeenCalledOnce();
    expect(helpers.resetHistory).toHaveBeenCalledOnce();
    expect(helpers.setCursorOffset).toHaveBeenCalledWith(0);
  });

  test("submit routing falls back to normal session submit when no prompt is active", async () => {
    const helpers = {
      clearBuffer: vi.fn(),
      resetHistory: vi.fn(),
      setCursorOffset: vi.fn(),
    };
    const submit = vi.fn().mockResolvedValue(undefined);
    const elicitation = {
      submit: vi.fn().mockReturnValue(false),
    };

    await submitViaElicitationBridge(elicitation, submit, "run", helpers);

    expect(elicitation.submit).toHaveBeenCalledWith("run");
    expect(submit).toHaveBeenCalledWith("run");
    expect(helpers.clearBuffer).toHaveBeenCalledOnce();
    expect(helpers.resetHistory).toHaveBeenCalledOnce();
    expect(helpers.setCursorOffset).toHaveBeenCalledWith(0);
  });

  test("session-types.ts exposes production elicitation resolvers", () => {
    const source = readSource(SESSION_TYPES_PATH);
    expect(source).toContain("requestUserInputResolver");
    expect(source).toContain("mcpElicitationResolver");
  });

  test("elicitation bridge resolves user input and MCP prompts through submit", () => {
    const source = readSource(ELICITATION_BRIDGE_PATH);
    expect(source).toContain("session.services.requestUserInputResolver");
    expect(source).toContain("session.services.mcpElicitationResolver");
    expect(source).toContain("settlePendingOnSubmit");
    expect(source).toContain("ElicitationOverlay");
  });
});
