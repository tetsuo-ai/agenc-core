import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, symlink, rm, truncate, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeMcpToolOutput } from "../../src/mcp-client/tool-output.js";
import { DISPLAY_ATTACHMENT_LIMIT, DISPLAY_JSON_LIMIT } from "../../src/mcp-client/display-attachments.js";
import { persistDisplayAttachments, readDisplayArtifact } from "../../src/session/display-artifact-store.js";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const user = { audience: ["user"] };
const chart = { version: 1, kind: "timeseries", title: "NVDA, daily", series: [{ name: "Close", type: "line", data: [{ time: "2026-06-08", value: 100 }, { time: "2026-08-28", value: 110 }] }] };
const table = { version: 1, title: "Holdings", columns: [{ key: "symbol", label: "Symbol" }], rows: [{ symbol: "NVDA" }] };
const resource = (mimeType: string, data: unknown) => ({ type: "resource", annotations: user, resource: { uri: "agenc:test", mimeType, text: JSON.stringify(data) } });
const normalize = (content: unknown[], displayRoots: string[] = []) => normalizeMcpToolOutput({ raw: { content }, serverName: "fixture", toolName: "show", callId: "call-1", environment: { MAX_MCP_OUTPUT_TOKENS: "100000" }, logger, displayRoots });
const attachments = (result: Awaited<ReturnType<typeof normalize>>) => result.metadata?.displayAttachments as Array<{ id: string; kind: string; title: string; data?: unknown }> | undefined;

