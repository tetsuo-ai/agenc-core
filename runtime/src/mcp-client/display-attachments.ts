import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { JsonValue } from "../app-server/protocol/index.js";
import { inspectImageBytes } from "../utils/image-validation.js";
import { redactSecretsInValue } from "../secrets/sanitizer.js";
import { assertCandidateUnchanged, bindVerifiedRoot, closeVerifiedHandle, DEFAULT_VERIFIED_READ_CONTEXT, descriptorRelativePath, identityFromStats, openVerifiedCandidate, verifyParentChain, type VerifiedReadContext } from "../fs/verified-read.js";

export const DISPLAY_JSON_LIMIT = 512 * 1024;
export const DISPLAY_BINARY_LIMIT = 5 * 1024 * 1024;
export const DISPLAY_FILE_LIMIT = 32 * 1024 * 1024;
export const DISPLAY_ATTACHMENT_LIMIT = 8;
export const DISPLAY_WORK_LIMIT = 64 * 1024 * 1024;
const FILE_ATTEMPT_COST = 8 * 1024 * 1024;
export interface DisplayWorkBudget { remainingBytes: number }
export function chargeDisplayWork(budget: DisplayWorkBudget, bytes: number): void {
  if (bytes > budget.remainingBytes) fail("aggregate display budget exhausted");
  budget.remainingBytes -= bytes;
}

export type DisplayAttachment = {
  readonly id: string;
  readonly kind: "chart" | "table" | "image" | "file";
  readonly title: string;
  readonly mimeType: string;
  readonly size: number;
  readonly digest: string;
  readonly data?: JsonValue;
};

const pendingArtifactBytes = new WeakMap<DisplayAttachment, Buffer>();
export function peekDisplayArtifactBytes(item: DisplayAttachment): Buffer | undefined { return pendingArtifactBytes.get(item); }
export function releaseDisplayArtifactBytes(item: DisplayAttachment): void { pendingArtifactBytes.delete(item); }

