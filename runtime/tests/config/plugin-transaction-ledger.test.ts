import { applyConfigV2Migration, checkConfigV2Migration } from "../../src/config/migration.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pluginConfigTargetDigest, pluginEntryDigest, readPluginTransactionHeader,
  withPluginTransactionHeader, type PluginTransactionLedger,
} from "../../src/config/plugin-transaction-ledger.js";
import {
  applyCanonicalConfigPatchSync, mutateCanonicalPluginTransactionSync,
  mutateCanonicalUserConfigSync, readCanonicalUserConfigSnapshotSync,
  replaceCanonicalUserConfigTextSync,
} from "../../src/config/update-sync.js";

let root: string;
let path: string;
let token: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-config-contribution-"));
  path = join(root, "config.toml");
  token = randomUUID();
  writeFileSync(path, "config_version = 2\n[plugins]\nenabled = true\n[plugins.plugins.alpha]\nenabled = true\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function attach(state: "published" | "rolling-back" = "published"): void {
  mutateCanonicalPluginTransactionSync(path, draft => {
    draft.ledger = {
      version: 2, target: pluginConfigTargetDigest(draft.targetPath), epoch: randomUUID(),
      base: { present: true, value: false }, expected: { present: true, value: true },
      globalFenced: false,
      operations: { [token]: { pluginId: "alpha", state, entryDigest: pluginEntryDigest(draft.raw, "alpha"), entryFenced: false, globalActive: true, published: true } },
    };
  });
}
function readLedger(): PluginTransactionLedger {
  return readPluginTransactionHeader(readFileSync(path, "utf8")).ledger!;
}

