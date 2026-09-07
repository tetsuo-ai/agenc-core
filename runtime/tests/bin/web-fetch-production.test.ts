import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setLiveWebFetchDnsAllLookupForTests,
  createModelFacingTools,
} from "../../src/bin/model-facing-tools.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { WEB_FETCH_TOOL_NAME } from "../../src/tools/WebFetchTool/prompt.js";
import type { Tool } from "../../src/tools/types.js";

const runtimeRoot = resolve(import.meta.dirname, "../..");
const retiredModules = ["WebFetchTool", "UI", "preapproved", "utils"].map(
  (name) => resolve(runtimeRoot, "src/tools/WebFetchTool", name),
);

describe("WebFetch production authority", () => {
  let workspaceRoot: string;
  let tool: Tool;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(
      join(tmpdir(), "agenc-web-fetch-production-"),
    );
    __setLiveWebFetchDnsAllLookupForTests((_hostname, callback) => {
      callback(null, [{ address: "93.184.216.34", family: 4 }]);
    });
    const modelFacingTools = createModelFacingTools({
      workspaceRoot,
      agencHome: workspaceRoot,
      env: {},
      getSession: () => null,
    });
    const registry = buildToolRegistry({
      workspaceRoot,
      agencHome: workspaceRoot,
      modelFacingTools,
    });
    const matches = registry.tools.filter(
      (candidate) => candidate.name === WEB_FETCH_TOOL_NAME,
    );
    expect(matches).toHaveLength(1);
    tool = matches[0]!;
    expect(tool.execute).toBe(
      modelFacingTools.find(
        (candidate) => candidate.name === WEB_FETCH_TOOL_NAME,
      )!.execute,
    );
    expect(tool).toMatchObject({
      isReadOnly: true,
      recoveryCategory: "idempotent",
    });
  });

  afterEach(async () => {
    __setLiveWebFetchDnsAllLookupForTests(undefined);
    vi.restoreAllMocks();
    if (workspaceRoot && existsSync(workspaceRoot)) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps only the shared prompt leaf and rejects retired imports in source and tests", () => {
    expect(readdirSync(resolve(runtimeRoot, "src/tools/WebFetchTool"))).toEqual(
      ["prompt.ts"],
    );
    const violations: string[] = [];
    for (const tree of ["src", "tests"]) {
      const root = resolve(runtimeRoot, tree);
      for (const entry of readdirSync(root, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !/\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
        const file = join(entry.parentPath, entry.name);
        const source = readFileSync(file, "utf8");
        for (const imported of ts.preProcessFile(source, true, true)
          .importedFiles) {
          const specifier = imported.fileName.replace(/[?#].*$/u, "");
          const resolved = specifier.startsWith(".")
            ? resolve(dirname(file), specifier)
            : specifier.startsWith("src/")
              ? resolve(runtimeRoot, specifier)
              : undefined;
          if (
            resolved &&
            retiredModules.includes(resolved.replace(/\.[cm]?[jt]sx?$/u, ""))
          ) {
            violations.push(
              `${relative(runtimeRoot, file)} -> ${imported.fileName}`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("reads a complete streamed UTF-8 body through the production registry", async () => {
    const bytes = new TextEncoder().encode("café documentation");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4));
          controller.enqueue(bytes.slice(4));
          controller.close();
        },
      }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const result = await tool.execute({ url: "https://react.dev/learn" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      content: "café documentation",
      truncated: false,
      preapproved: true,
    });
  });

  it("accepts an empty response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    const result = await tool.execute({ url: "https://react.dev/learn" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      content: "",
      truncated: false,
    });
  });

  it("cancels an oversized stream without trusting Content-Length or buffering its remainder", async () => {
    const cancel = vi.fn();
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new TextEncoder().encode("x".repeat(32_768)));
      },
    );
    const response = new Response(new ReadableStream({ pull, cancel }), {
      headers: { "content-length": "1" },
    });
    const text = vi.spyOn(response, "text");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const result = await tool.execute({
      url: "https://react.dev/learn",
      max_chars: 1_000,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.truncated).toBe(true);
    expect(parsed.content).toContain("[truncated");
    expect(parsed.content.length).toBeLessThan(1_100);
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("keeps fetched content when no extraction provider is available", async () => {
    const content = "documentation ".repeat(1_000);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(content));
    const result = await tool.execute({
      url: "https://react.dev/learn",
      prompt: "summarize",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.content).toBe(content);
    expect(parsed.extracted).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
