import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PairingStore } from "../../src/gateway/pairing.js";

const failure = vi.hoisted(() => ({ enabled: false, destination: "" }));
vi.mock("../../src/utils/durable-atomic-file.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/utils/durable-atomic-file.js")>();
  return {
    ...actual,
    writeDurableAtomicFileSync: (path: string, temporary: string, data: string, mode = 0o600) => {
      if (!failure.enabled) return actual.writeDurableAtomicFileSync(path, temporary, data, mode);
      return actual.writeDurableAtomicFileSync(path, temporary, data, mode, {
        mkdir: directory => { mkdirSync(directory, { recursive: true, mode: 0o700 }); },
        openTemporary: (temporaryPath, fileMode) => openSync(temporaryPath, "wx", fileMode),
        write: (handle, content) => writeFileSync(handle as number, content),
        sync: handle => fsyncSync(handle as number),
        close: handle => closeSync(handle as number),
        rename: () => { throw new Error("injected pairing rename failure"); },
        syncDirectory: () => { throw new Error("failed publication reached directory sync"); },
        remove: temporaryPath => rmSync(temporaryPath, { force: true }),
      });
    },
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-pairing-durability-"));
  failure.destination = join(home, "gateway", "pairing.json");
});
afterEach(() => {
  failure.enabled = false;
  rmSync(home, { recursive: true, force: true });
});

test("a failure before rename preserves the previous private state and releases the lock", async () => {
  const store = new PairingStore({ agencHome: home });
  await store.approve("tg", "retained");
  const previous = readFileSync(failure.destination, "utf8");
  failure.enabled = true;
  await expect(store.approve("tg", "uncommitted")).rejects.toThrow("injected pairing rename failure");
  expect(readFileSync(failure.destination, "utf8")).toBe(previous);
  expect(statSync(failure.destination).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(home, "gateway")).filter(name => name.endsWith(".tmp"))).toEqual([]);
  expect(store.isPaired("tg", "retained")).toBe(true);
  expect(store.isPaired("tg", "uncommitted")).toBe(false);
  failure.enabled = false;
  await new PairingStore({ agencHome: home }).approve("tg", "later");
  expect(store.listPaired("tg").toSorted()).toEqual(["later", "retained"]);
});

test("expiry pruning and an independent approval preserve each other's state", async () => {
  let now = 1000;
  const store = new PairingStore({ agencHome: home, now: () => now, codeTtlMs: 10, generateCode: () => "EXPIRED" });
  await store.challenge("tg", { peerId: "expired" });
  now = 2000;
  const [pending] = await Promise.all([
    store.listPending(),
    new PairingStore({ agencHome: home }).approve("tg", "approved"),
  ]);
  expect(pending).toEqual([]);
  const state = JSON.parse(readFileSync(failure.destination, "utf8"));
  expect(state.pending).toEqual({});
  expect(state.paired.tg).toEqual(["approved"]);
});
