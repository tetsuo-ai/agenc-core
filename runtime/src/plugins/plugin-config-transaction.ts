import { randomUUID } from "node:crypto";
import { cloneJsonValue, isPlainRecord, type JsonRecord } from "../config/json.js";
import {
  fencePluginTransactionEdits, MAX_PLUGIN_TRANSACTIONS, pluginConfigTargetDigest,
  pluginEnabledProjection, pluginEntryDigest,
  type PluginTransactionContribution, type PluginTransactionLedger,
} from "../config/plugin-transaction-ledger.js";
import { mutateCanonicalPluginTransactionSync, type CanonicalPluginTransactionState } from "../config/update-sync.js";
import { validatePluginsConfig } from "../config/schema.js";

export interface OwnedPluginConfigSnapshot {
  ownershipVersion: 1;
  token: string;
  epoch: string;
  entryPresent: boolean;
  entry?: unknown;
  pluginsEnabledPresent: boolean;
  pluginsEnabled?: boolean;
}

function ambiguity(): Error {
  return new Error("plugin config ownership is ambiguous; preserve the payload and operation record for manual recovery");
}

function pluginEntries(raw: JsonRecord): JsonRecord {
  const plugins = isPlainRecord(raw.plugins) ? raw.plugins : {};
  raw.plugins = plugins;
  const entries = isPlainRecord(plugins.plugins) ? plugins.plugins : {};
  plugins.plugins = entries;
  return entries;
}

function pruneEmptyTables(raw: JsonRecord): void {
  if (!isPlainRecord(raw.plugins)) return;
  if (isPlainRecord(raw.plugins.plugins) && Object.keys(raw.plugins.plugins).length === 0) delete raw.plugins.plugins;
  if (Object.keys(raw.plugins).length === 0) delete raw.plugins;
}

function writeGlobal(raw: JsonRecord, ledger: PluginTransactionLedger): void {
  if (ledger.globalFenced) return;
  const active = Object.values(ledger.operations).some(op => op.globalActive
    && (op.state === "published" || op.state === "rolling-back"));
  const next = active ? { present: true, value: true } : ledger.base;
  if (!isPlainRecord(raw.plugins)) raw.plugins = {};
  const plugins = raw.plugins as JsonRecord;
  if (next.present) plugins.enabled = next.value;
  else delete plugins.enabled;
  ledger.expected = next;
}

function requireOperation(
  state: CanonicalPluginTransactionState,
  pluginId: string,
  token: string,
  snapshot: OwnedPluginConfigSnapshot | undefined,
): { ledger: PluginTransactionLedger; op: PluginTransactionContribution } {
  const ledger = state.ledger;
  const op = ledger?.operations[token];
  if (ledger === undefined || op === undefined || op.pluginId !== pluginId
    || (snapshot !== undefined && (snapshot.token !== token || snapshot.epoch !== ledger.epoch))) throw ambiguity();
  return { ledger, op };
}

export function parseOwnedPluginConfigSnapshot(value: unknown): OwnedPluginConfigSnapshot | undefined {
  if (!isPlainRecord(value) || value.ownershipVersion !== 1
    || typeof value.token !== "string" || typeof value.epoch !== "string"
    || typeof value.entryPresent !== "boolean" || typeof value.pluginsEnabledPresent !== "boolean"
    || (value.pluginsEnabledPresent && typeof value.pluginsEnabled !== "boolean")) return undefined;
  if (value.entryPresent) validatePluginsConfig({ plugins: { example: value.entry } });
  return value as unknown as OwnedPluginConfigSnapshot;
}

/** Record a prepared token without granting it any global enablement. */
export function preparePluginConfigTransaction(configPath: string, pluginId: string, token: string): {
  snapshot: OwnedPluginConfigSnapshot; configTargetPath: string;
} {
  return mutateCanonicalPluginTransactionSync(configPath, state => {
    const raw = state.raw;
    const initial = pluginEnabledProjection(raw);
    state.ledger ??= {
      version: 2, target: pluginConfigTargetDigest(state.targetPath), epoch: randomUUID(),
      base: initial, expected: initial, globalFenced: false, operations: {},
    };
    const ledger = state.ledger;
    fencePluginTransactionEdits(ledger, raw, raw);
    if (Object.values(ledger.operations).some(op => op.pluginId === pluginId
      && op.state !== "committed" && op.state !== "rolled-back")) {
      throw new Error("another install transaction already owns this plugin's config entry");
    }
    if (Object.keys(ledger.operations).length >= MAX_PLUGIN_TRANSACTIONS || Object.hasOwn(ledger.operations, token)) throw ambiguity();
    const plugins = isPlainRecord(raw.plugins) ? raw.plugins : {};
    const entries = isPlainRecord(plugins.plugins) ? plugins.plugins : {};
    const entryPresent = Object.hasOwn(entries, pluginId);
    const snapshot: OwnedPluginConfigSnapshot = {
      ownershipVersion: 1, token, epoch: ledger.epoch, entryPresent,
      ...(entryPresent ? { entry: cloneJsonValue(entries[pluginId]) } : {}),
      pluginsEnabledPresent: initial.present,
      ...(initial.present ? { pluginsEnabled: initial.value } : {}),
    };
    ledger.operations[token] = {
      pluginId, state: "prepared", entryDigest: pluginEntryDigest(raw, pluginId),
      entryFenced: false, globalActive: false, published: false,
    };
    return { snapshot, configTargetPath: state.targetPath };
  });
}

