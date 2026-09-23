import { afterEach, describe, expect, it, vi } from "vitest";
const fileRace = vi.hoisted(() => ({ target: "", switchAncestor: undefined as undefined | (() => Promise<void>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, realpath: async (...args: Parameters<typeof fs.realpath>) => {
    const resolved = await fs.realpath(...args);
    if (String(args[0]) === fileRace.target) await fileRace.switchAncestor?.();
    return resolved;
  } };
});
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, symlink, rm, truncate, mkdir, rename } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeMcpToolOutput } from "../../src/mcp-client/tool-output.js";
import { DISPLAY_ATTACHMENT_LIMIT, DISPLAY_JSON_LIMIT, validateDisplayBlock } from "../../src/mcp-client/display-attachments.js";
import { DEFAULT_VERIFIED_READ_CONTEXT } from "../../src/fs/verified-read.js";
import { persistDisplayAttachments, readDisplayArtifact, readDisplayArtifactChunk, DISPLAY_ARTIFACT_CHUNK_BYTES } from "../../src/session/display-artifact-store.js";
import type { Event } from "../../src/session/event-log.js";
import { mkSession } from "../fixtures.js";
import { redactSecretsInValue } from "../../src/secrets/sanitizer.js";
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

  it("rejects an ancestor switched to an outside symlink between confinement and open", async () => {
    const root = await mkdtemp(join(tmpdir(), "display-race-root-")); directories.push(root);
    const outside = await mkdtemp(join(tmpdir(), "display-race-outside-")); directories.push(outside);
    const slot = join(root, "slot"); await mkdir(slot);
    const target = join(slot, "secret.txt"); await writeFile(target, "inside");
    await writeFile(join(outside, "secret.txt"), "outside secret");
    let switched = false;
    const switchAncestor = async () => {
      if (switched) return;
      switched = true;
      await rename(slot, join(root, "parked"));
      await symlink(outside, slot);
    };
    fileRace.target = target;
    fileRace.switchAncestor = switchAncestor;
    try {
      await expect(validateDisplayBlock({ type: "resource_link", uri: pathToFileURL(target).href, name: "secret.txt" }, [root], {
        ...DEFAULT_VERIFIED_READ_CONTEXT,
        beforeCandidateOpenForTesting: switchAncestor,
      })).rejects.toThrow();
      expect(switched).toBe(true);
    } finally { fileRace.target = ""; fileRace.switchAncestor = undefined; }
  });

  it("redacts tables before calculating their content digest and storage bytes", async () => {
    const result = await normalize([resource("application/vnd.agenc.table+json", { version: 1, title: "T", columns: [{ key: "token", label: "Token" }], rows: [{ token: 42 }] })]);
    const item = attachments(result)?.[0];
    expect(item?.data).toMatchObject({ rows: [{ token: "[REDACTED_SECRET]" }] });
    expect(item?.id).toBe(createHash("sha256").update(JSON.stringify(item?.data)).digest("hex"));
    const journalCopy = redactSecretsInValue({ displayAttachments: [item] });
    const replayed = journalCopy.displayAttachments[0]!;
    expect(createHash("sha256").update(JSON.stringify(replayed.data)).digest("hex")).toBe(replayed.digest);
    const dir = await mkdtemp(join(tmpdir(), "display-redacted-")); directories.push(dir);
    persistDisplayAttachments(dir, result.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1]);
    expect(readDisplayArtifact(dir, item!.id).toString()).toBe(JSON.stringify(item?.data));
  });

  it("keeps rejected schema keys out of both model projections", async () => {
    const result = await normalize([resource("application/vnd.agenc.table+json", { ...table, USER_ONLY_PRIVATE_PAYLOAD: "secret" })]);
    expect(result.content).toContain("invalid table schema");
    expect(result.content).not.toContain("USER_ONLY_PRIVATE_PAYLOAD");
    expect(JSON.stringify(result.codeModeResult)).not.toContain("USER_ONLY_PRIVATE_PAYLOAD");
  });

  it("bounds the complete completion row when eight near-limit tables are accepted", async () => {
    const data = { ...table, title: "x".repeat(523_000) };
    const result = await normalize(Array.from({ length: 8 }, () => resource("application/vnd.agenc.table+json", data)));
    expect(attachments(result)!.length).toBeLessThan(8);
    const event: Event = { id: "completion", msg: { type: "tool_call_completed", payload: { callId: "call", result: "ordinary output".repeat(1000), isError: false, metadata: result.metadata } } };
    const directory = await mkdtemp(join(tmpdir(), "display-row-bound-")); directories.push(directory);
    const { session } = mkSession();
    let committed: Event | undefined;
    session.rolloutStore = { store: { sessionDir: directory }, append: vi.fn((item: Event) => { committed = item; return true; }) } as unknown as typeof session.rolloutStore;
    session.emit(event);
    expect(Buffer.byteLength(JSON.stringify(committed))).toBeLessThan(4 * 1024 * 1024);
    expect(committed?.msg.type === "tool_call_completed" ? committed.msg.payload.displayAttachments?.length : 0).toBeLessThan(8);
  });

  it("repairs a partial digest path left by an interrupted direct write", async () => {
    const root = await mkdtemp(join(tmpdir(), "display-partial-root-")); directories.push(root);
    const session = await mkdtemp(join(tmpdir(), "display-partial-session-")); directories.push(session);
    const bytes = Buffer.from("BEGIN:VCALENDAR\nEND:VCALENDAR\n");
    const file = join(root, "talk.ics"); await writeFile(file, bytes);
    const result = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(file).href, name: "talk.ics", mimeType: "text/calendar" }], [root]);
    const item = attachments(result)?.[0];
    expect(item).toBeDefined();
    await mkdir(join(session, "display-artifacts"));
    writeFileSync(join(session, "display-artifacts", item!.id), bytes.subarray(0, 10));
    persistDisplayAttachments(session, result.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1]);
    expect(readDisplayArtifact(session, item!.id)).toEqual(bytes);
  });

  it("serves a 13 MiB file in transport-sized chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "display-large-root-")); directories.push(root);
    const session = await mkdtemp(join(tmpdir(), "display-large-session-")); directories.push(session);
    const bytes = randomBytes(13 * 1024 * 1024);
    const file = join(root, "large.bin"); await writeFile(file, bytes);
    const result = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(file).href, name: "large.bin" }], [root]);
    const item = attachments(result)?.[0];
    expect(item).toBeDefined();
    persistDisplayAttachments(session, result.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1]);
    let offset = 0;
    const chunks: Buffer[] = [];
    for (;;) {
      const chunk = readDisplayArtifactChunk(session, item!.id, offset);
      expect(chunk.data.length).toBeLessThanOrEqual(DISPLAY_ARTIFACT_CHUNK_BYTES);
      expect(Buffer.byteLength(JSON.stringify({ data: chunk.data.toString("base64") }))).toBeLessThan(1024 * 1024);
      chunks.push(chunk.data);
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(item!.id);
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
