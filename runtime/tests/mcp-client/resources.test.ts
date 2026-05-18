import { describe, expect, it, vi } from "vitest";
import {
  MAX_RESOURCE_BYTES,
  createResourceBridge,
} from "./resources.js";

function makeClient(overrides: {
  listResources?: ReturnType<typeof vi.fn>;
  readResource?: ReturnType<typeof vi.fn>;
}) {
  return {
    listResources: overrides.listResources ?? vi.fn(),
    readResource: overrides.readResource ?? vi.fn(),
  };
}

describe("createResourceBridge", () => {
  it("namespaces listed resource URIs", async () => {
    const client = makeClient({
      listResources: vi.fn().mockResolvedValue({
        resources: [
          { uri: "file:///foo.txt", mimeType: "text/plain" },
          { uri: "resource://bar" },
        ],
      }),
    });
    const bridge = await createResourceBridge(client, "srv");
    const items = await bridge.listResources();
    expect(items).toHaveLength(2);
    expect(items[0].namespacedName).toBe("mcp.srv.file:///foo.txt");
    expect(items[0].mimeType).toBe("text/plain");
  });

  it("returns empty list when upstream lacks resource support", async () => {
    const client = makeClient({
      listResources: vi.fn().mockRejectedValue(new Error("method not found")),
    });
    const bridge = await createResourceBridge(client, "srv");
    await expect(bridge.listResources()).resolves.toEqual([]);
  });

  it("reads a text resource without truncation", async () => {
    const client = makeClient({
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: "file://x", text: "hello" }],
      }),
    });
    const bridge = await createResourceBridge(client, "srv");
    const content = await bridge.readResource("file://x");
    expect(content.text).toBe("hello");
    expect(content.truncated).toBe(false);
    expect(content.bytesReturned).toBe(5);
  });

  it("I-76: truncates text resource exceeding 5MB cap", async () => {
    const big = "a".repeat(MAX_RESOURCE_BYTES + 1024);
    const client = makeClient({
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: "file://big", text: big }],
      }),
    });
    const bridge = await createResourceBridge(client, "srv");
    const content = await bridge.readResource("file://big");
    expect(content.truncated).toBe(true);
    expect(content.bytesReturned).toBeLessThanOrEqual(MAX_RESOURCE_BYTES);
    expect(content.text!.length).toBeLessThan(big.length);
  });

  it("reads a binary (blob) resource", async () => {
    const client = makeClient({
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: "file://b", blob: Buffer.from("binary").toString("base64") }],
      }),
    });
    const bridge = await createResourceBridge(client, "srv");
    const content = await bridge.readResource("file://b");
    expect(content.blob).toBeDefined();
    expect(content.truncated).toBe(false);
  });

  it("throws after disposal", async () => {
    const client = makeClient({
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: "file://x", text: "hi" }],
      }),
    });
    const bridge = await createResourceBridge(client, "srv");
    await bridge.dispose();
    await expect(bridge.readResource("file://x")).rejects.toThrow(/disposed/);
  });
});