describe("atomic plugin ownership metadata", () => {
  it("persists metadata-only mutations without changing parsed config", () => {
    const before = readCanonicalUserConfigSnapshotSync(path).raw;
    attach();
    expect(readCanonicalUserConfigSnapshotSync(path).raw).toEqual(before);
    expect(readLedger().operations[token]?.state).toBe("published");
  });

  it("preserves ownership across an unrelated mutation and patch", () => {
    attach();
    const before = readLedger();
    mutateCanonicalUserConfigSync(path, raw => { raw.model = "unrelated"; });
    applyCanonicalConfigPatchSync(path, { model: "another" }, "user");
    expect(readLedger()).toEqual(before);
  });

  it("fences no-op global patch intent without fencing the entry", () => {
    attach();
    applyCanonicalConfigPatchSync(path, { plugins: { enabled: true } }, "user");
    expect(readLedger().globalFenced).toBe(true);
    expect(readLedger().operations[token]?.entryFenced).toBe(false);
  });

  it("fences no-op entry patches and explicit mutator intent", () => {
    attach();
    applyCanonicalConfigPatchSync(path, { plugins: { plugins: { alpha: { enabled: true } } } }, "user");
    expect(readLedger().operations[token]?.entryFenced).toBe(true);
    mutateCanonicalUserConfigSync(path, () => {}, { global: true });
    expect(readLedger().globalFenced).toBe(true);
  });

  it("preserves original metadata through an unrelated editor rewrite that strips the comment", () => {
    attach();
    const before = readLedger();
    const snap = readCanonicalUserConfigSnapshotSync(path);
    const body = readPluginTransactionHeader(snap.content).body;
    expect(replaceCanonicalUserConfigTextSync(snap, `model = "edited"\n${body}`)).toBe(true);
    expect(readLedger()).toEqual(before);
  });

  it("fences an editor disable without losing entry ownership", () => {
    attach();
    const snap = readCanonicalUserConfigSnapshotSync(path);
    replaceCanonicalUserConfigTextSync(snap, snap.content.replace('"enabled" = true', '"enabled" = false'));
    expect(readLedger().globalFenced).toBe(true);
    expect(readLedger().expected).toEqual({ present: true, value: false });
    expect(readLedger().operations[token]?.entryFenced).toBe(false);
  });

  it("detects an external entry edit that retains the comment", () => {
    attach();
    writeFileSync(path, readFileSync(path, "utf8").replace('["plugins"."plugins"."alpha"]\n"enabled" = true', '["plugins"."plugins"."alpha"]\n"enabled" = false'));
    mutateCanonicalUserConfigSync(path, raw => { raw.model = "unrelated"; });
    expect(readLedger().operations[token]?.entryFenced).toBe(true);
  });

  it.each(["global", "entry", "editor"])("rejects %s edits during a durable rollback reservation", kind => {
    attach("rolling-back");
    const before = readFileSync(path, "utf8");
    expect(() => {
      if (kind === "global") applyCanonicalConfigPatchSync(path, { plugins: { enabled: true } }, "user");
      else if (kind === "entry") applyCanonicalConfigPatchSync(path, { plugins: { plugins: { alpha: { enabled: true } } } }, "user");
      else replaceCanonicalUserConfigTextSync(readCanonicalUserConfigSnapshotSync(path), before.replace('"enabled" = true', '"enabled" = false'));
    }).toThrow(/reserved for install recovery/u);
    expect(readFileSync(path, "utf8")).toBe(before);
    mutateCanonicalUserConfigSync(path, raw => { raw.model = "unrelated"; });
  });

  it("locks two symlink aliases on the same actual file", () => {
    const a = join(root, "a.toml");
    const b = join(root, "b.toml");
    symlinkSync(path, a); symlinkSync(path, b);
    mutateCanonicalUserConfigSync(a, raw => {
      expect(() => mutateCanonicalUserConfigSync(b, other => { other.model = "lost"; })).toThrow();
      raw.model = "owner";
    });
    expect(readCanonicalUserConfigSnapshotSync(b).raw.model).toBe("owner");
  });

  it("rejects alias retargeting before publication", () => {
    const alias = join(root, "alias.toml");
    const other = join(root, "other.toml");
    writeFileSync(other, "config_version = 2\n");
    symlinkSync(path, alias);
    const before = readFileSync(path, "utf8");
    expect(() => mutateCanonicalUserConfigSync(alias, raw => {
      unlinkSync(alias); symlinkSync(other, alias); raw.model = "must-not-publish";
    })).toThrow(/target changed/u);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(other, "utf8")).toBe("config_version = 2\n");
  });

  it("rejects ownership copied to another target", () => {
    attach();
    const other = join(root, "other.toml");
    writeFileSync(other, readFileSync(path, "utf8"));
    expect(() => mutateCanonicalUserConfigSync(other, () => {})).toThrow(/different config target/u);
  });

  it.each(["malformed", "duplicate", "unsupported", "legacy", "oversized"])("rejects %s headers without modifying the file", kind => {
    attach();
    const text = readFileSync(path, "utf8");
    let changed: string;
    if (kind === "duplicate") changed = `${text.split("\n")[0]}\n${text}`;
    else if (kind === "malformed") changed = "# agenc-plugin-transactions: invalid!\n" + readPluginTransactionHeader(text).body;
    else if (kind === "oversized") changed = "# agenc-plugin-transactions: " + "A".repeat(65536) + "\n" + readPluginTransactionHeader(text).body;
    else changed = "# agenc-plugin-transactions: " + Buffer.from(JSON.stringify({ ...readLedger(), version: kind === "legacy" ? 1 : 3 })).toString("base64") + "\n" + readPluginTransactionHeader(text).body;
    writeFileSync(path, changed);
    expect(() => mutateCanonicalUserConfigSync(path, raw => { raw.model = "no"; })).toThrow(/ownership metadata is invalid/u);
    expect(readFileSync(path, "utf8")).toBe(changed);
  });

  it("does not interpret a header-looking line inside a multiline TOML string", () => {
    const text = 'value = """\n# agenc-plugin-transactions: invalid!\n"""\n';
    expect(readPluginTransactionHeader(text)).toEqual({ body: text });
  });

  it("bounds unresolved contributions instead of evicting one", () => {
    attach();
    const ledger = readLedger();
    for (let n = 0; n < 64; n += 1) ledger.operations[randomUUID()] = {
      pluginId: `plugin-${n}`, state: "published", entryDigest: "a".repeat(64), entryFenced: false, globalActive: true, published: true,
    };
    expect(() => withPluginTransactionHeader("config_version = 2\n", ledger)).toThrow(/invalid/u);
  });
});


it("refuses migration instead of discarding outstanding ownership metadata", async () => {
  attach();
  writeFileSync(path, readFileSync(path, "utf8").replace('"config_version" = 2', 'configVersion = 1'));
  const before = readFileSync(path, "utf8");
  expect(before).toContain("configVersion = 1");
  const plan = await checkConfigV2Migration({
    env: {}, home: root, projectRoot: join(root, "project"),
    managedConfigPath: join(root, "managed", "config.toml"),
    managedSettingsPath: join(root, "managed", "settings.json"),
    globalStatePath: join(root, "missing-state.json"), id: "pending-plugin-ownership",
  });
  expect(plan.writes.some(write => write.targetPath === path)).toBe(true);
  await expect(applyConfigV2Migration(plan)).rejects.toThrow(/finish plugin install recovery/u);
  expect(readFileSync(path, "utf8")).toBe(before);
});
