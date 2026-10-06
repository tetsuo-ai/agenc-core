import { createHash } from "node:crypto";
import { isPlainRecord, stableJson, type JsonRecord } from "./json.js";

// A standalone header only. Never interpret comment-looking text in TOML values.
const PREFIX = "# agenc-plugin-transactions: ";
const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_PLUGIN_TRANSACTIONS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PLUGIN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._@/-]{0,255}$/u;

export interface PluginEnabledProjection {
  present: boolean;
  value?: boolean;
}

export interface PluginTransactionContribution {
  pluginId: string;
  state: "prepared" | "published" | "rolling-back" | "rolled-back" | "committed";
  entryDigest: string;
  entryFenced: boolean;
  globalActive: boolean;
}

export interface PluginTransactionLedger {
  version: 1;
  target: string;
  epoch: string;
  base: PluginEnabledProjection;
  expected: PluginEnabledProjection;
  globalFenced: boolean;
  operations: Record<string, PluginTransactionContribution>;
}

/** Explicit write intent matters even when the old and new values are equal. */
export interface PluginConfigWriteIntent {
  global?: boolean;
  entries?: readonly string[] | "all";
}

export function pluginConfigTargetDigest(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export function pluginEntryDigest(raw: JsonRecord, pluginId: string): string {
  const plugins = isPlainRecord(raw.plugins) ? raw.plugins : {};
  const entries = isPlainRecord(plugins.plugins) ? plugins.plugins : {};
  const projection = Object.hasOwn(entries, pluginId)
    ? { present: true, value: entries[pluginId] }
    : { present: false };
  return createHash("sha256").update(stableJson(projection)).digest("hex");
}

export function pluginEnabledProjection(raw: JsonRecord): PluginEnabledProjection {
  const plugins = isPlainRecord(raw.plugins) ? raw.plugins : {};
  if (!Object.hasOwn(plugins, "enabled")) return { present: false };
  if (typeof plugins.enabled !== "boolean") throw ledgerError();
  return { present: true, value: plugins.enabled };
}

function validProjection(value: unknown): value is PluginEnabledProjection {
  return isPlainRecord(value) && typeof value.present === "boolean"
    && Object.keys(value).every(key => key === "present" || key === "value")
    && (value.present ? typeof value.value === "boolean" : value.value === undefined);
}

function ledgerError(): Error {
  return new Error("plugin transaction ownership metadata is invalid; preserve the config and install records for manual recovery");
}

export function validatePluginTransactionLedger(value: unknown): asserts value is PluginTransactionLedger {
  if (!isPlainRecord(value) || value.version !== 1
    || typeof value.target !== "string" || !DIGEST.test(value.target)
    || typeof value.epoch !== "string" || !UUID.test(value.epoch)
    || !validProjection(value.base) || !validProjection(value.expected)
    || typeof value.globalFenced !== "boolean" || !isPlainRecord(value.operations)
    || Object.keys(value).some(key => !["version", "target", "epoch", "base", "expected", "globalFenced", "operations"].includes(key))) {
    throw ledgerError();
  }
  const entries = Object.entries(value.operations);
  if (entries.length > MAX_PLUGIN_TRANSACTIONS) throw ledgerError();
  const active = new Set<string>();
  for (const [token, operation] of entries) {
    if (!UUID.test(token) || !isPlainRecord(operation)
      || typeof operation.pluginId !== "string" || !PLUGIN_ID.test(operation.pluginId)
      || typeof operation.entryDigest !== "string" || !DIGEST.test(operation.entryDigest)
      || typeof operation.entryFenced !== "boolean"
      || typeof operation.globalActive !== "boolean"
      || !["prepared", "published", "rolling-back", "rolled-back", "committed"].includes(String(operation.state))
      || Object.keys(operation).some(key => !["pluginId", "state", "entryDigest", "entryFenced", "globalActive"].includes(key))) {
      throw ledgerError();
    }
    if (operation.state !== "rolled-back" && operation.state !== "committed") {
      if (active.has(operation.pluginId)) throw ledgerError();
      active.add(operation.pluginId);
    }
  }
}

export function readPluginTransactionHeader(text: string): {
  ledger?: PluginTransactionLedger;
  body: string;
} {
  const normalized = text.replace(/^\uFEFF/u, "");
  const lines = normalized.split(/\n/u);
  let found: PluginTransactionLedger | undefined;
  let index = -1;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n]!.replace(/\r$/u, "");
    if (line.trim() !== "" && !line.trimStart().startsWith("#")) break;
    if (!line.trimStart().startsWith("# agenc-plugin-transactions:")) continue;
    if (found !== undefined || !line.startsWith(PREFIX) || Buffer.byteLength(line) > MAX_HEADER_BYTES) throw ledgerError();
    const encoded = line.slice(PREFIX.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw ledgerError();
    try {
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw ledgerError();
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      validatePluginTransactionLedger(parsed);
      found = parsed;
      index = n;
    } catch {
      throw ledgerError();
    }
  }
  if (index >= 0) lines.splice(index, 1);
  return { ...(found === undefined ? {} : { ledger: found }), body: lines.join("\n") };
}

