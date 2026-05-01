import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const APP_SOURCE_PATH = path.resolve(import.meta.dirname, "App.tsx");
const SESSION_TYPES_PATH = path.resolve(
  import.meta.dirname,
  "session-types.ts",
);

function readSource(p: string): string {
  return fs.readFileSync(p, "utf8");
}

describe("openclaude-app-startup-fixes / conversation-id-from-session", () => {
  test("session-types.ts exposes readonly conversationId: string on OpenClaudeBridgeSession", () => {
    const source = readSource(SESSION_TYPES_PATH);
    const interfaceMatch = source.match(
      /export\s+interface\s+OpenClaudeBridgeSession\s*\{([\s\S]*?)\n\}/,
    );
    expect(interfaceMatch, "OpenClaudeBridgeSession interface declaration not found").not.toBeNull();
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

describe("openclaude-app-startup-fixes / initial-submit-startup-messages", () => {
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
