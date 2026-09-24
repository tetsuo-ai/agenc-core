import { afterEach, describe, expect, it, vi } from "vitest";
const fileRace = vi.hoisted(() => ({ target: "", switched: false, restored: false, switchAncestor: undefined as undefined | (() => Promise<void>), restoreAncestor: undefined as undefined | (() => Promise<void>) }));
const fsyncFailure = vi.hoisted(() => ({ enabled: false, directoryCalls: 0 }));
const fileOpens = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: (fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) {
      fsyncFailure.directoryCalls += 1;
      if (fsyncFailure.enabled) throw Object.assign(new Error("I/O failure"), { code: "EIO" });
    }
    return fs.fsyncSync(fd);
  } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => { fileOpens.count += 1; return fs.open(...args); }, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === fileRace.target && fileRace.switched && !fileRace.restored) {
      await fileRace.restoreAncestor?.(); fileRace.restored = true;
    }
    return fs.lstat(...args);
  }, realpath: async (...args: Parameters<typeof fs.realpath>) => {
    const resolved = await fs.realpath(...args);
    if (String(args[0]) === fileRace.target) { await fileRace.switchAncestor?.(); fileRace.switched = true; }
    return resolved;
  } };
});
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, symlink, rm, truncate, mkdir, rename } from "node:fs/promises";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeMcpToolOutput } from "../../src/mcp-client/tool-output.js";
import { DISPLAY_ATTACHMENT_LIMIT, DISPLAY_JSON_LIMIT, validateDisplayBlock } from "../../src/mcp-client/display-attachments.js";
import { DEFAULT_VERIFIED_READ_CONTEXT } from "../../src/fs/verified-read.js";
import { persistDisplayArtifactBytes, persistDisplayAttachments, readDisplayArtifact, readDisplayArtifactChunk, DISPLAY_ARTIFACT_CHUNK_BYTES } from "../../src/session/display-artifact-store.js";
import type { Event } from "../../src/session/event-log.js";
import { mkSession } from "../fixtures.js";
import { redactSecretsInValue } from "../../src/secrets/sanitizer.js";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";
import { toToolCatalogPolicyConfig } from "../../src/mcp-client/resilient-client.js";
import { redactMcpAttachmentValue } from "../../src/mcp-client/local-control.js";

