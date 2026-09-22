import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LLMProviderError } from "../../src/llm/errors.js";
import type {
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../../src/llm/types.js";
import {
  imageRoute,
  rejectedImagesFor,
} from "../../src/session/query-image-safety.js";
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

/** Distinct, complete 1x1 PNGs: a numbered tEXt chunk after the header. */
function distinctPngDataUrls(count: number): string[] {
  const tiny = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const headerEnd = 33;
  return Array.from({ length: count }, (_, index) => {
    const data = Buffer.from(`Comment\0shot ${index}`, "latin1");
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write("tEXt", 4, "latin1");
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    const png = Buffer.concat([tiny.subarray(0, headerEnd), chunk, tiny.subarray(headerEnd)]);
    return `data:image/png;base64,${png.toString("base64")}`;
  });
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
  contextWindow?: number,
) {
  const fixture = mkSession({
    provider,
    registry: fileReadRegistry(),
    history,
    modelInfo: {
      slug: model,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    },
  });
  // The session-root config names the model the stream phase dispatches to.
  (fixture.session as { config: Config }).config = {
    ...fixture.session.config,
    model,
  };
  return fixture;
}

function ctxFor(model: string, contextWindow?: number) {
  const ctx = mkCtx();
  return mkCtx({
    modelInfo: {
      ...ctx.modelInfo,
      slug: model,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    },
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

describe("one refused image does not brick the session", () => {
  async function historyWithValidImage(): Promise<{
    readonly history: LLMMessage[];
    readonly url: string;
  }> {
    const url = `data:image/png;base64,${(await makePng(8, 8)).toString("base64")}`;
    const parts: LLMContentPart[] = [
      { type: "text", text: "Read image chart.png (70B, image/png)" },
      { type: "image_url", image_url: { url } },
    ];
    return {
      url,
      history: [
        { role: "user", content: "look at chart.png" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_chart", name: "FileRead", arguments: '{"file_path":"chart.png"}' }],
        },
        { role: "tool", toolCallId: "call_chart", toolName: "FileRead", content: parts },
      ],
    };
  }

  test("the provider refusal is recovered in the same turn and later turns stay clean", async () => {
    // A structurally valid image the provider still refuses: the recovery,
    // not the structural check, has to handle it.
    const { history, url } = await historyWithValidImage();
    const { provider, requests } = scriptedProvider(
      "deepseek",
      [reply("first answer"), reply("second answer")],
      (messages) => imageUrls(messages).length > 0,
    );
    const { session, events, state } = sessionFor(provider, "deepseek-flash", history);

    await drain(runTurn(session, ctxFor("deepseek-flash"), "describe the chart"));

    expect(turnFailures(events)).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(imageUrls(requests[0]!)).toEqual([url]);
    expect(imageUrls(requests[1]!)).toEqual([]);
    expect(toolText(requests[1]!, "call_chart")).toContain(
      "[Image not shown: deepseek refused the PNG image chart.png",
    );
    expect(
      events.some((event) =>
        event.msg.type === "warning" &&
        (event.msg.payload as { cause?: string }).cause === "provider_rejected_image"),
    ).toBe(true);

    // The follow-up that failed in two seconds in conv-mucyox5d.
    await drain(runTurn(session, ctxFor("deepseek-flash"), "Continue with items 4 to 7."));

    expect(turnFailures(events)).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(imageUrls(requests[2]!)).toEqual([]);
    // History still holds the image: nothing durable was rewritten.
    expect(imageUrls(state.history)).toContain(url);
  });

  test("a refusal does not hide the image from a vision model the user switches to", async () => {
    // Review finding: refusals were kept for the whole session, so after a
    // switch to a model that accepts the image the request still had a note.
    const { history, url } = await historyWithValidImage();
    let route = "deepseek";
    const { provider, requests } = scriptedProvider(
      "deepseek",
      [reply("first answer"), reply("claude answer"), reply("deepseek again")],
      (messages) => route === "deepseek" && imageUrls(messages).length > 0,
    );
    const { session, events } = sessionFor(provider, "deepseek-flash", history);
    const switchTo = (providerName: string, model: string): void => {
      route = providerName;
      (provider as { name: string }).name = providerName;
      (session as { config: Config }).config = { ...session.config, model };
    };

    await drain(runTurn(session, ctxFor("deepseek-flash"), "describe the chart"));
    expect(requests).toHaveLength(2);
    expect(imageUrls(requests[1]!)).toEqual([]);

    switchTo("anthropic", "claude-sonnet-5");
    await drain(runTurn(session, ctxFor("claude-sonnet-5"), "and now?"));
    expect(requests).toHaveLength(3);
    expect(imageUrls(requests[2]!)).toEqual([url]);

    // Back on the model that refused it, the image stays out without a new failure.
    switchTo("deepseek", "deepseek-flash");
    await drain(runTurn(session, ctxFor("deepseek-flash"), "once more"));
    expect(requests).toHaveLength(4);
    expect(imageUrls(requests[3]!)).toEqual([]);
    expect(turnFailures(events)).toEqual([]);
  });

  test("more refused images than the old store cap still recover with one retry", async () => {
    // Review finding: the store evicted refusals beyond 512, so each retry
    // put an evicted image back into the request and the turn never
    // recovered. The provider gives up after eight calls to keep that loop
    // short when it happens.
    const images = distinctPngDataUrls(600);
    const content: LLMContentPart[] = [
      { type: "text", text: "600 screenshots" },
      ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ];
    const history: LLMMessage[] = [
      { role: "user", content: "take the screenshots" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_shots", name: "screenshots", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call_shots", toolName: "screenshots", content },
    ];
    let calls = 0;
    const { provider, requests } = scriptedProvider(
      "deepseek",
      [reply("recovered")],
      (messages) => {
        calls += 1;
        if (calls > 8) throw new Error("scripted provider stopped after eight calls");
        return imageUrls(messages).length > 0;
      },
    );
    // 600 images are well inside DeepSeek's real 1M window.
    const window = 1_048_576;
    const { session, events } = sessionFor(provider, "deepseek-flash", history, window);

    await drain(runTurn(session, ctxFor("deepseek-flash", window), "continue"));

    expect(turnFailures(events)).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(imageUrls(requests[0]!)).toHaveLength(600);
    expect(imageUrls(requests[1]!)).toEqual([]);
  });

  test("refusals are forgotten once their images leave history, never before", async () => {
    // Review finding: every refusal was kept for the rest of the session, so
    // a long session that kept reading images the model refused grew the
    // records without bound. Each turn here reads a new image and the older
    // one leaves history, as a compaction would take it.
    const images = distinctPngDataUrls(12);
    const toolResult = (url: string, index: number): LLMMessage[] => [
      { role: "user", content: `read shot ${index}` },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: `call_${index}`, name: "screenshot", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: `call_${index}`,
        toolName: "screenshot",
        content: [{ type: "image_url", image_url: { url } }],
      },
    ];
    const { provider, requests } = scriptedProvider(
      "deepseek",
      [],
      (messages) => imageUrls(messages).length > 0,
    );
    const { session, events, state } = sessionFor(provider, "deepseek-flash");
    const route = imageRoute("deepseek", "deepseek-flash");

    for (const [index, url] of images.entries()) {
      state.history.splice(0, state.history.length, ...toolResult(url, index));
      await drain(runTurn(session, ctxFor("deepseek-flash"), `turn ${index}`));
      expect(rejectedImagesFor(session, route)?.size).toBe(1);
    }
    expect(turnFailures(events)).toEqual([]);
    expect(requests).toHaveLength(images.length * 2);

    // The image still in history stays recorded, so it stays out without a
    // new refusal.
    await drain(runTurn(session, ctxFor("deepseek-flash"), "once more"));
    expect(requests).toHaveLength(images.length * 2 + 1);
    expect(imageUrls(requests.at(-1)!)).toEqual([]);

    // With no refused image left in history, nothing is kept.
    state.history.splice(0, state.history.length, { role: "user", content: "text only" });
    await drain(runTurn(session, ctxFor("deepseek-flash"), "plain"));
    expect(rejectedImagesFor(session, route)).toBeUndefined();
    expect(turnFailures(events)).toEqual([]);
  });

  test("a restarted session with the refused image in its history recovers again", async () => {
    const { history } = await historyWithValidImage();
    const { provider, requests } = scriptedProvider(
      "deepseek",
      [reply("recovered")],
      (messages) => imageUrls(messages).length > 0,
    );
    const { session, events } = sessionFor(provider, "deepseek-flash", history);

    await drain(runTurn(session, ctxFor("deepseek-flash"), "continue"));

    expect(turnFailures(events)).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(imageUrls(requests[1]!)).toEqual([]);
  });

  test("a refusal that is not about an image still fails the turn", async () => {
    const { history } = await historyWithValidImage();
    const requests: LLMMessage[][] = [];
    const provider = {
      name: "deepseek",
      chat: async () => reply("summary"),
      chatStream: async (messages: LLMMessage[]) => {
        requests.push(messages);
        throw new LLMProviderError("deepseek", "Invalid parameter: tools[0].function.name", 400);
      },
      healthCheck: async () => true,
    } as unknown as LLMProvider;
    const { session, events } = sessionFor(provider, "deepseek-flash", history);

    await drain(runTurn(session, ctxFor("deepseek-flash"), "continue"));

    expect(requests).toHaveLength(1);
    expect(turnFailures(events)).toHaveLength(1);
  });
});
