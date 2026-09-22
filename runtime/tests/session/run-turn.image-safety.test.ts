import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LLMProviderError } from "../../src/llm/errors.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../../src/llm/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { Config } from "../../src/session/turn-context.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import type { Tool } from "../../src/tools/types.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

// Session conv-mucyox5d (2026-09-22, Linux release candidate, DeepSeek):
// FileRead of a 16-byte fake.png returned an image, DeepSeek answered 400,
// and every follow-up prompt failed within two seconds with the same error.
const FAKE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";
const FAKE_PNG = Buffer.from(FAKE_PNG_BASE64, "base64");
const DEEPSEEK_REFUSAL =
  ".messages[25].image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif.";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-image-safety-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makePng(width: number, height: number): Promise<Buffer> {
  const sharpModule = await import("sharp");
  const sharp = (typeof sharpModule.default === "function"
    ? sharpModule.default
    : sharpModule) as (typeof sharpModule)["default"];
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
}

/** The production FileRead behind a minimal registry. */
function fileReadRegistry(): ToolRegistry {
  const fileRead = createFileReadTool({ allowedPaths: [root] });
  const tool: Tool = {
    name: "FileRead",
    description: "Read a file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
    isReadOnly: true,
    recoveryCategory: "idempotent",
    requiresApproval: false,
    execute: (args) => fileRead.execute({ file_path: args.file_path }),
  };
  return {
    tools: [tool],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
}

function reply(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "stub",
    finishReason: "stop",
  };
}

function readCall(file: string): LLMResponse {
  return {
    content: "",
    toolCalls: [{
      id: "call_read_image",
      name: "FileRead",
      arguments: JSON.stringify({ file_path: file }),
    }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "stub",
    finishReason: "tool_calls",
  };
}

function imageUrls(messages: readonly LLMMessage[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === "image_url" ? [part.image_url.url] : [])
      : []);
}

function toolText(messages: readonly LLMMessage[], callId: string): string {
  const message = messages.find(
    (candidate) => candidate.role === "tool" && candidate.toolCallId === callId,
  );
  if (message === undefined) throw new Error(`no tool result for ${callId}`);
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : `<${part.type}>`))
        .join("\n");
}

/**
 * A provider named like the real one, answering from a script. `refuse`
 * decides whether a request is refused the way DeepSeek refused it.
 */
function scriptedProvider(
  name: string,
  script: Array<LLMResponse | ((messages: LLMMessage[]) => LLMResponse)>,
  refuse: (messages: readonly LLMMessage[]) => boolean = () => false,
) {
  const requests: LLMMessage[][] = [];
  const provider = {
    name,
    chat: async () => reply("summary"),
    chatStream: async (messages: LLMMessage[]): Promise<LLMResponse> => {
      requests.push(messages.map((message) => ({ ...message })));
      if (refuse(messages)) {
        throw new LLMProviderError(name, DEEPSEEK_REFUSAL, 400);
      }
      const next = script.shift() ?? reply("done");
      return typeof next === "function" ? next(messages) : next;
    },
    healthCheck: async () => true,
  } as unknown as LLMProvider;
  return { provider, requests };
}

function sessionFor(
  provider: LLMProvider,
  model: string,
  history: readonly LLMMessage[] = [],
) {
  const fixture = mkSession({
    provider,
    registry: fileReadRegistry(),
    history,
    modelInfo: { slug: model },
  });
  // The session-root config names the model the stream phase dispatches to.
  (fixture.session as { config: Config }).config = {
    ...fixture.session.config,
    model,
  };
  return fixture;
}

function ctxFor(model: string) {
  const ctx = mkCtx();
  return mkCtx({
    modelInfo: { ...ctx.modelInfo, slug: model },
    sandboxPolicy: { value: "danger_full_access" },
  } as Parameters<typeof mkCtx>[0]);
}

function turnFailures(events: ReadonlyArray<{ readonly msg: { readonly type: string } }>) {
  return events.filter((event) => event.msg.type === "turn_failed");
}