const directories: string[] = [];
afterEach(async () => { fsyncFailure.enabled = false; fsyncFailure.directoryCalls = 0; fileOpens.count = 0; fileRace.target = ""; fileRace.switched = false; fileRace.restored = false; fileRace.switchAncestor = undefined; fileRace.restoreAncestor = undefined; vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const user = { audience: ["user"] };
const chart = { version: 1, kind: "timeseries", title: "NVDA, daily", series: [{ name: "Close", type: "line", data: [{ time: "2026-06-08", value: 100 }, { time: "2026-08-28", value: 110 }] }] };
const table = { version: 1, title: "Holdings", columns: [{ key: "symbol", label: "Symbol" }], rows: [{ symbol: "NVDA" }] };
const resource = (mimeType: string, data: unknown) => ({ type: "resource", annotations: user, resource: { uri: "agenc:test", mimeType, text: JSON.stringify(data) } });
const normalize = (content: unknown[], displayRoots: string[] = []) => normalizeMcpToolOutput({ raw: { content }, serverName: "fixture", toolName: "show", callId: "call-1", environment: { MAX_MCP_OUTPUT_TOKENS: "100000" }, logger, displayRoots, displayDataRoot: displayRoots[0] });
const attachments = (result: Awaited<ReturnType<typeof normalize>>) => result.metadata?.displayAttachments as Array<{ id: string; kind: string; title: string; data?: unknown }> | undefined;

describe("display attachments and saved plugin secrets", () => {
  const secret = "s3cret-\"quoted\"-value";
  const normalizeWithSecret = (content: unknown[]) => normalizeMcpToolOutput({ raw: { content }, serverName: "plugin:demo:show", toolName: "show", callId: "call-secret", environment: { MAX_MCP_OUTPUT_TOKENS: "100000" }, logger, displayRoots: [], sensitiveHeaders: { token: secret } });
  it.each([
    ["a chart series name", resource("application/vnd.agenc.chart+json", { ...chart, series: [{ ...chart.series[0], name: `Close ${secret}` }] })],
    ["a table cell", resource("application/vnd.agenc.table+json", { ...table, rows: [{ symbol: secret }] })],
  ])("redacts %s while retaining a valid display attachment", async (_where, block) => {
    const result = await normalizeWithSecret([block]);
    expect(attachments(result)).toHaveLength(1);
    expect(JSON.stringify(attachments(result))).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("s3cret-");
  });
  it("omits an embedded file containing a saved secret", async () => {
    const result = await normalizeWithSecret([{ type: "resource", annotations: user, resource: { uri: "agenc:test", name: "notes.txt", mimeType: "text/plain", blob: Buffer.from(`token=${secret}`).toString("base64") } }]);
    expect(attachments(result)).toBeUndefined();
    expect(result.content).toContain("contained a saved secret");
  });
  it("redacts an unknown chart kind in a model-facing resource", async () => {
    const secret = "private-phrase";
    const raw = redactMcpAttachmentValue({ content: [{
      type: "resource",
      resource: { uri: "agenc:chart", mimeType: "application/vnd.agenc.chart+json", text: JSON.stringify({ kind: secret }) },
    }] }, { token: secret }, undefined, "tool-result");
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: "call-kind", environment: {}, logger });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.content).toContain("[REDACTED]");
  });
  it.each([
    ["series type", "application/vnd.agenc.chart+json", { ...chart, series: [{ ...chart.series[0], type: "private-phrase" }] }],
    ["series scale", "application/vnd.agenc.chart+json", { ...chart, series: [{ ...chart.series[0], scale: "private-phrase" }] }],
    ["currency", "application/vnd.agenc.chart+json", { ...chart, currency: "private-phrase" }],
    ["table column key", "application/vnd.agenc.table+json", { ...table, columns: [{ key: "private-phrase", label: "Symbol" }], rows: [{ "private-phrase": "NVDA" }] }],
    ["table column format", "application/vnd.agenc.table+json", { ...table, columns: [{ key: "symbol", label: "Symbol", format: "private-phrase" }] }],
  ])("redacts plugin payload in %s on a model-facing resource", async (_field, mimeType, data) => {
    const secret = "private-phrase";
    const raw = redactMcpAttachmentValue({ content: [{ type: "resource", resource: { uri: "agenc:data", mimeType, text: JSON.stringify(data) } }] }, { token: secret }, undefined, "tool-result");
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: "call-payload", environment: {}, logger });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.content).toContain("[REDACTED]");
  });
  it("does not treat a timeseries type as structure in a category chart", () => {
    const input = { type: "resource", resource: { mimeType: "application/vnd.agenc.chart+json", text: JSON.stringify({ kind: "category", series: [{ type: "line" }] }) } };
    const safe = redactMcpAttachmentValue(input, { token: "line" }, undefined, "content-block");
    expect(safe.resource.text).toContain('"type":"[REDACTED]"');
  });
  it.each(["title", "rows", "line", "price"])("keeps display schema and Core defaults when the saved secret is %s", async value => {
    const headers = { token: value };
    const chartInput = value === "title" ? { ...chart, title: value } : chart;
    const tableInput = value === "line" ? { ...table, columns: [{ key: "type", label: "Type" }], rows: [{ type: value }] }
      : value === "rows" ? { ...table, rows: [{ symbol: value }] }
      : value === "title" ? { ...table, title: value } : table;
    const content = [resource("application/vnd.agenc.chart+json", chartInput), resource("application/vnd.agenc.table+json", tableInput)];
    const raw = redactMcpAttachmentValue({ content }, headers, undefined, "tool-result");
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: `call-${value}`, environment: {}, logger, sensitiveHeaders: headers });
    expect(attachments(result)?.map(item => item.kind)).toEqual(["chart", "table"]);
    expect(result.content).not.toContain("could not be shown");
    expect((attachments(result)?.[0]?.data as typeof chart).series[0]?.type).toBe("line");
    expect((attachments(result)?.[0]?.data as typeof chart).series[0]?.scale).toBe("price");
    if (value === "line") expect((attachments(result)?.[1]?.data as typeof tableInput).rows[0]?.type).toBe("[REDACTED]");
    if (value === "rows") expect((attachments(result)?.[1]?.data as typeof table).rows[0]?.symbol).toBe("[REDACTED]");
    if (value === "title") expect(attachments(result)?.map(item => item.title)).toEqual(["[REDACTED]", "[REDACTED]"]);
  });
  it.each([
    ["an embedded file", { type: "resource", annotations: user, resource: { uri: "agenc:test", name: "notes.txt", mimeType: "text/plain", blob: Buffer.from(`notes ${secret}`).toString("base64") } }],
    ["an image", { type: "image", annotations: user, mimeType: "image/png", data: Buffer.from(`png ${secret}`).toString("base64") }],
  ])("does not show %s the bridge already emptied for holding a saved secret", async (_what, block) => {
    // Same order as the MCP bridge: redact the raw result, then normalize it.
    const headers = { token: secret };
    const raw = redactMcpAttachmentValue({ content: [block] }, headers, undefined, "tool-result");
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: "call-secret", environment: { MAX_MCP_OUTPUT_TOKENS: "100000" }, logger, displayRoots: [], sensitiveHeaders: headers });
    expect(attachments(result)).toBeUndefined();
    expect(result.content).toContain("[Display attachment could not be shown: contained a saved secret]");
    expect(result.content).not.toContain("0 bytes");
  });
  it.each(["user", "audience"])("keeps a user-only table away from the model when a saved secret is %j", async (value) => {
    // Same order as the MCP bridge: redact the raw result, then normalize it.
    const headers = { token: value };
    const raw = redactMcpAttachmentValue({ content: [resource("application/vnd.agenc.table+json", table)] }, headers, undefined, "tool-result");
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: "call-secret", environment: { MAX_MCP_OUTPUT_TOKENS: "100000" }, logger, displayRoots: [], sensitiveHeaders: headers });
    expect(attachments(result)).toHaveLength(1);
    expect(result.content).not.toContain("NVDA");
    expect(JSON.stringify(result.codeModeResult ?? null)).not.toContain("NVDA");
  });
  it.each(["json", "image", "table"])("keeps MIME routing when a saved secret is %j", async (value) => {
    const headers = { token: value };
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const raw = redactMcpAttachmentValue({ content: [
      resource("application/vnd.agenc.table+json", table),
      { type: "image", annotations: user, mimeType: "image/png", data: png.toString("base64"), name: "Plot" },
    ] }, headers, undefined, "tool-result");
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: "call-secret", environment: { MAX_MCP_OUTPUT_TOKENS: "100000" }, logger, displayRoots: [], sensitiveHeaders: headers });
    expect(attachments(result)?.map(item => item.kind)).toEqual(["table", "image"]);
  });
  it.each(["resource", "text"])("keeps a user-only table when a saved secret is %j", async value => {
    const headers = { token: value };
    const raw = redactMcpAttachmentValue({ content: [resource("application/vnd.agenc.table+json", table)] }, headers, undefined, "tool-result");
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: "call-table", environment: {}, logger, sensitiveHeaders: headers });
    expect(attachments(result)?.map(item => item.kind)).toEqual(["table"]);
    expect(JSON.stringify(result.codeModeResult)).not.toContain('"symbol":"NVDA"');
  });
  it("keeps a file link URI scheme through redaction and display routing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-link-"));
    directories.push(root);
    const path = join(root, "report.txt");
    await writeFile(path, "report bytes");
    const uri = pathToFileURL(path).href;
    const raw = redactMcpAttachmentValue({ content: [{ type: "resource_link", annotations: user, uri, name: "report.txt", mimeType: "text/plain" }] }, { token: "file" }, undefined, "tool-result");
    expect(raw.content[0]!.uri).toBe(uri);
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: "call-file", environment: {}, logger, displayRoots: [root], displayDataRoot: root });
    expect(result.content).not.toContain("file link must use a file: URI");
    if (process.platform === "linux") expect(attachments(result)?.map(item => item.kind)).toEqual(["file"]);
  });
  it.each(["image/png; charset=binary", "image/jpg"])("retains routed model image MIME %s", async mimeType => {
    const sharp = (await import("sharp")).default;
    const bytes = mimeType.includes("jpg")
      ? await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).jpeg().toBuffer()
      : await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const headers = { token: "image" };
    const raw = redactMcpAttachmentValue({ content: [{ type: "image", mimeType, data: bytes.toString("base64") }] }, headers, undefined, "tool-result");
    const result = await normalizeMcpToolOutput({ raw, serverName: "plugin:demo:show", toolName: "show", callId: "call-image", environment: {}, logger, sensitiveHeaders: headers });
    expect(result.contentItems?.some(item => item.type === "input_image")).toBe(true);
  });
  it("still shows an attachment without a saved secret", async () => {
    const result = await normalizeWithSecret([resource("application/vnd.agenc.chart+json", chart)]);
    expect(attachments(result)).toHaveLength(1);
  });
});

