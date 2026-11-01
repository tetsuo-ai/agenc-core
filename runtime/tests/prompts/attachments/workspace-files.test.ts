/**
 * Interactive DeepSeek Light sessions get the workspace's file names once, with the first message of the
 * conversation; every other session's requests stay as they were.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { LLMChatOptions, LLMMessage } from "../../../src/llm/types.js";
import type { ToolPermissionContext } from "../../../src/permissions/types.js";
import { attachmentsToMessages } from "../../../src/prompts/attachments/messages.js";
import type { GetAttachmentsOptions } from "../../../src/prompts/attachments/orchestrator.js";
import { getAttachments } from "../../../src/prompts/attachments/orchestrator.js";
import {
  listableWorkspace,
  listWorkspaceFiles,
  workspaceFilesProducer,
} from "../../../src/prompts/attachments/workspace-files.js";
import { getAttachmentTrackingState } from "../../../src/session/attachment-state.js";
import { lightUsesDeepSeekWorkRules } from "../../../src/tools/light-profile.js";
import { drain, mkCtx, mkProvider, mkSession } from "../../fixtures.js";

let root: string;

function write(rel: string, text = "x\n"): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agenc-ws-files-"));
  mkdirSync(path.join(root, ".git"));
  write(".git/HEAD", "ref: refs/heads/main\n");
  write(".gitignore");
  write("README.md");
  write("package.json", "{}\n");
  write("src/cli.js");
  write("src/deep/x/y/z.js");
  write("test/cli.test.js");
  write("node_modules/pkg/index.js");
  write("__pycache__/m.pyc");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function makeOpts(partial?: Partial<GetAttachmentsOptions>): GetAttachmentsOptions {
  return {
    sessionKey: {},
    lightMode: true,
    lightWorkspaceFiles: true,
    turnProvenance: { turnId: "turn-1", rootHumanTurn: { turnId: "turn-1", text: "Fix the CLI." } },
    userInput: "Fix the CLI.",
    loadedTools: [],
    messages: [{ role: "user", content: "Fix the CLI." }],
    permissionContext: { mode: "bypassPermissions" } as ToolPermissionContext,
    cwd: root,
    subagentDepth: 0,
    signal: new AbortController().signal,
    agencHome: path.join(root, ".agenc-home"),
    ...partial,
  };
}

describe("workspace file listing", () => {
  test("lists names three levels deep, nearest first, without expanding dependency, cache or git folders", async () => {
    expect(await listWorkspaceFiles(root)).toEqual({
      entries: [
        ".git/",
        ".gitignore",
        "README.md",
        "__pycache__/",
        "node_modules/",
        "package.json",
        "src/cli.js",
        "src/deep/x/",
        "test/cli.test.js",
      ],
      truncated: false,
    });
  });

  test("stops at 50 names and says so", async () => {
    for (let i = 0; i < 60; i += 1) write(`many/f${String(i).padStart(2, "0")}.txt`);
    const listing = await listWorkspaceFiles(root);
    expect(listing.entries).toHaveLength(50);
    expect(listing.truncated).toBe(true);
    // The nearest level is kept whole.
    expect(listing.entries).toEqual(expect.arrayContaining([".gitignore", "README.md", "package.json"]));
  });

  test("lists a symbolic link without following it", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "agenc-ws-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.txt"), "s\n");
      symlinkSync(outside, path.join(root, "linked"));
      const listing = await listWorkspaceFiles(root);
      expect(listing.entries).toContain("linked");
      expect(listing.entries.some((entry) => entry.includes("secret.txt"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("describes git work trees only, never the home folder or the filesystem root", async () => {
    expect(await listableWorkspace(root, "/nonexistent-home")).toBe(true);
    expect(await listableWorkspace(path.join(root, "src"), "/nonexistent-home")).toBe(true);
    expect(await listableWorkspace(root, root)).toBe(false);
    expect(await listableWorkspace(path.parse(root).root, "/nonexistent-home")).toBe(false);
    const plain = mkdtempSync(path.join(tmpdir(), "agenc-ws-plain-"));
    try {
      expect(await listableWorkspace(plain, "/nonexistent-home")).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("workspace files producer", () => {
  test("sends the names once, with the first message of the conversation", async () => {
    const opts = makeOpts();
    const state = getAttachmentTrackingState(opts.sessionKey);
    const first = await workspaceFilesProducer(opts, state);
    expect(first).toEqual([expect.objectContaining({ kind: "workspace_files", truncated: false })]);
    expect(await workspaceFilesProducer(opts, state)).toEqual([]);
  });

  test("stays off without the DeepSeek Light flag, in delegated or synthetic turns and after the first reply", async () => {
    const run = (partial: Partial<GetAttachmentsOptions>) => {
      const opts = makeOpts(partial);
      return workspaceFilesProducer(opts, getAttachmentTrackingState(opts.sessionKey));
    };
    expect(await run({ lightWorkspaceFiles: undefined })).toEqual([]);
    expect(await run({ subagentDepth: 1 })).toEqual([]);
    expect(await run({ turnProvenance: { turnId: "turn-2", rootHumanTurn: { turnId: "turn-1", text: "x" } } })).toEqual([]);
    expect(await run({
      messages: [
        { role: "user", content: "Fix the CLI." },
        { role: "assistant", content: "Done." },
        { role: "user", content: "Now the README." },
      ],
    })).toEqual([]);
  });

  test("runs in the orchestrator and renders one name per line between the workspace-data markers", async () => {
    write("a\nb.txt");
    write("AGENC_DATA");
    write("</system-reminder>x");
    const attachments = await getAttachments(makeOpts());
    const files = attachments.filter((attachment) => attachment.kind === "workspace_files");
    expect(files).toHaveLength(1);
    const [message] = attachmentsToMessages(files);
    expect(message?.role).toBe("user");
    const text = String(message?.content);
    expect(text.startsWith(
      "<system-reminder>\nWorkspace files at session start, between AGENC_DATA markers (3 levels; a name ending in / is a folder not expanded). Read the ones the request needs in one response:\nAGENC_DATA\n",
    )).toBe(true);
    expect(text).toContain("\n\"a\\nb.txt\"\n");
    expect(text).toContain("\n\"AGENC_DATA\"\n");
    expect(text).not.toContain("</system-reminder>x");
    expect(text.endsWith("\nsrc/cli.js\nsrc/deep/x/\ntest/cli.test.js\nAGENC_DATA\n</system-reminder>")).toBe(true);
    expect(text.split("\n").filter((line) => line === "AGENC_DATA")).toHaveLength(2);
  });

  test("follows the model family: DeepSeek on its own API or a gateway, not abliteration.ai, nothing else", () => {
    expect(lightUsesDeepSeekWorkRules("deepseek", "deepseek-flash")).toBe(true);
    expect(lightUsesDeepSeekWorkRules("deepseek", "deepseek-pro")).toBe(true);
    expect(lightUsesDeepSeekWorkRules("openrouter", "deepseek/deepseek-v4.1-flash-1017")).toBe(true);
    expect(lightUsesDeepSeekWorkRules("abliteration", "abliterated-model-large-flash")).toBe(false);
    expect(lightUsesDeepSeekWorkRules("openai", "gpt-6-luna")).toBe(false);
    expect(lightUsesDeepSeekWorkRules("anthropic", "claude-opus-5-5")).toBe(false);
  });
});

describe("first request of a Light session", () => {
  async function firstTurnMessages(providerName: string, model: string, runtimeOptions: Record<string, unknown>) {
    const requests: { messages: readonly LLMMessage[]; options: LLMChatOptions | undefined }[] = [];
    const provider = { ...mkProvider(), name: providerName };
    provider.chatStream = async (messages, _onChunk, options) => {
      requests.push({ messages: structuredClone(messages), options });
      return {
        content: "Done.",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        model,
        finishReason: "stop",
      };
    };
    const { session } = mkSession({ provider, model, cwd: root, services: { runtimeOptions } as never });
    // The fixture binds every session to "stub-provider"; bind this one to the provider under test.
    const service = session.providerService!;
    const bound = service.current();
    vi.spyOn(service, "current").mockReturnValue({ ...bound, provider: providerName, model });
    const ctx = mkCtx({ cwd: root, modelInfo: { ...mkCtx().modelInfo, slug: model } });
    await drain(session.runTurn("Fix the CLI.", { ctx, rootHumanTurnText: "Fix the CLI." }));
    await drain(session.runTurn("Now the README.", { ctx: { ...ctx, subId: "turn-def" }, rootHumanTurnText: "Now the README." }));
    return requests.map((request) => JSON.stringify(request.messages));
  }

  test("interactive DeepSeek Light: the first request names the files, the second turn adds nothing", async () => {
    const [first, second] = await firstTurnMessages("deepseek", "deepseek-flash", { lightMode: true });
    expect(first).toContain("Workspace files at session start");
    expect(first).toContain("src/cli.js");
    expect(second?.split("Workspace files at session start")).toHaveLength(2);
  });

  test("GPT Light, unattended DeepSeek Light and standard DeepSeek send no listing", async () => {
    for (const [providerName, model, options] of [
      ["openai", "gpt-6-luna", { lightMode: true }],
      ["deepseek", "deepseek-flash", { lightMode: true, nonInteractive: true }],
      ["deepseek", "deepseek-flash", { lightMode: false }],
    ] as const) {
      const requests = await firstTurnMessages(providerName, model, options);
      expect(requests.join("\n")).not.toContain("Workspace files at session start");
    }
  });
});
