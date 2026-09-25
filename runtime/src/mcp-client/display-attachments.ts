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
export function withDisplayAttachmentTitle(item: DisplayAttachment, title: string): DisplayAttachment {
  const renamed = { ...item, title };
  const bytes = pendingArtifactBytes.get(item);
  if (bytes !== undefined) pendingArtifactBytes.set(renamed, bytes);
  pendingArtifactBytes.delete(item);
  return renamed;
}

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
const seriesScale = z.enum(["price", "volume", "percent"]);
const valueSeriesType = z.enum(["line", "area", "histogram"]);
const ohlcSeriesType = z.enum(["candlestick", "bar"]);
const timeseriesKind = z.literal("timeseries");
const categoryKind = z.literal("category");
const xyKind = z.literal("xy");
const pieKind = z.literal("pie");
const ISO_CURRENCIES = new Set([...Intl.supportedValuesOf("currency"), "XAU", "XAG", "XPT", "XPD", "XDR", "XTS", "XXX"]);
const currency = z.string().regex(/^[A-Z]{3}$/, "use a three-letter ISO 4217 currency code").refine(value => ISO_CURRENCIES.has(value), "use an ISO 4217 currency code");
/** Display JSON can be model-facing without schema validation. Only values accepted by these same validators are routing structure. */
export function isDisplayStructuralValue(path: readonly string[], value: string, chartKind: unknown): boolean {
  if (path.length === 1 && path[0] === "kind") return [timeseriesKind, categoryKind, xyKind, pieKind].some(schema => schema.safeParse(value).success);
  if (!timeseriesKind.safeParse(chartKind).success) return false;
  if (path.length === 1 && path[0] === "currency") return currency.safeParse(value).success;
  if (path.length === 3 && path[0] === "series" && path[1] === "*") {
    if (path[2] === "type") return valueSeriesType.safeParse(value).success || ohlcSeriesType.safeParse(value).success;
    if (path[2] === "scale") return seriesScale.safeParse(value).success;
  }
  return false;
}
const common = { name: z.string().trim().min(1), scale: seriesScale.default("price"), precision: z.number().int().min(0).max(8).optional() };
const valueSeries = z.object({ ...common, type: valueSeriesType, data: z.array(valuePoint).min(1).max(5000) }).strict();
const ohlcSeries = z.object({ ...common, type: ohlcSeriesType, data: z.array(ohlcPoint).min(1).max(5000) }).strict();
const timeseries = z.object({
  version: z.literal(1), kind: timeseriesKind, title: z.string().trim().min(1),
  subtitle: z.string().optional(), currency: currency.optional(),
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
function xyPointCount(series: readonly unknown[]): number {
  return series.reduce<number>((sum, entry) => {
    const data = (entry as { readonly data?: unknown } | null)?.data;
    return sum + (Array.isArray(data) ? data.length : 0);
  }, 0);
}
/** A plain reason for a chart over the size caps, so its plugin can shrink it. */
function chartSizeReason(source: unknown): string | undefined {
  const chart = source as { readonly kind?: unknown; readonly categories?: unknown; readonly series?: unknown } | null;
  if (chart === null || typeof chart !== "object") return undefined;
  if (chart.kind === "category" && Array.isArray(chart.categories) && chart.categories.length > CATEGORY_CHART_MAX_CATEGORIES) {
    return `category chart has more than ${CATEGORY_CHART_MAX_CATEGORIES} categories`;
  }
  if (chart.kind === "xy" && Array.isArray(chart.series) && xyPointCount(chart.series) > XY_CHART_MAX_POINTS) {
    return `xy chart has more than ${XY_CHART_MAX_POINTS} points in all series`;
  }
  return undefined;
}
// Category, xy and pie charts are drawn as SVG, one element per mark, so they
// keep to the sizes Desktop's renderer was built for. Timeseries charts are
// drawn on a canvas and keep the limits above.
export const CATEGORY_CHART_MAX_CATEGORIES = 500;
export const XY_CHART_MAX_POINTS = 5000;
const category = z.object({ version: z.literal(1), kind: categoryKind, title: z.string().trim().min(1), categories: z.array(z.string().min(1)).min(1).max(CATEGORY_CHART_MAX_CATEGORIES), series: z.array(z.object({ name: z.string().min(1), values: z.array(number).min(1).max(CATEGORY_CHART_MAX_CATEGORIES) }).strict()).min(1).max(8) }).strict().superRefine((chart, ctx) => {
  chart.series.forEach((series, index) => { if (series.values.length !== chart.categories.length) ctx.addIssue({ code: "custom", path: ["series", index, "values"], message: "values must match categories" }); });
});
const xy = z.object({ version: z.literal(1), kind: xyKind, title: z.string().trim().min(1), series: z.array(z.object({ name: z.string().min(1), data: z.array(z.object({ x: number, y: number }).strict()).min(1).max(XY_CHART_MAX_POINTS) }).strict()).min(1).max(8) }).strict().superRefine((chart, ctx) => {
  if (xyPointCount(chart.series) > XY_CHART_MAX_POINTS) ctx.addIssue({ code: "custom", path: ["series"], message: `at most ${XY_CHART_MAX_POINTS} points in all series` });
});
const pie = z.object({ version: z.literal(1), kind: pieKind, title: z.string().trim().min(1), slices: z.array(z.object({ label: z.string().min(1), value: number.nonnegative() }).strict()).min(1).max(100) }).strict();
const chartSchema = z.union([timeseries, category, xy, pie]);
const tableSchema = z.object({ version: z.literal(1), title: z.string().trim().min(1), columns: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), format: z.string().max(64).optional() }).strict()).min(1).max(32), rows: z.array(z.record(z.string(), z.union([z.string(), number, z.boolean(), z.null()]))).max(1000) }).strict().superRefine((table, ctx) => {
  const keys = table.columns.map(column => column.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["columns"], message: "column keys must be unique" });
  table.rows.forEach((row, index) => { if (Object.keys(row).some(key => !keys.includes(key))) ctx.addIssue({ code: "custom", path: ["rows", index], message: "row has an undeclared column" }); });
});

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function safeTitle(value: unknown): string { return typeof value === "string" ? value.replace(/[\x00-\x1f]/gu, " ").trim().slice(0, 120) : ""; }
export class DisplayValidationError extends Error {}
function fail(reason: string): never { throw new DisplayValidationError(reason); }
function makeAttachment(kind: DisplayAttachment["kind"], title: string, mimeType: string, bytes: Buffer, data?: JsonValue): DisplayAttachment {
  const hash = digest(bytes);
  const attachment: DisplayAttachment = { id: hash, kind, title, mimeType, size: bytes.length, digest: hash, ...(data !== undefined ? { data } : {}) };
  pendingArtifactBytes.set(attachment, bytes);
  return attachment;
}
function within(path: string, root: string): boolean { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }

