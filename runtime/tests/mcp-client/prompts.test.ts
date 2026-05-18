import { describe, expect, it, vi } from "vitest";
import { createPromptBridge } from "./prompts.js";

function makeClient(overrides: {
  listPrompts?: ReturnType<typeof vi.fn>;
  getPrompt?: ReturnType<typeof vi.fn>;
}) {
  return {
    listPrompts: overrides.listPrompts ?? vi.fn(),
    getPrompt: overrides.getPrompt ?? vi.fn(),
  };
}

describe("createPromptBridge", () => {
  it("lists + namespaces prompts", async () => {
    const client = makeClient({
      listPrompts: vi.fn().mockResolvedValue({
        prompts: [
          {
            name: "review_code",
            description: "review diff",
            arguments: [{ name: "path", required: true }],
          },
        ],
      }),
    });
    const bridge = await createPromptBridge(client, "srv");
    const items = await bridge.listPrompts();
    expect(items).toHaveLength(1);
    expect(items[0].namespacedName).toBe("mcp.srv.review_code");
    expect(items[0].arguments?.[0]).toEqual({ name: "path", required: true });
  });

  it("returns empty list on upstream error", async () => {
    const client = makeClient({
      listPrompts: vi.fn().mockRejectedValue(new Error("not supported")),
    });
    const bridge = await createPromptBridge(client, "srv");
    await expect(bridge.listPrompts()).resolves.toEqual([]);
  });

  it("renders a prompt into plain-text messages", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({
        description: "desc",
        messages: [
          { role: "user", content: { type: "text", text: "hello" } },
          { role: "assistant", content: "ok" },
        ],
      }),
    });
    const bridge = await createPromptBridge(client, "srv");
    const rendered = await bridge.renderPrompt("x");
    expect(rendered.messages).toHaveLength(2);
    expect(rendered.messages[0]).toEqual({ role: "user", text: "hello" });
    expect(rendered.messages[1]).toEqual({ role: "assistant", text: "ok" });
  });

  it("flattens arrays of text blocks", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
          },
        ],
      }),
    });
    const bridge = await createPromptBridge(client, "srv");
    const rendered = await bridge.renderPrompt("x");
    expect(rendered.messages[0].text).toBe("line 1\nline 2");
  });

  it("preserves rawContent for non-text payloads", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "user",
            content: { type: "image", data: "base64-blob" },
          },
        ],
      }),
    });
    const bridge = await createPromptBridge(client, "srv");
    const rendered = await bridge.renderPrompt("x");
    expect(rendered.messages[0].rawContent).toEqual({
      type: "image",
      data: "base64-blob",
    });
  });

  it("throws after disposal", async () => {
    const client = makeClient({
      getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    });
    const bridge = await createPromptBridge(client, "srv");
    await bridge.dispose();
    await expect(bridge.renderPrompt("x")).rejects.toThrow(/disposed/);
  });
});
