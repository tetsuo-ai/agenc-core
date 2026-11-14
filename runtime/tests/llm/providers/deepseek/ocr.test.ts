import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEEPSEEK_OCR_MAX_BYTES, runDeepSeekOcr } from "../../../../src/llm/providers/deepseek/ocr.js";
import { acquireDeepSeekOcrSlot, waitForDeepSeekToolSlot } from "../../../../src/llm/providers/deepseek/tool-rate-limit.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/standalone-ocr.json", import.meta.url), "utf8"));
const request = { endpoint: "https://api.deepseek.com/v1/tools/ocr", apiKey: "secret-test", bytes: new Uint8Array([1, 2, 3]), filename: "document.docx" };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("DeepSeek OCR", () => {
  test("parses the recorded response and bills pages rather than usage tokens", async () => {
    const transport = vi.fn(async () => new Response("\n\n" + JSON.stringify(fixture)));
    vi.stubGlobal("fetch", transport);
    const result = await runDeepSeekOcr(request);
    expect(result).toMatchObject({ kind: "text", pageCount: 1, costUsd: 0.000225, incomplete: false });
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(request.endpoint);
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ authorization: "Bearer secret-test", accept: "application/json" });
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(["purpose", "file"]);
    expect(form.get("purpose")).toBe("text_recognition");
    expect((form.get("file") as File).name).toBe("document.docx");
    expect([...new Uint8Array(await (form.get("file") as Blob).arrayBuffer())]).toEqual([1, 2, 3]);
  });
  test("marks length-limited pages incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...fixture, pages: [{ index: 0, text: "partial", finish_reason: "length" }] })));
    expect(await runDeepSeekOcr(request)).toMatchObject({ kind: "text", incomplete: true, costUsd: 0.000225 });
  });
  test.each([200, 400, 429, 503])("does not retry errors, including HTTP 200 recognition errors (%s)", async status => {
    const transport = vi.fn(async () => Response.json({ error: { message: "secret-test PRIVATE FILE CONTENT" } }, { status }));
    vi.stubGlobal("fetch", transport);
    const result = await runDeepSeekOcr(request);
    expect(result).toMatchObject({ kind: "failed", costUsd: 0 });
    expect(JSON.stringify(result)).not.toMatch(/secret-test|PRIVATE FILE CONTENT/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("keeps ambiguous transport charges unknown and never logs transport text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret-test PRIVATE FILE CONTENT"); }));
    const result = await runDeepSeekOcr(request);
    expect(result).toMatchObject({ kind: "failed", costUsd: null });
    expect(JSON.stringify(result)).not.toMatch(/secret-test|PRIVATE FILE CONTENT/);
  });
  test("rejects empty and oversized files without any request", async () => {
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    for (const bytes of [new Uint8Array(), new Uint8Array(DEEPSEEK_OCR_MAX_BYTES + 1)]) {
      expect(await runDeepSeekOcr({ ...request, bytes })).toMatchObject({ kind: "failed", costUsd: 0 });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  test("rejects invalid page counts and preserves a known fee for malformed page data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ page_count: 1001, pages: [] })));
    expect(await runDeepSeekOcr(request)).toMatchObject({ kind: "failed", costUsd: null });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ page_count: 1, pages: [] })));
    expect(await runDeepSeekOcr(request)).toMatchObject({ kind: "failed", costUsd: 0.000225 });
  });
  test("cancellation prevents upload", async () => {
    const controller = new AbortController(); controller.abort();
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    await expect(runDeepSeekOcr({ ...request, signal: controller.signal })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  test("limits recognitions across keys to fifteen including uncertain requests", () => {
    const slots: (() => void)[] = [];
    for (let n = 0; n < 16; n++) { const release = acquireDeepSeekOcrSlot(); if (release) slots.push(release); }
    expect(slots.length).toBeLessThanOrEqual(15);
    expect(acquireDeepSeekOcrSlot()).toBeUndefined();
    slots.forEach(release => release());
  });
  test.each(["search", "fetch"] as const)("paces %s starts and cancels queued calls", async api => {
    const signal = new AbortController().signal;
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 3 }, async () => { await waitForDeepSeekToolSlot(api, signal); starts.push(Date.now()); }));
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(api === "search" ? 18 : 76);
    const controller = new AbortController(); controller.abort();
    await expect(waitForDeepSeekToolSlot(api, controller.signal)).rejects.toThrow();
  });
});