const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FILE_MIMES: ReadonlySet<string> = new Set(["application/octet-stream", "text/plain", "text/csv", "application/pdf", "text/calendar", "application/zip"]);
function validateBinaryMime(mimeType: string): void {
  if (mimeType.startsWith("image/")) {
    if (!IMAGE_MIMES.has(mimeType)) fail("unsupported image MIME type");
  } else if (!FILE_MIMES.has(mimeType)) fail("unsupported file MIME type");
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

type ShownDisplay = { attachment: DisplayAttachment; caption: string };
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const INFERRED_IMAGE_MIMES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function structuredKind(mimeType: unknown): "chart" | "table" | undefined {
  if (mimeType === "application/vnd.agenc.chart+json") return "chart";
  if (mimeType === "application/vnd.agenc.table+json") return "table";
  return undefined;
}

/** Canonical base64 of at most `limit` bytes, decoded; anything else fails with `reason`. */
function decodeCanonicalBase64(text: string, limit: number, budget: DisplayWorkBudget, reason: string): Buffer {
  chargeDisplayWork(budget, text.length);
  if (text.length > Math.ceil(limit * 4 / 3) + 4 || !CANONICAL_BASE64.test(text)) fail(reason);
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== text) fail(reason);
  return bytes;
}

function embeddedFileAttachment(block: Record<string, unknown>, resource: Record<string, unknown> | undefined, mimeType: unknown, budget: DisplayWorkBudget): ShownDisplay {
  if (typeof mimeType !== "string") fail("unsupported resource MIME type");
  validateBinaryMime(mimeType);
  const blob = resource?.blob;
  if (typeof blob !== "string") fail("invalid or oversized embedded resource data");
  const bytes = decodeCanonicalBase64(blob, DISPLAY_FILE_LIMIT, budget, "invalid or oversized embedded resource data");
  const fallbackTitle = mimeType.startsWith("image/") ? "Image" : "File";
  return binaryAttachment(safeTitle(resource?.name) || safeTitle(block.name) || fallbackTitle, mimeType, bytes);
}