export function publishPluginConfigTransaction(configPath: string, pluginId: string, token: string): void {
  mutateCanonicalPluginTransactionSync(configPath, state => {
    const { ledger, op } = requireOperation(state, pluginId, token, undefined);
    fencePluginTransactionEdits(ledger, state.raw, state.raw);
    if (op.state !== "prepared" || op.entryFenced) throw ambiguity();
    // An intervening global edit retired all older enablement contributions.
    // This publication is a new explicit enable, with that edited value as base.
    if (ledger.globalFenced) {
      ledger.base = pluginEnabledProjection(state.raw);
      ledger.globalFenced = false;
    }
    const entries = pluginEntries(state.raw);
    const previous = isPlainRecord(entries[pluginId]) ? entries[pluginId] : {};
    Object.defineProperty(entries, pluginId, { value: { ...previous, enabled: true }, enumerable: true, writable: true, configurable: true });
    op.state = "published";
    op.published = true;
    op.entryDigest = pluginEntryDigest(state.raw, pluginId);
    op.globalActive = true;
    writeGlobal(state.raw, ledger);
  });
}

/** Durable reservation precedes every destructive payload rollback operation. */
export function reservePluginConfigRollback(
  configPath: string, pluginId: string, token: string, previous: unknown,
  allowUnpreparedStageCleanup = false,
): void {
  const snapshot = previous === undefined ? undefined : parseOwnedPluginConfigSnapshot(previous);
  if (previous !== undefined && snapshot === undefined) throw ambiguity();
  mutateCanonicalPluginTransactionSync(configPath, state => {
    // Only an intact, pre-rename staging phase can lack preparation evidence.
    if (allowUnpreparedStageCleanup && snapshot === undefined && state.ledger?.operations[token] === undefined) return;
    const { ledger, op } = requireOperation(state, pluginId, token, snapshot);
    if (op.state === "rolled-back") return;
    if (op.state === "committed") throw ambiguity();
    fencePluginTransactionEdits(ledger, state.raw, state.raw);
    if (op.entryFenced || pluginEntryDigest(state.raw, pluginId) !== op.entryDigest) throw ambiguity();
    if (snapshot === undefined && op.published) throw ambiguity();
    op.state = "rolling-back";
  });
}

export function finishPluginConfigRollback(
  configPath: string, pluginId: string, token: string, previous: unknown,
  allowUnpreparedStageCleanup = false,
): void {
  const snapshot = previous === undefined ? undefined : parseOwnedPluginConfigSnapshot(previous);
  if (previous !== undefined && snapshot === undefined) throw ambiguity();
  mutateCanonicalPluginTransactionSync(configPath, state => {
    if (allowUnpreparedStageCleanup && snapshot === undefined && state.ledger?.operations[token] === undefined) return;
    const { ledger, op } = requireOperation(state, pluginId, token, snapshot);
    if (op.state === "rolled-back") return;
    if (op.state !== "rolling-back" || (snapshot === undefined && op.published)) throw ambiguity();
    fencePluginTransactionEdits(ledger, state.raw, state.raw);
    if (op.entryFenced || pluginEntryDigest(state.raw, pluginId) !== op.entryDigest) throw ambiguity();
    if (snapshot !== undefined) {
      const entries = pluginEntries(state.raw);
      if (snapshot.entryPresent) Object.defineProperty(entries, pluginId, {
        value: cloneJsonValue(snapshot.entry), enumerable: true, configurable: true, writable: true,
      });
      else delete entries[pluginId];
    }
    op.state = "rolled-back";
    op.globalActive = false;
    op.entryDigest = pluginEntryDigest(state.raw, pluginId);
    writeGlobal(state.raw, ledger);
    pruneEmptyTables(state.raw);
  });
}

/** Called only after the operation's committed record is durable. */
export function finalizePluginConfigTransaction(configPath: string, pluginId: string, token: string, previous: unknown): void {
  const snapshot = parseOwnedPluginConfigSnapshot(previous);
  if (snapshot === undefined) throw ambiguity();
  mutateCanonicalPluginTransactionSync(configPath, state => {
    const { ledger, op } = requireOperation(state, pluginId, token, snapshot);
    if (op.state === "committed") return;
    if (op.state !== "published") throw ambiguity();
    fencePluginTransactionEdits(ledger, state.raw, state.raw);
    if (op.globalActive && !ledger.globalFenced) ledger.base = { present: true, value: true };
    op.state = "committed";
    op.globalActive = false;
    writeGlobal(state.raw, ledger);
  });
}

/** Terminal receipts remain until their operation record has been removed. */
export function forgetPluginConfigTransaction(configPath: string, pluginId: string, token: string): void {
  mutateCanonicalPluginTransactionSync(configPath, state => {
    const op = state.ledger?.operations[token];
    if (op === undefined) return;
    if (op.pluginId !== pluginId || (op.state !== "committed" && op.state !== "rolled-back")) throw ambiguity();
    delete state.ledger!.operations[token];
    if (Object.keys(state.ledger!.operations).length === 0) state.ledger = undefined;
  });
}
