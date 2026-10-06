import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyCanonicalConfigPatchSync, readCanonicalUserConfigSnapshotSync } from "../../src/config/update-sync.js";
import { readPluginTransactionHeader } from "../../src/config/plugin-transaction-ledger.js";
import {
  preparePluginConfigTransaction as prepare, publishPluginConfigTransaction as publish,
  reservePluginConfigRollback as reserve, finishPluginConfigRollback as rollback,
  finalizePluginConfigTransaction as commit, forgetPluginConfigTransaction as forget,
} from "../../src/plugins/plugin-config-transaction.js";

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-plugin-ownership-"));
  path = join(root, "config.toml");
  writeFileSync(path, "config_version = 2\n[plugins]\nenabled = false\n");
});
afterEach(() => rmSync(root, { force: true, recursive: true }));
function start(pluginId: string) {
  const token = randomUUID();
  const { snapshot } = prepare(path, pluginId, token);
  publish(path, pluginId, token);
  return { token, snapshot };
}
function enabled(): unknown {
  return (readCanonicalUserConfigSnapshotSync(path).raw.plugins as { enabled?: boolean } | undefined)?.enabled;
}
function undo(id: string, operation: ReturnType<typeof start>) {
  reserve(path, id, operation.token, operation.snapshot);
  rollback(path, id, operation.token, operation.snapshot);
}

it.each([false, undefined])("restores original global %s in both rollback orders", original => {
  for (const order of [["alpha", "beta"], ["beta", "alpha"]] as const) {
    writeFileSync(path, original === undefined ? "config_version = 2\n" : "config_version = 2\n[plugins]\nenabled = false\n");
    const ops = { alpha: start("alpha"), beta: start("beta") };
    undo(order[0], ops[order[0]]);
    expect(enabled()).toBe(true);
    undo(order[1], ops[order[1]]);
    expect(enabled()).toBe(original);
    undo(order[0], ops[order[0]]);
    expect(enabled()).toBe(original);
  }
});

it("preserves a later committed beta including idempotent true-to-true publication", () => {
  applyCanonicalConfigPatchSync(path, { plugins: { plugins: { beta: { enabled: true } } } }, "user");
  const a = start("alpha");
  const before = readCanonicalUserConfigSnapshotSync(path).raw;
  const b = start("beta");
  expect(readCanonicalUserConfigSnapshotSync(path).raw).toEqual(before);
  commit(path, "beta", b.token, b.snapshot);
  forget(path, "beta", b.token);
  undo("alpha", a);
  expect(enabled()).toBe(true);
});

it("preserves an unfinalized committed contribution through another rollback", () => {
  const a = start("alpha");
  const b = start("beta");
  undo("alpha", a);
  expect(enabled()).toBe(true);
  commit(path, "beta", b.token, b.snapshot);
  expect(enabled()).toBe(true);
});

it.each(["rollback", "commit"])("honors explicit user disable before %s", action => {
  const a = start("alpha");
  const b = start("beta");
  applyCanonicalConfigPatchSync(path, { plugins: { enabled: false } }, "user");
  if (action === "rollback") undo("alpha", a);
  else commit(path, "alpha", a.token, a.snapshot);
  expect(enabled()).toBe(false);
  commit(path, "beta", b.token, b.snapshot);
  expect(enabled()).toBe(false);
});

it("does not replay a committed receipt after a user disable", () => {
  const a = start("alpha");
  commit(path, "alpha", a.token, a.snapshot);
  applyCanonicalConfigPatchSync(path, { plugins: { enabled: false } }, "user");
  commit(path, "alpha", a.token, a.snapshot);
  expect(enabled()).toBe(false);
});

it("does not replay a rolled-back receipt after a later edit", () => {
  const a = start("alpha");
  undo("alpha", a);
  applyCanonicalConfigPatchSync(path, { plugins: { enabled: true, plugins: { alpha: { enabled: true } } } }, "user");
  const before = readFileSync(path, "utf8");
  undo("alpha", a);
  expect(readFileSync(path, "utf8")).toBe(before);
});

it("retires older global contributions across disable and a later install", () => {
  const a = start("alpha");
  applyCanonicalConfigPatchSync(path, { plugins: { enabled: false } }, "user");
  const b = start("beta");
  expect(enabled()).toBe(true);
  undo("beta", b);
  expect(enabled()).toBe(false);
  commit(path, "alpha", a.token, a.snapshot);
  expect(enabled()).toBe(false);
});

it("preserves an edited pending entry while another operation rolls back", () => {
  const a = start("alpha");
  const b = start("beta");
  applyCanonicalConfigPatchSync(path, { plugins: { plugins: { beta: { enabled: false } } } }, "user");
  undo("alpha", a);
  expect(() => undo("beta", b)).toThrow(/ambiguous/u);
  expect((readCanonicalUserConfigSnapshotSync(path).raw.plugins as { plugins: { beta: { enabled: boolean } } }).plugins.beta.enabled).toBe(false);
});

it("refuses same-plugin pending ownership even through a different operation token", () => {
  start("alpha");
  expect(() => prepare(path, "alpha", randomUUID())).toThrow(/already owns/u);
});

it("reserves prepared-only cleanup without enabling plugins", () => {
  const token = randomUUID();
  const { snapshot } = prepare(path, "alpha", token);
  expect(enabled()).toBe(false);
  reserve(path, "alpha", token, snapshot);
  rollback(path, "alpha", token, snapshot);
  forget(path, "alpha", token);
  expect(enabled()).toBe(false);
  expect(readPluginTransactionHeader(readFileSync(path, "utf8")).ledger).toBeUndefined();
});

it("refuses stripped ownership after publication without rewriting config", () => {
  const a = start("alpha");
  const stripped = readPluginTransactionHeader(readFileSync(path, "utf8")).body;
  writeFileSync(path, stripped);
  expect(() => undo("alpha", a)).toThrow(/ambiguous/u);
  expect(readFileSync(path, "utf8")).toBe(stripped);
});

it("rejects a snapshot from another epoch before restoring an entry", () => {
  const a = start("alpha");
  expect(() => reserve(path, "alpha", a.token, { ...a.snapshot, epoch: randomUUID() })).toThrow(/ambiguous/u);
  expect(enabled()).toBe(true);
});


it("does not infer unpublished origin from a missing snapshot on a published reservation", () => {
  const a = start("alpha");
  reserve(path, "alpha", a.token, a.snapshot);
  expect(() => reserve(path, "alpha", a.token, undefined)).toThrow(/ambiguous/u);
  expect(() => rollback(path, "alpha", a.token, undefined)).toThrow(/ambiguous/u);
  undo("alpha", a);
  expect(enabled()).toBe(false);
});

it("requires ownership before destination rollback even if both token and snapshot are missing", () => {
  expect(() => reserve(path, "alpha", randomUUID(), undefined)).toThrow(/ambiguous/u);
  expect(() => rollback(path, "alpha", randomUUID(), undefined)).toThrow(/ambiguous/u);
});