/** The JSON body of a chart or table resource, bounded and with saved secrets redacted. */
function parseStructuredText(kind: "chart" | "table", text: unknown, budget: DisplayWorkBudget): unknown {
  if (typeof text !== "string") fail("missing resource text");
  chargeDisplayWork(budget, text.length);
  if (text.length > DISPLAY_JSON_LIMIT) fail(`${kind} exceeds 512 KiB`);
  const bytes = Buffer.from(text, "utf8");
  chargeDisplayWork(budget, Math.max(0, bytes.length - text.length));
  if (bytes.length > DISPLAY_JSON_LIMIT) fail(`${kind} exceeds 512 KiB`);
  try { return redactSecretsInValue(JSON.parse(text)); } catch { fail("invalid JSON"); }
}

function compareTimes(a: string | number, b: string | number): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function chartCaption(data: z.infer<typeof chartSchema>, title: string): string {
  if (data.kind === "timeseries") {
    const times = data.series.flatMap(series => series.data.map(point => point.time)).sort(compareTimes);
    const types = [...new Set(data.series.map(series => series.type))].join(", ");
    const names = data.series.map(series => safeTitle(series.name).slice(0, 40)).join("/ ");
    const extent = Math.max(...data.series.map(series => series.data.length));
    const label = data.series.some(series => series.type === "candlestick" || series.type === "bar") ? "bars" : "points";
    return `[Shown to the user: chart "${title}", ${types} (${names}), ${extent} ${label}, ${times[0]} to ${times.at(-1)}]`;
  }
  if (data.kind === "category") return `[Shown to the user: chart "${title}", category, ${data.categories.length} categories]`;
  if (data.kind === "xy") return `[Shown to the user: chart "${title}", xy, ${data.series.reduce((sum, series) => sum + series.data.length, 0)} points]`;
  return `[Shown to the user: chart "${title}", pie, ${data.slices.length} slices]`;
}

