import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthBackend } from "../../../src/auth/backend.js";
import { ManagedImageError, type AuthImageGenerationRequest } from "../../../src/auth/image-generation.js";
import { createImagineImageTool } from "../../../src/tools/system/imagine-image.js";
import { mediaTestHome } from "./media-test-helpers.js";
import { attachToolRuntimeContext, type ToolRuntimeAttemptContext } from "../../../src/tools/runtimes/context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(accessOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "agenc-managed-image-")); roots.push(root);
  const auth = {
    getImageGenerationAccess: vi.fn(async () => ({ enabled: true, available: true,
      model: { id: "qwen-image-2.1", name: "Qwen Image 2.1" }, sizes: ["1024x1024"], maxImages: 1, priceUsd: 0,
      quota: { dailyLimit: 10, remaining: 10 }, ...accessOverrides })),
    generateImage: vi.fn(async (request: AuthImageGenerationRequest) => ({ bytes: Buffer.from("synthetic image"), model: "qwen-image-2.1", requestId: request.requestId, priceUsd: 0 })),
  };
  const fetchImpl = vi.fn();
  const tool = createImagineImageTool({ workspaceRoot: root, home: mediaTestHome(root), env: { XAI_API_KEY: "synthetic-independent-paid-key" },
    getSession: () => ({ services: { provider: { name: "agenc" }, authBackend: auth as unknown as AuthBackend } }), fetchImpl });
  return { root, auth, tool, fetchImpl };
}
it("uses explicit free media from an independent chat session and reports zero cost", async () => {
  const { root, tool, auth, fetchImpl } = await fixture();
  expect(tool.admissionEstimate?.({ provider: "agenc", prompt: "test" })?.maxCostUsd).toBe(0);
  const result = await tool.execute({ provider: "agenc", prompt: "test" });
  const output = JSON.parse(result.content);
  expect(result.isError).not.toBe(true);
  expect(result.admissionUsage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  expect(output).toMatchObject({ backend: "agenc", model: "qwen-image-2.1", n: 1, priceUsd: 0 });
  expect(output.path.startsWith(join(root, ".agenc", "imagine"))).toBe(true);
  expect(await readFile(output.path, "utf8")).toBe("synthetic image");
  expect(auth.generateImage).toHaveBeenCalledTimes(1); expect(fetchImpl).not.toHaveBeenCalled();
  expect(tool.requiresApproval).toBe(true); expect(tool.isReadOnly).toBe(false);
});
it.each([{ available: false }, { quota: { dailyLimit: 10, remaining: 0 } }])("refuses unavailable/free-quota access without paid fallback", async overrides => {
  const { root, tool, auth, fetchImpl } = await fixture(overrides);
  expect((await tool.execute({ provider: "agenc", prompt: "test" })).isError).toBe(true);
  expect(auth.generateImage).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});
it.each([{ n: 2 }, { resolution: "2k" }, { aspect_ratio: "16:9" }, { prompt: "x".repeat(4001) }])("validates the free image contract before any request", async args => {
  const { tool, auth } = await fixture();
  expect((await tool.execute({ provider: "agenc", prompt: "test", ...args })).isError).toBe(true);
  expect(auth.getImageGenerationAccess).not.toHaveBeenCalled(); expect(auth.generateImage).not.toHaveBeenCalled();
});
it("retains uncertainty and does not automatically retry an admitted unknown outcome", async () => {
  const { tool, auth, fetchImpl } = await fixture();
  auth.generateImage.mockRejectedValue(new ManagedImageError("The request outcome is unknown.", false, "image_generation_outcome_unknown"));
  const result = await tool.execute({ provider: "agenc", prompt: "test" });
  expect(result.isError).toBe(true); expect(result.effectDisposition).toBeUndefined();
  expect(auth.generateImage).toHaveBeenCalledTimes(1); expect(fetchImpl).not.toHaveBeenCalled();
});
it("keeps an explicit native image model on its configured credential route", async () => {
  const { tool, auth, fetchImpl } = await fixture();
  fetchImpl.mockResolvedValue(Response.json({ data: [{ b64_json: Buffer.from("native image").toString("base64") }] }));
  const result = await tool.execute({ model: "grok-imagine-image", prompt: "test" });
  expect(JSON.parse(result.content)).toMatchObject({ backend: "xai", model: "grok-imagine-image" });
  expect(auth.getImageGenerationAccess).not.toHaveBeenCalled();
  expect(auth.generateImage).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("accepts the managed model in the advertised schema alongside native image models", async () => {
  const { tool, auth } = await fixture();
  expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).model?.enum).toContain("qwen-image-2.1");
  expect((await tool.execute({ model: "qwen-image-2.1", prompt: "test" })).isError).not.toBe(true);
  expect(auth.generateImage).toHaveBeenCalledTimes(1);
});
it("honors explicit auto even when chat uses AgenC and free image access exists", async () => {
  const { tool, auth, fetchImpl } = await fixture();
  fetchImpl.mockResolvedValue(Response.json({ data: [{ b64_json: Buffer.from("native image").toString("base64") }] }));
  const result = await tool.execute({ provider: "auto", prompt: "test" });
  expect(JSON.parse(result.content)).toMatchObject({ backend: "xai" });
  expect(auth.getImageGenerationAccess).not.toHaveBeenCalled();
  expect(auth.generateImage).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

function trustedArgs(sessionId = "conversation-stable", turnId = "turn-stable", callId = "call-stable") {
  const args = { provider: "agenc", prompt: "test" };
  attachToolRuntimeContext(args, { callId, toolName: "ImagineImage", sandboxMode: "workspace_write",
    invocation: { session: { conversationId: sessionId }, turn: { subId: turnId } } } as ToolRuntimeAttemptContext);
  return args;
}
it("reuses the scoped durable invocation UUID after an unknown result and tool reconstruction", async () => {
  const first = await fixture();
  first.auth.generateImage.mockRejectedValue(new ManagedImageError("Unknown outcome", false, "image_generation_outcome_unknown"));
  expect((await first.tool.execute(trustedArgs())).effectDisposition).toBeUndefined();
  const firstId = first.auth.generateImage.mock.calls[0]![0].requestId;
  const reconstructed = await fixture();
  expect((await reconstructed.tool.execute(trustedArgs())).isError).not.toBe(true);
  expect(reconstructed.auth.generateImage.mock.calls[0]![0].requestId).toBe(firstId);
  expect((await reconstructed.tool.execute(trustedArgs())).isError).not.toBe(true);
  expect(reconstructed.auth.generateImage.mock.calls.at(-1)![0].requestId).toBe(firstId);
  expect(firstId).toMatch(/^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(reconstructed.tool.recoveryCategory).toBe("side-effecting");
  for (const args of [trustedArgs("another-session"), trustedArgs(undefined, "another-turn"), trustedArgs(undefined, undefined, "another-call")]) {
    await reconstructed.tool.execute(args);
    expect(reconstructed.auth.generateImage.mock.calls.at(-1)![0].requestId).not.toBe(firstId);
  }
});
it("ignores caller-supplied call IDs and unsigned runtime contexts", async () => {
  const { tool, auth } = await fixture();
  const forged = { provider: "agenc", prompt: "test", __callId: "call-stable", __agencSessionId: "conversation-stable",
    __toolRuntimeContext: { callId: "call-stable", toolName: "ImagineImage", sandboxMode: "workspace_write",
      invocation: { session: { conversationId: "conversation-stable" }, turn: { subId: "turn-stable" } } } };
  await tool.execute(forged); await tool.execute(forged);
  expect(auth.generateImage.mock.calls[0]![0].requestId).not.toBe(auth.generateImage.mock.calls[1]![0].requestId);
});