describe("MCP user audience display attachments", () => {
  it("splits mixed blocks, preserving assistant and unannotated content and only captions for user blocks", async () => {
    const result = await normalize([
      { type: "text", text: "ordinary" },
      resource("application/vnd.agenc.chart+json", chart),
      { type: "text", text: "assistant", annotations: { audience: ["assistant"] } },
      { type: "text", text: "both", annotations: { audience: ["assistant", "user"] } },
    ]);
    expect(result.content).toContain("ordinary");
    expect(result.content).toContain("assistant");
    expect(result.content).toContain("both");
    expect(result.content).toContain('chart "NVDA, daily", line (Close), 2 points, 2026-06-08 to 2026-08-28');
    expect(result.content).not.toContain('"value":100');
    expect(attachments(result)).toMatchObject([{ kind: "chart", title: "NVDA, daily", data: chart }]);
    const shown = attachments(result)![0]!;
    expect(shown.id).toBe(createHash("sha256").update(JSON.stringify(shown.data)).digest("hex"));
    expect(JSON.stringify(result.codeModeResult)).not.toContain('"value":100');
  });

  it("captions tables, images and files without exposing their bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "display-plugin-")); directories.push(root);
    const path = join(root, "talk.ics"); await writeFile(path, "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const result = await normalize([
      resource("application/vnd.agenc.table+json", table),
      { type: "image", annotations: user, mimeType: "image/png", data: png.toString("base64"), name: "Plot" },
      { type: "resource_link", annotations: user, uri: pathToFileURL(path).href, name: "talk.ics", mimeType: "text/calendar" },
    ], [root]);
    expect(result.content).toContain('table "Holdings", 1 row, 1 column');
    expect(result.content).toContain('image "Plot"');
    expect(result.content).toContain('file "talk.ics"');
    expect(result.content).not.toContain("BEGIN:VCALENDAR");
    expect(attachments(result)?.map(a => a.kind)).toEqual(["table", "image", "file"]);
    expect(result.contentItems).toBeUndefined();
  });

  it("fails closed for bad schemas, MIME types, JSON and all count and size limits", async () => {
    const invalid = await normalize([
      resource("application/vnd.agenc.chart+json", { ...chart, series: [] }),
      resource("application/vnd.agenc.table+json", { ...table, columns: Array.from({ length: 33 }, (_, i) => ({ key: String(i), label: String(i) })) }),
      { type: "resource", annotations: user, resource: { mimeType: "application/vnd.agenc.chart+json", text: "{" } },
      { type: "resource", annotations: user, resource: { mimeType: "text/html", text: "<script>" } },
      { type: "image", annotations: user, mimeType: "image/svg+xml", data: "PHN2Zz4=" },
      resource("application/vnd.agenc.chart+json", { ...chart, subtitle: "x".repeat(DISPLAY_JSON_LIMIT) }),
      resource("application/vnd.agenc.table+json", { ...table, title: "x".repeat(DISPLAY_JSON_LIMIT) }),
      resource("application/vnd.agenc.table+json", { ...table, rows: Array.from({ length: 1001 }, () => ({ symbol: "A" })) }),
    ]);
    expect(attachments(invalid)).toBeUndefined();
    expect(invalid.content.match(/Display attachment could not be shown/g)).toHaveLength(8);
    const many = await normalize(Array.from({ length: DISPLAY_ATTACHMENT_LIMIT + 1 }, () => resource("application/vnd.agenc.table+json", table)));
    expect(attachments(many)).toHaveLength(DISPLAY_ATTACHMENT_LIMIT);
    expect(many.content).toContain("limit of 8 attachments");
    const oversizedImage = await normalize([{ type: "image", annotations: user, mimeType: "image/png", data: "A".repeat(7_000_000) }]);
    expect(oversizedImage.content).toContain("could not be shown");
  });

  it("caps the sum of valid image bytes in a result", async () => {
    const sharp = (await import("sharp")).default;
    const bytes = await sharp(randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const image = { type: "image", annotations: user, mimeType: "image/png", data: bytes.toString("base64") };
    const result = await normalize([image, image]);
    expect(attachments(result)).toHaveLength(1);
    expect(result.content).toContain("images exceed 5 MiB per result");
  });

  it("confines file links against outside paths, symlink escape and missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "display-root-")); directories.push(root);
    const outside = await mkdtemp(join(tmpdir(), "display-outside-")); directories.push(outside);
    const outsidePath = join(outside, "secret.txt"); await writeFile(outsidePath, "secret");
    await symlink(outsidePath, join(root, "escape.txt"));
    for (const path of [outsidePath, join(root, "escape.txt"), join(root, "missing.txt")]) {
      const result = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(path).href, name: "secret.txt" }], [root]);
      expect(attachments(result)).toBeUndefined();
      expect(result.content).toContain("could not be shown");
    }
    const tooLarge = join(root, "large.pdf"); await writeFile(tooLarge, ""); await truncate(tooLarge, 32 * 1024 * 1024 + 1);
    const result = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(tooLarge).href, name: "large.pdf" }], [root]);
    expect(result.content).toContain("32 MiB");
  });

  it("stores bytes by digest, isolates sessions, survives reread and removes with its session", async () => {
    const base = await mkdtemp(join(tmpdir(), "display-session-")); directories.push(base);
    const first = join(base, "one"); const second = join(base, "two");
    const pluginRoot = join(base, "plugin"); await mkdir(pluginRoot);
    const bytes = Buffer.from("BEGIN:VCALENDAR");
    const file = join(pluginRoot, "talk.ics"); await writeFile(file, bytes);
    const id = createHash("sha256").update(bytes).digest("hex");
    const result = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(file).href, name: "talk.ics", mimeType: "text/calendar" }], [pluginRoot]);
    const pending = result.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1];
    const stored = persistDisplayAttachments(first, pending);
    expect(stored[0]).not.toHaveProperty("pendingBytes");
    const duplicate = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(file).href, name: "talk.ics", mimeType: "text/calendar" }], [pluginRoot]);
    expect(persistDisplayAttachments(first, duplicate.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1])).toEqual(stored);
    expect(readDisplayArtifact(first, id)).toEqual(bytes);
    expect(() => readDisplayArtifact(second, id)).toThrow();
    const event = { type: "event_msg" as const, payload: { id: "complete", eventId: "complete", seq: 1, msg: { type: "tool_call_completed" as const, payload: { callId: "c", result: '[Shown to the user: file "talk.ics"]', isError: false, displayAttachments: stored } } } };
    const transcript = sessionTranscriptV2FromRollout([event], "one", "run");
    expect(transcript.events).toContainEqual(expect.objectContaining({ type: "tool_call_completed", payload: expect.objectContaining({ displayAttachments: stored }) }));
    await rm(first, { recursive: true });
    expect(() => readDisplayArtifact(first, id)).toThrow();
    const tooLarge = Buffer.alloc(DISPLAY_JSON_LIMIT + 1);
    const largeId = createHash("sha256").update(tooLarge).digest("hex");
    expect(() => persistDisplayAttachments(second, [{ id: largeId, kind: "chart", title: "x", mimeType: "application/vnd.agenc.chart+json", size: tooLarge.length, digest: largeId }])).toThrow("size limit");
  });

  it("renders the caption in the TUI result", () => {
    const text = '[Shown to the user: chart "NVDA, daily", 2 points]';
    const state = adaptTranscriptEvents([{ type: "tool_call_started", payload: { callId: "c", toolName: "mcp.fixture.show", args: "{}" } }, { type: "tool_call_completed", payload: { callId: "c", result: text, isError: false } }]);
    expect(state.messages.find(message => message.type === "user")?.toolUseResult).toBe(text);
  });
});