function chartAttachment(source: unknown, mimeType: string): ShownDisplay {
  const parsed = chartSchema.safeParse(source);
  if (!parsed.success) fail(chartSizeReason(source) ?? "invalid chart schema");
  const data = parsed.data;
  const title = safeTitle(data.title);
  const canonicalBytes = Buffer.from(JSON.stringify(data), "utf8");
  if (canonicalBytes.length > DISPLAY_JSON_LIMIT) fail("chart exceeds 512 KiB after normalization");
  const attachment = makeAttachment("chart", title, mimeType, canonicalBytes, data as JsonValue);
  return { attachment, caption: chartCaption(data, title) };
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function tableAttachment(source: unknown, mimeType: string): ShownDisplay {
  const parsed = tableSchema.safeParse(source);
  if (!parsed.success) fail("invalid table schema");
  const data = parsed.data;
  const title = safeTitle(data.title);
  const canonicalBytes = Buffer.from(JSON.stringify(data), "utf8");
  if (canonicalBytes.length > DISPLAY_JSON_LIMIT) fail("table exceeds 512 KiB after normalization");
  const attachment = makeAttachment("table", title, mimeType, canonicalBytes, data as JsonValue);
  return { attachment, caption: `[Shown to the user: table "${title}", ${counted(data.rows.length, "row", "rows")}, ${counted(data.columns.length, "column", "columns")}]` };
}

function resourceAttachment(block: Record<string, unknown>, budget: DisplayWorkBudget): ShownDisplay {
  const resource = block.resource as Record<string, unknown> | undefined;
  const mimeType = resource?.mimeType;
  const kind = structuredKind(mimeType);
  if (!kind) return embeddedFileAttachment(block, resource, mimeType, budget);
  const source = parseStructuredText(kind, resource?.text, budget);
  return kind === "chart" ? chartAttachment(source, String(mimeType)) : tableAttachment(source, String(mimeType));
}

function imageAttachment(block: Record<string, unknown>, budget: DisplayWorkBudget): ShownDisplay {
  const mimeType = block.mimeType;
  if (!IMAGE_MIMES.has(String(mimeType))) fail("unsupported image MIME type");
  if (typeof block.data !== "string") fail("invalid or oversized image data");
  const bytes = decodeCanonicalBase64(block.data, DISPLAY_BINARY_LIMIT, budget, "invalid or oversized image data");
  const inspection = inspectImageBytes(bytes);
  if (!inspection.ok || inspection.mediaType !== mimeType) fail("image bytes do not match MIME type or are invalid");
  const title = safeTitle(block.name) || "Image";
  return { attachment: makeAttachment("image", title, String(mimeType), bytes), caption: `[Shown to the user: image "${title}", ${inspection.width}×${inspection.height} ${inspection.format.toUpperCase()}]` };
}

type VerifiedCandidate = NonNullable<Awaited<ReturnType<typeof openVerifiedCandidate>>>;

/** Reads an open candidate to its end, failing past the file cap. */
async function readBoundedFile(handle: VerifiedCandidate, budget: DisplayWorkBudget): Promise<Buffer> {
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
  return Buffer.concat(chunks, length);
}

/** The file's bytes when it is a regular file beneath `allowedRoot`, otherwise undefined. */
async function readBeneathRoot(allowedRoot: string, path: string, readContext: VerifiedReadContext, budget: DisplayWorkBudget): Promise<Buffer | undefined> {
  const signal = new AbortController().signal;
  // This retained binding is the authorization. Never resolve the root
  // again after deciding that the candidate lies beneath it.
  const root = await bindVerifiedRoot(allowedRoot, signal, readContext);
  if (!root) return undefined;
  try {
    const rootPath = root.binding.canonicalPath;
    if (!within(path, rootPath) || path === rootPath) return undefined;
    const rel = relative(rootPath, path);
    const handle = await openVerifiedCandidate(root, rel, signal, readContext);
    if (!handle) return undefined;
    try {
      const before = identityFromStats(await handle.stat({ bigint: true }));
      if (before.size > BigInt(DISPLAY_FILE_LIMIT)) fail("file exceeds 32 MiB");
      const bytes = await readBoundedFile(handle, budget);
      await assertCandidateUnchanged(handle, descriptorRelativePath(root, rel, readContext), before, signal, readContext);
      if (!(await verifyParentChain(root, rel, signal, readContext))) fail("file link changed during read");
      return bytes;
    } finally { await closeVerifiedHandle(handle, signal, readContext); }
  } finally { await closeVerifiedHandle(root.handle, signal, readContext); }
}

async function linkedFileAttachment(block: Record<string, unknown>, roots: readonly string[], readContext: VerifiedReadContext, budget: DisplayWorkBudget): Promise<ShownDisplay> {
  chargeDisplayWork(budget, FILE_ATTEMPT_COST);
  if (typeof block.uri !== "string" || !block.uri.startsWith("file:")) fail("file link must use a file: URI");
  if (process.platform !== "linux") fail("file links are unavailable on this platform; send an embedded resource instead");
  if (typeof block.name !== "string" || !safeTitle(block.name)) fail("file link needs a name");
  let path: string;
  try { path = fileURLToPath(block.uri); } catch { fail("invalid file URI"); }
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : INFERRED_IMAGE_MIMES[extname(path).toLowerCase()] ?? "application/octet-stream";
  validateBinaryMime(mimeType);
  let bytes: Buffer | undefined;
  for (const allowedRoot of roots) {
    bytes = await readBeneathRoot(allowedRoot, path, readContext, budget);
    if (bytes) break;
  }
  if (!bytes) fail("file is outside the plugin data directory and session workspace or is not a regular file");
  const title = safeTitle(block.name) || basename(path);
  return binaryAttachment(title, mimeType, bytes);
}

export async function validateDisplayBlock(block: Record<string, unknown>, roots: readonly string[], readContext: VerifiedReadContext = DEFAULT_VERIFIED_READ_CONTEXT, _trustedDataRoot?: string, budget?: DisplayWorkBudget): Promise<ShownDisplay> {
  const work = budget ?? { remainingBytes: DISPLAY_WORK_LIMIT };
  chargeDisplayWork(work, 1);
  if (block.type === "resource") return resourceAttachment(block, work);
  if (block.type === "image") return imageAttachment(block, work);
  if (block.type === "resource_link") return linkedFileAttachment(block, roots, readContext, work);
  fail("unsupported display block type");
}
