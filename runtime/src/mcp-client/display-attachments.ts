import { createHash } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { JsonValue } from "../app-server/protocol/index.js";
import { inspectImageBytes } from "../utils/image-validation.js";

export const DISPLAY_JSON_LIMIT = 512 * 1024;
export const DISPLAY_BINARY_LIMIT = 5 * 1024 * 1024;
export const DISPLAY_FILE_LIMIT = 32 * 1024 * 1024;
export const DISPLAY_ATTACHMENT_LIMIT = 8;

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
export function takeDisplayArtifactBytes(item: DisplayAttachment): Buffer | undefined {
  const bytes = pendingArtifactBytes.get(item);
  pendingArtifactBytes.delete(item);
  return bytes;
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
function fail(reason: string): never { throw new Error(reason); }
function makeAttachment(kind: DisplayAttachment["kind"], title: string, mimeType: string, bytes: Buffer, data?: JsonValue): DisplayAttachment {
  const hash = digest(bytes);
  const attachment: DisplayAttachment = { id: hash, kind, title, mimeType, size: bytes.length, digest: hash, ...(data !== undefined ? { data } : {}) };
  pendingArtifactBytes.set(attachment, bytes);
  return attachment;
}
function within(path: string, root: string): boolean { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }

export async function validateDisplayBlock(block: Record<string, unknown>, roots: readonly string[]): Promise<{ attachment: DisplayAttachment; caption: string }> {
  if (block.type === "resource") {
    const resource = block.resource as Record<string, unknown> | undefined;
    const mimeType = resource?.mimeType;
    const kind = mimeType === "application/vnd.agenc.chart+json" ? "chart" : mimeType === "application/vnd.agenc.table+json" ? "table" : undefined;
    if (!kind || typeof resource?.text !== "string") fail("unsupported resource MIME type or missing text");
    const bytes = Buffer.from(resource.text, "utf8");
    if (bytes.length > DISPLAY_JSON_LIMIT) fail(`${kind} exceeds 512 KiB`);
    let source: unknown;
    try { source = JSON.parse(resource.text); } catch { fail("invalid JSON"); }
    if (kind === "chart") {
      const parsed = chartSchema.safeParse(source);
      if (!parsed.success) fail(parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || kind}: ${issue.message}`).join("; "));
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
    if (!parsed.success) fail(parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || kind}: ${issue.message}`).join("; "));
    const data = parsed.data;
    const title = safeTitle(data.title);
    const canonicalBytes = Buffer.from(JSON.stringify(data), "utf8");
    if (canonicalBytes.length > DISPLAY_JSON_LIMIT) fail("table exceeds 512 KiB after normalization");
    return { attachment: makeAttachment(kind, title, String(mimeType), canonicalBytes, data as JsonValue), caption: `[Shown to the user: table "${title}", ${data.rows.length} ${data.rows.length === 1 ? "row" : "rows"}, ${data.columns.length} ${data.columns.length === 1 ? "column" : "columns"}]` };
  }
  if (block.type === "image") {
    const mimeType = block.mimeType;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(mimeType))) fail("unsupported image MIME type");
    if (typeof block.data !== "string" || block.data.length > Math.ceil(DISPLAY_BINARY_LIMIT * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(block.data)) fail("invalid or oversized image data");
    const bytes = Buffer.from(block.data, "base64");
    if (bytes.length > DISPLAY_BINARY_LIMIT || bytes.toString("base64") !== block.data) fail("invalid or oversized image data");
    const inspection = inspectImageBytes(bytes);
    if (!inspection.ok || inspection.mediaType !== mimeType) fail("image bytes do not match MIME type or are invalid");
    const title = safeTitle(block.name) || "Image";
    return { attachment: makeAttachment("image", title, String(mimeType), bytes), caption: `[Shown to the user: image "${title}", ${inspection.width}×${inspection.height} ${inspection.format.toUpperCase()}]` };
  }
  if (block.type === "resource_link") {
    if (typeof block.uri !== "string" || !block.uri.startsWith("file:")) fail("file link must use a file: URI");
    if (typeof block.name !== "string" || !safeTitle(block.name)) fail("file link needs a name");
    let path: string;
    try { path = fileURLToPath(block.uri); } catch { fail("invalid file URI"); }
    let actual: string;
    try { actual = await realpath(path); } catch { fail("file does not exist"); }
    const realRoots = await Promise.all(roots.map(root => realpath(root).catch(() => undefined)));
    if (!realRoots.some(root => root && within(actual, root))) fail("file is outside the plugin data directory and session workspace");
    const info = await stat(actual);
    if (!info.isFile()) fail("file link must name a regular file");
    if (info.size > DISPLAY_FILE_LIMIT) fail("file exceeds 32 MiB");
    const bytes = await readFile(actual);
    if (bytes.length > DISPLAY_FILE_LIMIT) fail("file exceeds 32 MiB");
    const title = safeTitle(block.name) || basename(actual);
    const inferredImages: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : inferredImages[extname(actual).toLowerCase()] ?? "application/octet-stream";
    if (mimeType.startsWith("image/")) {
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) fail("unsupported image MIME type");
      if (bytes.length > DISPLAY_BINARY_LIMIT) fail("image exceeds 5 MiB");
      const inspection = inspectImageBytes(bytes);
      if (!inspection.ok || inspection.mediaType !== mimeType) fail("image bytes do not match MIME type or are invalid");
      return { attachment: makeAttachment("image", title, mimeType, bytes), caption: `[Shown to the user: image "${title}", ${inspection.width}×${inspection.height} ${inspection.format.toUpperCase()}]` };
    }
    if (mimeType !== "application/octet-stream" && !["text/plain", "text/csv", "application/pdf", "text/calendar", "application/zip"].includes(mimeType)) fail("unsupported file MIME type");
    return { attachment: makeAttachment("file", title, mimeType, bytes), caption: `[Shown to the user: file "${title}", ${bytes.length} bytes]` };
  }
  fail("unsupported display block type");
}