describe("MCP user audience display attachments", () => {
  it("does not treat a user configured AGENC_PLUGIN_DATA variable as an AgenC created plugin directory", () => {
    expect(toToolCatalogPolicyConfig({ name: "configured", env: { AGENC_PLUGIN_DATA: "/workspace/untrusted" } })?.displayDataRoot).toBeUndefined();
    expect(toToolCatalogPolicyConfig({ name: "plugin", pluginSandbox: {
      mode: "stdio-child-process", pluginName: "plugin", pluginRoot: "/plugin", pluginDataDir: "/trusted/data", serverName: "server", scopedServerName: "plugin.server",
    } })?.displayDataRoot).toBe("/trusted/data");
  });
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
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const result = await normalize([
      resource("application/vnd.agenc.table+json", table),
      { type: "image", annotations: user, mimeType: "image/png", data: png.toString("base64"), name: "Plot" },
      { type: "resource", annotations: user, resource: { uri: "agenc:talk.ics", name: "talk.ics", mimeType: "text/calendar", blob: Buffer.from("BEGIN:VCALENDAR\nEND:VCALENDAR\n").toString("base64") } },
    ]);
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

  it.skipIf(process.platform !== "linux")("confines file links against outside paths, symlink escape and missing files", async () => {
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

  it.skipIf(process.platform !== "linux")("rejects an ancestor switched to an outside symlink between confinement and open", async () => {
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
      }, root)).rejects.toThrow();
      expect(switched).toBe(true);
    } finally { fileRace.target = ""; fileRace.switchAncestor = undefined; }
  });

  it.skipIf(process.platform !== "linux")("keeps the authorized root when an ancestor changes before root binding", async () => {
    const base = await mkdtemp(join(tmpdir(), "display-root-bind-race-")); directories.push(base);
    const outside = await mkdtemp(join(tmpdir(), "display-root-bind-outside-")); directories.push(outside);
    const slot = join(base, "slot"); await mkdir(slot);
    const root = join(slot, "allowed"); await mkdir(root);
    await writeFile(join(root, "secret.txt"), "inside");
    const outsideRoot = join(outside, "allowed"); await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, "secret.txt"), "OUTSIDE_SECRET_BYTES");
    const target = join(root, "secret.txt");
    fileRace.target = root;
    fileRace.switchAncestor = async () => {
      await rename(slot, join(base, "parked"));
      await symlink(outside, slot);
    };
    await expect(validateDisplayBlock({ type: "resource_link", uri: pathToFileURL(target).href, name: "secret.txt" }, [root])).rejects.toThrow();
    expect(fileRace.switched).toBe(true);
  });

  it.each(["darwin", "freebsd"])("refuses workspace file links on %s before an ancestor can be switched for the entire read", async (platform) => {
    const plugin = await mkdtemp(join(tmpdir(), "display-trusted-")); directories.push(plugin);
    const workspace = await mkdtemp(join(tmpdir(), "display-workspace-")); directories.push(workspace);
    const outside = await mkdtemp(join(tmpdir(), "display-outside-")); directories.push(outside);
    const slot = join(workspace, "slot"); await mkdir(slot);
    const target = join(slot, "secret.txt"); await writeFile(target, "inside");
    await writeFile(join(outside, "secret.txt"), "OUTSIDE_SECRET_BYTES");
    const parked = join(workspace, "parked");
    fileRace.target = slot;
    fileRace.switchAncestor = async () => { await rename(slot, parked); await symlink(outside, slot); };
    fileRace.restoreAncestor = async () => { await rm(slot); await rename(parked, slot); };
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    try {
      // Treating the workspace as a trusted root reproduces the reviewer's
      // schedule: switch after the first parent walk, restore before the last.
      await expect(validateDisplayBlock({ type: "resource_link", uri: pathToFileURL(target).href, name: "secret.txt" }, [workspace], DEFAULT_VERIFIED_READ_CONTEXT, workspace)).rejects.toThrow("send an embedded resource instead");
      expect(fileRace.switched).toBe(false);
      const result = await normalizeMcpToolOutput({ raw: { content: [{ type: "resource_link", annotations: user, uri: pathToFileURL(target).href, name: "secret.txt" }] }, serverName: "fixture", toolName: "show", callId: "call-1", environment: {}, logger, displayRoots: [plugin, workspace], displayDataRoot: plugin });
      expect(attachments(result)).toBeUndefined();
      expect(result.content).toContain("send an embedded resource instead");
      expect(result.content).not.toContain("OUTSIDE_SECRET_BYTES");
      expect(fileRace.switched).toBe(false);
    } finally { platformSpy.mockRestore(); }
  });

  it.each(["darwin", "freebsd"])("refuses a regular file in the plugin data directory on %s", async (platform) => {
    const plugin = await mkdtemp(join(tmpdir(), "display-trusted-")); directories.push(plugin);
    const path = join(plugin, "calendar.ics"); await writeFile(path, "BEGIN:VCALENDAR");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    try {
      const result = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(path).href, name: "calendar.ics", mimeType: "text/calendar" }], [plugin]);
      expect(attachments(result)).toBeUndefined();
      expect(result.content).toContain("send an embedded resource instead");
    } finally { platformSpy.mockRestore(); }
  });

  it.each(["darwin", "freebsd"])("rejects raced plugin data file links and accepts embedded file bytes on %s", async (platform) => {
    const plugin = await mkdtemp(join(tmpdir(), "display-plugin-race-")); directories.push(plugin);
    const outside = await mkdtemp(join(tmpdir(), "display-plugin-outside-")); directories.push(outside);
    const slot = join(plugin, "slot"); await mkdir(slot);
    const target = join(slot, "calendar.ics"); await writeFile(target, "inside");
    await writeFile(join(outside, "calendar.ics"), "OUTSIDE_SECRET_BYTES");
    const parked = join(plugin, "parked");
    fileRace.target = slot;
    fileRace.switchAncestor = async () => { await rename(slot, parked); await symlink(outside, slot); };
    fileRace.restoreAncestor = async () => { await rm(slot); await rename(parked, slot); };
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    try {
      const linked = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(target).href, name: "calendar.ics", mimeType: "text/calendar" }], [plugin]);
      expect(attachments(linked)).toBeUndefined();
      expect(linked.content).toContain("send an embedded resource instead");
      expect(fileRace.switched).toBe(false);
      const embedded = await normalize([{ type: "resource", annotations: user, resource: { uri: "agenc:calendar", mimeType: "text/calendar", blob: Buffer.from("BEGIN:VCALENDAR").toString("base64") } }], [plugin]);
      expect(attachments(embedded)).toMatchObject([{ kind: "file", mimeType: "text/calendar", size: 15 }]);
    } finally { platformSpy.mockRestore(); }
  });

  it("retries the parent directory fsync after first creation fails", async () => {
    const session = await mkdtemp(join(tmpdir(), "display-fsync-retry-")); directories.push(session);
    const result = await normalize([resource("application/vnd.agenc.table+json", table)]);
    const pending = result.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1];
    fsyncFailure.enabled = true;
    expect(() => persistDisplayAttachments(session, pending)).toThrow("I/O failure");
    expect(fsyncFailure.directoryCalls).toBe(1);
    fsyncFailure.enabled = false;
    persistDisplayAttachments(session, pending);
    expect(fsyncFailure.directoryCalls).toBe(3);
    expect(readDisplayArtifact(session, pending[0]!.id).length).toBeGreaterThan(0);
  });

  it("bounds nine unsupported large links before opening any file", async () => {
    const root = await mkdtemp(join(tmpdir(), "display-unsupported-")); directories.push(root);
    const path = join(root, "large.html"); await writeFile(path, ""); await truncate(path, 32 * 1024 * 1024);
    fileOpens.count = 0;
    const link = { type: "resource_link", annotations: user, uri: pathToFileURL(path).href, name: "large.html", mimeType: "text/html" };
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const result = await normalize(Array.from({ length: 9 }, () => link), [root]);
      expect(fileOpens.count).toBe(0);
      expect(attachments(result)).toBeUndefined();
      expect(result.content).toContain("unsupported file MIME type");
      expect(result.content).toContain("aggregate display budget exhausted");
    } finally { platformSpy.mockRestore(); }
  });

  it("keeps a 400 KB newest assistant answer fetchable in a bounded snapshot", async () => {
    const session = await mkdtemp(join(tmpdir(), "display-answer-session-")); directories.push(session);
    const answer = "answer".repeat(67_000);
    const items = [
      { type: "event_msg" as const, payload: { id: "user", eventId: "user", seq: 1, msg: { type: "user_message" as const, payload: { message: "short question" } } } },
      { type: "event_msg" as const, payload: { id: "assistant", eventId: "assistant", seq: 2, msg: { type: "agent_message" as const, payload: { message: answer } } } },
    ];
    const snapshot = sessionTranscriptV2FromRollout(items, "session", "run", undefined, session);
    const latest = snapshot.messages.at(-1);
    expect(latest?.role).toBe("assistant");
    expect(snapshot.messages[0]?.text).toBe("short question");
    expect(latest?.textArtifact?.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(readDisplayArtifact(session, latest!.textArtifact!.id).toString()).toBe(answer);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(384 * 1024);
  });

  it("bounds the 393,000-byte boundary answer within five seconds", () => {
    // Run the synchronous reconstruction in a child so an infinite pruning
    // loop fails the test without wedging the Vitest worker.
    const source = new URL("../../src/app-server/background-agent-runner/journal-reconstruction.ts", import.meta.url).href;
    const script = `import { sessionTranscriptV2FromRollout } from ${JSON.stringify(source)};
const answer = "A".repeat(393_000);
const snapshot = sessionTranscriptV2FromRollout([{ type: "event_msg", payload: { id: "answer", eventId: "answer", seq: 1, msg: { type: "agent_message", payload: { message: answer } } } }], "session", "run", undefined, process.env.DISPLAY_TEST_SESSION_DIR);
if (snapshot.messages.at(-1)?.textArtifact?.size !== 393_000 || Buffer.byteLength(JSON.stringify(snapshot)) > 384 * 1024) process.exit(2);`;
    const session = mkdtempSync(join(tmpdir(), "display-boundary-")); directories.push(session);
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      timeout: 5_000,
      encoding: "utf8",
      env: { ...process.env, DISPLAY_TEST_SESSION_DIR: session },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it("keeps a recent answer inline when removing older history makes it fit", () => {
    const older = "o".repeat(220_000);
    const latest = "n".repeat(220_000);
    const items = [older, latest].map((message, index) => ({ type: "event_msg" as const, payload: { id: `answer-${index}`, eventId: `answer-${index}`, seq: index + 1, msg: { type: "agent_message" as const, payload: { message } } } }));
    const snapshot = sessionTranscriptV2FromRollout(items, "session", "run");
    expect(snapshot.messages.at(-1)?.text).toBe(latest);
    expect(snapshot.messages.at(-1)?.textArtifact).toBeUndefined();
    expect(snapshot.truncated).toBe(true);
  });

  it("does not leak a private workspace path from an ENOENT file-link rejection", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "display-workspace-")); directories.push(workspace);
    const path = join(workspace, "USER_ONLY_PRIVATE_PAYLOAD", "absent");
    const result = await normalize([{ type: "resource_link", annotations: user, uri: pathToFileURL(path).href, name: "missing" }], [workspace]);
    expect(result.content).not.toContain("USER_ONLY_PRIVATE_PAYLOAD");
    expect(JSON.stringify(result.codeModeResult)).not.toContain("USER_ONLY_PRIVATE_PAYLOAD");
  });

  it("propagates directory fsync EIO before an attachment can be published as durable", async () => {
    const session = await mkdtemp(join(tmpdir(), "display-fsync-")); directories.push(session);
    await mkdir(join(session, "display-artifacts"));
    const result = await normalize([resource("application/vnd.agenc.table+json", table)]);
    fsyncFailure.enabled = true;
    expect(() => persistDisplayAttachments(session, result.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1])).toThrow("I/O failure");
  });

  it("does not recreate a removed session directory when publishing an artifact", async () => {
    const parent = await mkdtemp(join(tmpdir(), "display-removed-parent-")); directories.push(parent);
    const removedSession = join(parent, "removed-session");
    expect(() => persistDisplayArtifactBytes(removedSession, Buffer.from("answer"))).toThrow();
    expect(existsSync(removedSession)).toBe(false);
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
    const session = await mkdtemp(join(tmpdir(), "display-partial-session-")); directories.push(session);
    const bytes = Buffer.from("BEGIN:VCALENDAR\nEND:VCALENDAR\n");
    const result = await normalize([{ type: "resource", annotations: user, resource: { uri: "agenc:talk.ics", mimeType: "text/calendar", blob: bytes.toString("base64") } }]);
    const item = attachments(result)?.[0];
    expect(item).toBeDefined();
    await mkdir(join(session, "display-artifacts"));
    writeFileSync(join(session, "display-artifacts", item!.id), bytes.subarray(0, 10));
    persistDisplayAttachments(session, result.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1]);
    expect(readDisplayArtifact(session, item!.id)).toEqual(bytes);
  });

  it("serves a 13 MiB file in transport-sized chunks", async () => {
    const session = await mkdtemp(join(tmpdir(), "display-large-session-")); directories.push(session);
    const bytes = randomBytes(13 * 1024 * 1024);
    const result = await normalize([{ type: "resource", annotations: user, resource: { uri: "agenc:large.bin", mimeType: "application/octet-stream", blob: bytes.toString("base64") } }]);
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
    await mkdir(first);
    await mkdir(second);
    const bytes = Buffer.from("BEGIN:VCALENDAR");
    const id = createHash("sha256").update(bytes).digest("hex");
    const result = await normalize([{ type: "resource", annotations: user, resource: { uri: "agenc:talk.ics", mimeType: "text/calendar", blob: bytes.toString("base64") } }]);
    const pending = result.metadata?.displayAttachments as Parameters<typeof persistDisplayAttachments>[1];
    const stored = persistDisplayAttachments(first, pending);
    expect(stored[0]).not.toHaveProperty("pendingBytes");
    const duplicate = await normalize([{ type: "resource", annotations: user, resource: { uri: "agenc:talk.ics", mimeType: "text/calendar", blob: bytes.toString("base64") } }]);
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