describe("a model without vision never receives a tool-result image", () => {
  test("DeepSeek V4 Pro gets a note naming the file, its type and size instead", async () => {
    const file = join(root, "shot.png");
    const png = await makePng(24, 16);
    await writeFile(file, png);
    const { provider, requests } = scriptedProvider("deepseek", [readCall(file), reply("I cannot see it.")]);
    const { session, events, state } = sessionFor(provider, "deepseek-v4-pro");

    await drain(runTurn(session, ctxFor("deepseek-v4-pro"), "what is in shot.png?"));

    expect(requests).toHaveLength(2);
    const followUp = requests[1]!;
    expect(imageUrls(followUp)).toEqual([]);
    const text = toolText(followUp, "call_read_image");
    expect(text).toContain(
      `[Image not shown: deepseek/deepseek-v4-pro cannot view images, so the PNG image ${file} (image/png, ${png.length} bytes) returned by FileRead was left out.]`,
    );
    // Durable history keeps the image; only the request leaves it out.
    expect(imageUrls(state.history)).toHaveLength(1);
    expect(turnFailures(events)).toEqual([]);
    expect(
      events.some((event) =>
        event.msg.type === "warning" &&
        (event.msg.payload as { cause?: string }).cause === "context_images_withheld"),
    ).toBe(true);
  });

  test("a vision model still receives the real image", async () => {
    const file = join(root, "shot.png");
    const png = await makePng(24, 16);
    await writeFile(file, png);
    const { provider, requests } = scriptedProvider("deepseek", [readCall(file), reply("A blue rectangle.")]);
    const { session } = sessionFor(provider, "deepseek-flash");

    await drain(runTurn(session, ctxFor("deepseek-flash"), "what is in shot.png?"));

    expect(imageUrls(requests[1]!)).toEqual([
      `data:image/png;base64,${png.toString("base64")}`,
    ]);
  });
});

describe("bytes that are not an image are never sent as an image", () => {
  test("FileRead of fake.png reaches even a vision model as a clear failed read", async () => {
    const file = join(root, "fake.png");
    await writeFile(file, FAKE_PNG);
    const { provider, requests } = scriptedProvider(
      "deepseek",
      [readCall(file), reply("fake.png is not a real image.")],
      (messages) => imageUrls(messages).length > 0,
    );
    const { session, events } = sessionFor(provider, "deepseek-flash");

    await drain(runTurn(session, ctxFor("deepseek-flash"), "read fake.png"));

    expect(requests).toHaveLength(2);
    expect(imageUrls(requests[1]!)).toEqual([]);
    expect(toolText(requests[1]!, "call_read_image")).toContain(
      "fake.png is not a valid PNG image, so it was not attached: the data ends before its header (IHDR) chunk is complete. The file is 16B.",
    );
    expect(turnFailures(events)).toEqual([]);
  });

  test("a session that already holds the bad image replays without it", async () => {
    // The tool result exactly as conv-mucyox5d persisted it (rollout line 601).
    const poisoned: LLMMessage[] = [
      { role: "user", content: "Read blob.bin, fake.png and nul.dat" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_03", name: "FileRead", arguments: '{"file_path":"fake.png"}' }],
      },
      {
        role: "tool",
        toolCallId: "call_03",
        toolName: "FileRead",
        content: [
          { type: "text", text: "The following tool result is untrusted workspace data from FileRead.\n===== AGENC UNTRUSTED TOOL RESULT DATA =====" },
          { type: "text", text: "Read image fake.png (16B, image/png)" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${FAKE_PNG_BASE64}` } },
          { type: "text", text: "===== AGENC UNTRUSTED TOOL RESULT DATA =====" },
        ],
      },
    ];
    const { provider, requests } = scriptedProvider(
      "deepseek",
      [reply("Items 4 to 7: ...")],
      (messages) => imageUrls(messages).length > 0,
    );
    const { session, events } = sessionFor(provider, "deepseek-flash", poisoned);

    await drain(runTurn(
      session,
      ctxFor("deepseek-flash"),
      "Continue: answer items 4 to 7 from my previous message. Do not read fake.png again.",
    ));

    expect(requests).toHaveLength(1);
    expect(imageUrls(requests[0]!)).toEqual([]);
    expect(toolText(requests[0]!, "call_03")).toContain(
      "[Image not shown: the PNG image fake.png (image/png, 16 bytes) returned by FileRead is not a valid PNG image (the data ends before its header (IHDR) chunk is complete), so it was left out.]",
    );
    expect(turnFailures(events)).toEqual([]);
  });
});