// Keep the timeseries rules identical to Desktop chartSpec.ts. Any change to
// these rules must be mirrored there before a new chart version is accepted.
const daily = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "use a real calendar date");
const time = z.union([daily, z.number().int().finite().refine(value => Number.isSafeInteger(value) && Number.isFinite(new Date(value * 1000).valueOf()), "use a representable UNIX timestamp in seconds")]);
const number = z.number().finite();
const valuePoint = z.object({ time, value: number }).strict();
const ohlcPoint = z.object({ time, open: number, high: number, low: number, close: number }).strict().superRefine((point, ctx) => {
  if (point.high < Math.max(point.open, point.close, point.low)) ctx.addIssue({ code: "custom", path: ["high"], message: "high must be at least open, close and low" });
  if (point.low > Math.min(point.open, point.close, point.high)) ctx.addIssue({ code: "custom", path: ["low"], message: "low must be at most open, close and high" });
});
const common = { name: z.string().trim().min(1), scale: z.enum(["price", "volume", "percent"]).default("price"), precision: z.number().int().min(0).max(8).optional() };
const valueSeries = z.object({ ...common, type: z.enum(["line", "area", "histogram"]), data: z.array(valuePoint).min(1).max(5000) }).strict();
const ohlcSeries = z.object({ ...common, type: z.enum(["candlestick", "bar"]), data: z.array(ohlcPoint).min(1).max(5000) }).strict();
const timeseries = z.object({
  version: z.literal(1), kind: z.literal("timeseries"), title: z.string().trim().min(1),
  subtitle: z.string().optional(), currency: z.string().regex(/^[A-Z]{3}$/, "use a three-letter ISO 4217 currency code").refine(value => ISO_CURRENCIES.has(value), "use an ISO 4217 currency code").optional(),
  series: z.array(z.union([valueSeries, ohlcSeries])).min(1).max(8),
  markers: z.array(z.object({ time, text: z.string().trim().min(1) }).strict()).max(50).optional(),
}).strict().superRefine((chart, ctx) => {
  const all = new Set<string>();
  let timeKind: "daily" | "intraday" | undefined;
  chart.series.forEach((series, index) => {
    if ((series.type === "bar" || series.type === "candlestick") && series.scale !== "price") ctx.addIssue({ code: "custom", path: ["series", index, "scale"], message: "OHLC series use the price scale" });
    let previous: string | number | undefined;
    series.data.forEach((point, pointIndex) => {
      const kind = typeof point.time === "string" ? "daily" : "intraday";
      if (timeKind !== undefined && kind !== timeKind) ctx.addIssue({ code: "custom", path: ["series", index, "data", pointIndex, "time"], message: "all series must use the same time format" });
      timeKind ??= kind;
      if (previous !== undefined && point.time <= previous) ctx.addIssue({ code: "custom", path: ["series", index, "data", pointIndex, "time"], message: "times must be ascending and unique" });
      previous = point.time;
      all.add(String(point.time));
    });
  });
  chart.markers?.forEach((marker, index) => {
    if (!all.has(String(marker.time))) ctx.addIssue({ code: "custom", path: ["markers", index, "time"], message: "marker time must match a data point" });
  });
});
const ISO_CURRENCIES = new Set([...Intl.supportedValuesOf("currency"), "XAU", "XAG", "XPT", "XPD", "XDR", "XTS", "XXX"]);
const category = z.object({ version: z.literal(1), kind: z.literal("category"), title: z.string().trim().min(1), categories: z.array(z.string().min(1)).min(1).max(5000), series: z.array(z.object({ name: z.string().min(1), values: z.array(number).min(1).max(5000) }).strict()).min(1).max(8) }).strict().superRefine((chart, ctx) => {
  chart.series.forEach((series, index) => { if (series.values.length !== chart.categories.length) ctx.addIssue({ code: "custom", path: ["series", index, "values"], message: "values must match categories" }); });
});
const xy = z.object({ version: z.literal(1), kind: z.literal("xy"), title: z.string().trim().min(1), series: z.array(z.object({ name: z.string().min(1), data: z.array(z.object({ x: number, y: number }).strict()).min(1).max(5000) }).strict()).min(1).max(8) }).strict();
const pie = z.object({ version: z.literal(1), kind: z.literal("pie"), title: z.string().trim().min(1), slices: z.array(z.object({ label: z.string().min(1), value: number.nonnegative() }).strict()).min(1).max(100) }).strict();
const chartSchema = z.union([timeseries, category, xy, pie]);
const tableSchema = z.object({ version: z.literal(1), title: z.string().trim().min(1), columns: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), format: z.string().max(64).optional() }).strict()).min(1).max(32), rows: z.array(z.record(z.string(), z.union([z.string(), number, z.boolean(), z.null()]))).max(1000) }).strict().superRefine((table, ctx) => {
  const keys = table.columns.map(column => column.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["columns"], message: "column keys must be unique" });
  table.rows.forEach((row, index) => { if (Object.keys(row).some(key => !keys.includes(key))) ctx.addIssue({ code: "custom", path: ["rows", index], message: "row has an undeclared column" }); });
});

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function safeTitle(value: unknown): string { return typeof value === "string" ? value.replace(/[\r\n\t\x00-\x1f]/gu, " ").trim().slice(0, 120) : ""; }
export class DisplayValidationError extends Error {}
function fail(reason: string): never { throw new DisplayValidationError(reason); }
function makeAttachment(kind: DisplayAttachment["kind"], title: string, mimeType: string, bytes: Buffer, data?: JsonValue): DisplayAttachment {
  const hash = digest(bytes);
  const attachment: DisplayAttachment = { id: hash, kind, title, mimeType, size: bytes.length, digest: hash, ...(data !== undefined ? { data } : {}) };
  pendingArtifactBytes.set(attachment, bytes);
  return attachment;
}
function within(path: string, root: string): boolean { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }

const imageMimes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const fileMimes = ["application/octet-stream", "text/plain", "text/csv", "application/pdf", "text/calendar", "application/zip"];
function validateBinaryMime(mimeType: string): void {
  if (mimeType.startsWith("image/")) {
    if (!imageMimes.includes(mimeType)) fail("unsupported image MIME type");
  } else if (!fileMimes.includes(mimeType)) fail("unsupported file MIME type");
}
function binaryAttachment(title: string, mimeType: string, bytes: Buffer): { attachment: DisplayAttachment; caption: string } {
  validateBinaryMime(mimeType);
  if (mimeType.startsWith("image/")) {
    if (bytes.length > DISPLAY_BINARY_LIMIT) fail("image exceeds 5 MiB");
    const inspection = inspectImageBytes(bytes);
    if (!inspection.ok || inspection.mediaType !== mimeType) fail("image bytes do not match MIME type or are invalid");
    return { attachment: makeAttachment("image", title, mimeType, bytes), caption: `[Shown to the user: image "${title}", ${inspection.width}×${inspection.height} ${inspection.format.toUpperCase()}]` };
  }
  if (bytes.length > DISPLAY_FILE_LIMIT) fail("file exceeds 32 MiB");
  return { attachment: makeAttachment("file", title, mimeType, bytes), caption: `[Shown to the user: file "${title}", ${bytes.length} bytes]` };
}