export function withPluginTransactionHeader(text: string, ledger: PluginTransactionLedger | undefined): string {
  const { body } = readPluginTransactionHeader(text);
  if (ledger === undefined) return body;
  validatePluginTransactionLedger(ledger);
  const line = PREFIX + Buffer.from(JSON.stringify(ledger), "utf8").toString("base64");
  if (Buffer.byteLength(line) > MAX_HEADER_BYTES) throw ledgerError();
  return `${line}\n${body}`;
}

export function pluginIntentForPath(segments: readonly string[]): PluginConfigWriteIntent {
  if (segments[0] !== "plugins") return {};
  if (segments.length === 1) return { global: true, entries: "all" };
  if (segments[1] === "enabled") return { global: true };
  if (segments[1] !== "plugins") return {};
  return { entries: segments[2] === undefined ? "all" : [segments[2]] };
}

export function pluginIntentForPatch(patch: Readonly<JsonRecord>): PluginConfigWriteIntent {
  if (!Object.hasOwn(patch, "plugins")) return {};
  if (!isPlainRecord(patch.plugins)) return { global: true, entries: "all" };
  const plugins = patch.plugins;
  return {
    ...(Object.hasOwn(plugins, "enabled") ? { global: true } : {}),
    ...(Object.hasOwn(plugins, "plugins")
      ? { entries: isPlainRecord(plugins.plugins) ? Object.keys(plugins.plugins) : "all" as const }
      : {}),
  };
}

/**
 * Fence an observable or explicit newer edit; unrelated writes retain ownership.
 * A durable rollback reservation rejects conflicting cooperative edits until
 * payload recovery and config restoration finish, including across a crash.
 */
export function fencePluginTransactionEdits(
  ledger: PluginTransactionLedger | undefined,
  before: JsonRecord,
  after: JsonRecord,
  intent: PluginConfigWriteIntent = {},
): void {
  if (ledger === undefined) return;
  const globalEdited = intent.global === true
    || stableJson(pluginEnabledProjection(before)) !== stableJson(pluginEnabledProjection(after))
    || stableJson(ledger.expected) !== stableJson(pluginEnabledProjection(before));
  const operations = Object.values(ledger.operations);
  if (globalEdited) {
    if (operations.some(op => op.state === "rolling-back")) throw new Error("plugin config is reserved for install recovery");
    ledger.globalFenced = true;
    for (const op of operations) op.globalActive = false;
    ledger.expected = pluginEnabledProjection(after);
  }
  for (const op of operations) {
    if (op.state === "committed" || op.state === "rolled-back") continue;
    const edited = intent.entries === "all" || intent.entries?.includes(op.pluginId) === true
      || pluginEntryDigest(before, op.pluginId) !== pluginEntryDigest(after, op.pluginId)
      || pluginEntryDigest(before, op.pluginId) !== op.entryDigest;
    if (!edited) continue;
    if (op.state === "rolling-back") throw new Error("plugin entry is reserved for install recovery");
    op.entryFenced = true;
  }
}
