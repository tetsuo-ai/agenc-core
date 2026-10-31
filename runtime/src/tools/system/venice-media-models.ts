/**
 * Venice's media models from its own live list (`GET /models?type=all`):
 * image generation, image editing (inpaint), upscaling, text-to-speech and
 * video models with the prices Venice publishes for each. The media tools
 * accept any model this list names and price it from the list, so a model
 * Venice adds is usable without an AgenC release; a model the list does not
 * name is refused before any request (Venice substitutes its default model
 * for an unknown name).
 *
 * One read per authority (endpoint, credential and the transport it goes
 * through) is reused for ten minutes, never shared with another session or
 * key at the same URL. The tools start the read when they are built, so a
 * call's admission (which cannot wait) usually finds the prices; a call
 * that comes first waits for the read in `execute`.
 *
 * @module
 */

import { createHash } from "node:crypto";

export type VeniceMediaType = "image" | "inpaint" | "upscale" | "tts" | "video";

interface VenicePrice {
  readonly usd?: number;
}

export interface VeniceMediaModel {
  readonly id: string;
  readonly type: VeniceMediaType;
  readonly name?: string;
  readonly pricing: Readonly<Record<string, unknown>>;
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly voices: readonly string[];
  /** Speech models: the audio formats the model returns, and its default. */
  readonly formats: readonly string[];
  readonly defaultFormat?: string;
}

const MEDIA_TYPES: ReadonlySet<string> = new Set(["image", "inpaint", "upscale", "tts", "video"]);
const REUSE_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 10_000;
/** Venice's list is a few hundred kilobytes; anything far larger is not it. */
const MAX_LIST_BYTES = 8 * 1024 * 1024;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function usd(value: unknown): number | undefined {
  const price = record(value) as VenicePrice | undefined;
  return typeof price?.usd === "number" && Number.isFinite(price.usd) && price.usd >= 0 ? price.usd : undefined;
}

/** The media models in one `GET /models?type=all` answer. */
export function parseVeniceMediaModels(payload: unknown): readonly VeniceMediaModel[] {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) return [];
  const models: VeniceMediaModel[] = [];
  for (const entry of data) {
    const row = record(entry);
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const type = typeof row?.type === "string" ? row.type : "";
    if (!id || !MEDIA_TYPES.has(type)) continue;
    const spec = record(row?.model_spec) ?? {};
    if (spec.offline === true) continue;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const voices = strings(spec.voices);
    models.push(Object.freeze({
      id,
      type: type as VeniceMediaType,
      ...(typeof spec.name === "string" ? { name: spec.name } : {}),
      pricing: Object.freeze({ ...(record(spec.pricing) ?? {}) }),
      constraints: Object.freeze({ ...(record(spec.constraints) ?? {}) }),
      voices: Object.freeze(voices),
      formats: Object.freeze(strings(spec.supported_formats)),
      ...(typeof spec.default_format === "string" ? { defaultFormat: spec.default_format } : {}),
    }));
  }
  return Object.freeze(models);
}

interface CachedList {
  readonly at: number;
  readonly models: ReadonlyMap<string, VeniceMediaModel>;
}

/**
 * Whose list a read is: the endpoint, the credential (kept only as a
 * fingerprint) and the transport it goes through, the calling session's own
 * environment object (session-provider-authority.ts transportEnvironment).
 * Cached lists and reads in flight are scoped by all three, so a session
 * never validates or prices a call from another session's list.
 */
export interface VeniceListAuthority {
  readonly baseURL: string;
  readonly bearer: string;
  readonly transport: object;
}

type PendingList = Promise<ReadonlyMap<string, VeniceMediaModel> | undefined>;

// Per transport object, so entries go away with the session that owns them.
let lists = new WeakMap<object, Map<string, CachedList>>();
let reads = new WeakMap<object, Map<string, PendingList>>();

function baseOf(authority: VeniceListAuthority): string {
  return authority.baseURL.replace(/\/+$/, "");
}

function key(authority: VeniceListAuthority): string {
  const credential = createHash("sha256").update(authority.bearer).digest("hex").slice(0, 32);
  return `${baseOf(authority)}\u0000${credential}`;
}

function scoped<T>(maps: WeakMap<object, Map<string, T>>, transport: object): Map<string, T> {
  let map = maps.get(transport);
  if (map === undefined) {
    map = new Map();
    maps.set(transport, map);
  }
  return map;
}

/** What the last read for this authority found, without reading again. */
export function cachedVeniceMediaModels(
  authority: VeniceListAuthority,
): ReadonlyMap<string, VeniceMediaModel> | undefined {
  return lists.get(authority.transport)?.get(key(authority))?.models;
}