export async function validateDisplayBlock(block: Record<string, unknown>, roots: readonly string[], readContext: VerifiedReadContext = DEFAULT_VERIFIED_READ_CONTEXT, _trustedDataRoot?: string, budget: DisplayWorkBudget = { remainingBytes: DISPLAY_WORK_LIMIT }): Promise<{ attachment: DisplayAttachment; caption: string }> {
  chargeDisplayWork(budget, 1);
  if (block.type === "resource") {
    const resource = block.resource as Record<string, unknown> | undefined;
    const mimeType = resource?.mimeType;
    const kind = mimeType === "application/vnd.agenc.chart+json" ? "chart" : mimeType === "application/vnd.agenc.table+json" ? "table" : undefined;
    if (!kind) {
      if (typeof mimeType !== "string") fail("unsupported resource MIME type");
      validateBinaryMime(mimeType);
      const blob = resource?.blob;
      if (typeof blob !== "string") fail("invalid or oversized embedded resource data");
      chargeDisplayWork(budget, blob.length);
      if (blob.length > Math.ceil(DISPLAY_FILE_LIMIT * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(blob)) fail("invalid or oversized embedded resource data");
      const bytes = Buffer.from(blob, "base64");
      if (bytes.length > DISPLAY_FILE_LIMIT || bytes.toString("base64") !== blob) fail("invalid or oversized embedded resource data");
      return binaryAttachment(safeTitle(resource?.name) || safeTitle(block.name) || (mimeType.startsWith("image/") ? "Image" : "File"), mimeType, bytes);
    }
    if (typeof resource?.text !== "string") fail("missing resource text");
    chargeDisplayWork(budget, resource.text.length);
    if (resource.text.length > DISPLAY_JSON_LIMIT) fail(`${kind} exceeds 512 KiB`);
    const bytes = Buffer.from(resource.text, "utf8");
    chargeDisplayWork(budget, Math.max(0, bytes.length - resource.text.length));
    if (bytes.length > DISPLAY_JSON_LIMIT) fail(`${kind} exceeds 512 KiB`);
    let source: unknown;
    try { source = redactSecretsInValue(JSON.parse(resource.text)); } catch { fail("invalid JSON"); }
    if (kind === "chart") {
      const parsed = chartSchema.safeParse(source);
      if (!parsed.success) fail("invalid chart schema");
      const data = parsed.data;
      const title = safeTitle(data.title);
      const canonicalBytes = Buffer.from(JSON.stringify(data), "utf8");
      if (canonicalBytes.length > DISPLAY_JSON_LIMIT) fail("chart exceeds 512 KiB after normalization");
      const attachment = makeAttachment(kind, title, String(mimeType), canonicalBytes, data as JsonValue);
      if (data.kind === "timeseries") {
        const times = data.series.flatMap(series => series.data.map(point => point.time)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        const types = [...new Set(data.series.map(series => series.type))].join(", ");
        const names = data.series.map(series => safeTitle(series.name).slice(0, 40)).join("/ ");
        const extent = Math.max(...data.series.map(series => series.data.length));
        const label = data.series.some(series => series.type === "candlestick" || series.type === "bar") ? "bars" : "points";
        return { attachment, caption: `[Shown to the user: chart "${title}", ${types} (${names}), ${extent} ${label}, ${times[0]} to ${times.at(-1)}]` };
      }
      if (data.kind === "category") return { attachment, caption: `[Shown to the user: chart "${title}", category, ${data.categories.length} categories]` };
      if (data.kind === "xy") return { attachment, caption: `[Shown to the user: chart "${title}", xy, ${data.series.reduce((sum, series) => sum + series.data.length, 0)} points]` };
      return { attachment, caption: `[Shown to the user: chart "${title}", pie, ${data.slices.length} slices]` };
    }
    const parsed = tableSchema.safeParse(source);
    if (!parsed.success) fail("invalid table schema");
    const data = parsed.data;
    const title = safeTitle(data.title);
    const canonicalBytes = Buffer.from(JSON.stringify(data), "utf8");
    if (canonicalBytes.length > DISPLAY_JSON_LIMIT) fail("table exceeds 512 KiB after normalization");
    return { attachment: makeAttachment(kind, title, String(mimeType), canonicalBytes, data as JsonValue), caption: `[Shown to the user: table "${title}", ${data.rows.length} ${data.rows.length === 1 ? "row" : "rows"}, ${data.columns.length} ${data.columns.length === 1 ? "column" : "columns"}]` };
  }
  if (block.type === "image") {
    const mimeType = block.mimeType;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(mimeType))) fail("unsupported image MIME type");
    if (typeof block.data !== "string") fail("invalid or oversized image data");
    chargeDisplayWork(budget, block.data.length);
    if (block.data.length > Math.ceil(DISPLAY_BINARY_LIMIT * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(block.data)) fail("invalid or oversized image data");
    const bytes = Buffer.from(block.data, "base64");
    if (bytes.length > DISPLAY_BINARY_LIMIT || bytes.toString("base64") !== block.data) fail("invalid or oversized image data");
    const inspection = inspectImageBytes(bytes);
    if (!inspection.ok || inspection.mediaType !== mimeType) fail("image bytes do not match MIME type or are invalid");
    const title = safeTitle(block.name) || "Image";
    return { attachment: makeAttachment("image", title, String(mimeType), bytes), caption: `[Shown to the user: image "${title}", ${inspection.width}×${inspection.height} ${inspection.format.toUpperCase()}]` };
  }
  if (block.type === "resource_link") {
    chargeDisplayWork(budget, FILE_ATTEMPT_COST);
    if (typeof block.uri !== "string" || !block.uri.startsWith("file:")) fail("file link must use a file: URI");
    if (process.platform !== "linux") fail("file links are unavailable on this platform; send an embedded resource instead");
    if (typeof block.name !== "string" || !safeTitle(block.name)) fail("file link needs a name");
    let path: string;
    try { path = fileURLToPath(block.uri); } catch { fail("invalid file URI"); }
    const inferredImages: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : inferredImages[extname(path).toLowerCase()] ?? "application/octet-stream";
    validateBinaryMime(mimeType);
    let bytes: Buffer | undefined;
    for (const allowedRoot of roots) {
      const signal = new AbortController().signal;
      // This retained binding is the authorization. Never resolve the root
      // again after deciding that the candidate lies beneath it.
      const root = await bindVerifiedRoot(allowedRoot, signal, readContext);
      if (!root) continue;
      try {
        const rootPath = root.binding.canonicalPath;
        if (!within(path, rootPath) || path === rootPath) continue;
        const rel = relative(rootPath, path);
        const handle = await openVerifiedCandidate(root, rel, signal, readContext);
        if (!handle) continue;
        try {
          const before = identityFromStats(await handle.stat({ bigint: true }));
          if (before.size > BigInt(DISPLAY_FILE_LIMIT)) fail("file exceeds 32 MiB");
          const chunks: Buffer[] = [];
          let length = 0;
          for (;;) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, DISPLAY_FILE_LIMIT + 1 - length));
            chargeDisplayWork(budget, chunk.length);
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            length += bytesRead;
            if (length > DISPLAY_FILE_LIMIT) fail("file exceeds 32 MiB");
            chunks.push(chunk.subarray(0, bytesRead));
          }
          await assertCandidateUnchanged(handle, descriptorRelativePath(root, rel, readContext), before, signal, readContext);
          if (!(await verifyParentChain(root, rel, signal, readContext))) fail("file link changed during read");
          bytes = Buffer.concat(chunks, length);
        } finally { await closeVerifiedHandle(handle, signal, readContext); }
      } finally { await closeVerifiedHandle(root.handle, signal, readContext); }
      if (bytes) break;
    }
    if (!bytes) fail("file is outside the plugin data directory and session workspace or is not a regular file");
    const title = safeTitle(block.name) || basename(path);
    return binaryAttachment(title, mimeType, bytes);
  }
  fail("unsupported display block type");
}