/** Record a list for one authority (tests and callers that already hold one). */
export function recordVeniceMediaModels(
  authority: VeniceListAuthority,
  models: readonly VeniceMediaModel[],
): void {
  scoped(lists, authority.transport).set(key(authority), {
    at: Date.now(),
    models: new Map(models.map(model => [model.id, model])),
  });
}

/** Test seam. */
export function clearVeniceMediaModels(): void {
  lists = new WeakMap();
  reads = new WeakMap();
}

/**
 * Read Venice's media models with the session's own key through `fetchImpl`,
 * the session's own transport. Best effort: undefined when the list cannot
 * be read, and the caller refuses any model it cannot price.
 */
export async function loadVeniceMediaModels(
  authority: VeniceListAuthority,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, VeniceMediaModel> | undefined> {
  const id = key(authority);
  const cachedLists = scoped(lists, authority.transport);
  const pendingReads = scoped(reads, authority.transport);
  const cached = cachedLists.get(id);
  if (cached !== undefined && Date.now() - cached.at < REUSE_MS) return cached.models;
  const pending = pendingReads.get(id);
  if (pending !== undefined) return await pending;
  const read = (async () => {
    const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${baseOf(authority)}/models?type=all`, {
        headers: { authorization: `Bearer ${authority.bearer}` },
        redirect: "error",
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      if (!response.ok) return cached?.models;
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > MAX_LIST_BYTES) return cached?.models;
      const models = parseVeniceMediaModels(await response.json());
      if (models.length === 0) return cached?.models;
      recordVeniceMediaModels(authority, models);
      return cachedLists.get(id)?.models;
    } catch {
      return cached?.models;
    } finally {
      pendingReads.delete(id);
    }
  })();
  pendingReads.set(id, read);
  return await read;
}

/** Venice's resolution tier for an output of this many pixels. */
export function veniceImageTier(width: number, height: number): string {
  const pixels = width * height;
  return pixels <= 1_600_000 ? "1K" : pixels <= 4_500_000 ? "2K" : "4K";
}

/**
 * The published price of one generated image at a tier: the model's flat
 * price, else its tier price at the model's default quality, else its tier
 * price. Undefined when the list publishes none.
 */
export function veniceImagePrice(model: VeniceMediaModel, tier: string): number | undefined {
  const pricing = model.pricing;
  const flat = usd(pricing.generation);
  if (flat !== undefined) return flat;
  const quality = typeof model.constraints.defaultQuality === "string" ? model.constraints.defaultQuality : undefined;
  const byQuality = quality === undefined ? undefined : usd(record(record(pricing.quality)?.[tier])?.[quality]);
  return byQuality ?? usd(record(pricing.resolutions)?.[tier]);
}

/**
 * The published price of one edit at a tier: the tier price at the model's
 * default quality, else the tier price, else the flat `inpaint` price, plus
 * Venice's charge for each input image past the ones included (grok and
 * qwen-image-3 edits list one; observed billed 2026-10-20).
 */
export function veniceEditPrice(model: VeniceMediaModel, tier: string, inputImages = 1): number | undefined {
  const pricing = model.pricing;
  const quality = typeof model.constraints.defaultQuality === "string" ? model.constraints.defaultQuality : undefined;
  const base = (quality === undefined ? undefined : usd(record(record(pricing.quality)?.[tier])?.[quality])) ??
    usd(record(pricing.resolutions)?.[tier]) ?? usd(pricing.inpaint);
  if (base === undefined) return undefined;
  const extra = record(pricing.inputImages);
  const included = typeof extra?.included === "number" && extra.included >= 0 ? extra.included : 0;
  const perImage = usd(extra?.additional) ?? 0;
  return base + perImage * Math.max(0, inputImages - included);
}

/** The published upscale price for a factor (2 or 4). */
export function veniceUpscalePrice(model: VeniceMediaModel, scale: number): number | undefined {
  return usd(record(model.pricing.upscale)?.[`${scale}x`]);
}

/**
 * The audio format to ask a speech model for: MP3 when it offers MP3 (or
 * lists nothing), else its default format (some return only WAV).
 */
export function veniceSpeechFormat(model: VeniceMediaModel): string {
  if (model.formats.length === 0 || model.formats.includes("mp3")) return "mp3";
  return model.defaultFormat !== undefined && model.formats.includes(model.defaultFormat) ? model.defaultFormat : model.formats[0]!;
}

/** A speech model's published price per input character (Venice lists USD per million). */
export function veniceSpeechUsdPerCharacter(model: VeniceMediaModel): number | undefined {
  const perMillion = usd(model.pricing.input);
  return perMillion === undefined ? undefined : perMillion / 1_000_000;
}

/** A model's default resolution tier, or 1K. */
export function veniceDefaultTier(model: VeniceMediaModel): string {
  return typeof model.constraints.defaultResolution === "string" ? model.constraints.defaultResolution : "1K";
}
