// Pairing attempt limit (#3443): wrong codes are counted on the pending code,
// the last one allowed voids it and locks that sender out of pairing on that
// channel, and both the count and the lockout live in pairing.json.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MAX_PAIRING_ATTEMPTS,
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCKOUT_MS,
  PairingStore,
  evaluateDmAccess,
} from "../../src/gateway/pairing.js";

const T0 = 1_700_000_000_000;
const ALICE = { peerId: "alice" };
const BOB = { peerId: "bob" };
const ALICE_ON_TG = "tg\u0000alice";

interface StoredState {
  readonly version: number;
  readonly paired: Record<string, string[]>;
  readonly pending: Record<
    string,
    { code: string; expiresAt: number; failedAttempts?: number }
  >;
  readonly lockouts?: Record<string, { until: number }>;
}

let home: string;
let now: number;
let issued: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-pairing-attempts-"));
  now = T0;
  issued = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function statePath(): string {
  return join(home, "gateway", "pairing.json");
}

/**
 * A store on the shared home and clock. Codes come out as CODE0001,
 * CODE0002, ... across every store a test opens, so a re-issue is visible.
 */
function openStore(): PairingStore {
  return new PairingStore({
    agencHome: home,
    now: () => now,
    generateCode: () => {
      const code = `CODE${String(issued.length + 1).padStart(4, "0")}`;
      issued.push(code);
      return code;
    },
  });
}

function readState(): StoredState {
  return JSON.parse(readFileSync(statePath(), "utf8")) as StoredState;
}

function writeStateText(text: string): void {
  mkdirSync(join(home, "gateway"), { recursive: true, mode: 0o700 });
  writeFileSync(statePath(), text, { mode: 0o600 });
}

function writeState(state: unknown): void {
  writeStateText(`${JSON.stringify(state, null, 2)}\n`);
}

/** Sends `count` wrong codes, each shaped like a real one. */
async function sendWrongCodes(
  store: PairingStore,
  count: number,
  channelId = "tg",
  sender = ALICE,
): Promise<void> {
  for (let attempt = 1; attempt <= count; attempt += 1) {
    expect(await store.redeem(channelId, sender, `WRONG${attempt}`)).toBe(false);
  }
}

/** Opens a challenge for alice on tg and uses up every attempt on it. */
async function lockAliceOut(store: PairingStore): Promise<string> {
  const code = await store.challenge("tg", ALICE);
  await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS);
  return code;
}

describe("pairing attempt limit (#3443)", () => {
  test("the limit is 5 attempts and the lockout lasts 15 minutes", () => {
    expect(MAX_PAIRING_ATTEMPTS).toBe(5);
    expect(PAIRING_LOCKOUT_MS).toBe(15 * 60 * 1000);
  });

  test("the default code keeps all six random bytes: 12 uppercase hex characters", async () => {
    const store = new PairingStore({ agencHome: home });
    const code = await store.challenge("tg", ALICE);
    expect(code).toMatch(/^[0-9A-F]{12}$/);
    expect(await store.redeem("tg", ALICE, code.toLowerCase())).toBe(true);
  });

  test("the 5th wrong code voids the pending code and locks the sender out", async () => {
    const store = openStore();
    const code = await store.challenge("tg", ALICE);

    // Four wrong codes are counted on the pending record; the code stands.
    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 1);
    expect(readState().pending[ALICE_ON_TG]).toEqual({
      code,
      expiresAt: T0 + PAIRING_CODE_TTL_MS,
      failedAttempts: MAX_PAIRING_ATTEMPTS - 1,
    });
    expect(readState().lockouts).toBeUndefined();
    expect(store.lockedUntil("tg", "alice")).toBeUndefined();

    expect(await store.redeem("tg", ALICE, "WRONG5")).toBe(false);

    expect(await store.listPending()).toEqual([]);
    expect(readState().pending).toEqual({});
    expect(readState().lockouts).toEqual({
      [ALICE_ON_TG]: { until: T0 + PAIRING_LOCKOUT_MS },
    });
    expect(store.lockedUntil("tg", "alice")).toBe(T0 + PAIRING_LOCKOUT_MS);
    expect(store.isPaired("tg", "alice")).toBe(false);
  });

  test("the correct code still pairs after four wrong ones", async () => {
    const store = openStore();
    const code = await store.challenge("tg", ALICE);
    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 1);

    expect(await store.redeem("tg", ALICE, code)).toBe(true);

    expect(store.isPaired("tg", "alice")).toBe(true);
    expect(store.lockedUntil("tg", "alice")).toBeUndefined();
    expect(readState().pending).toEqual({});
    expect(readState().lockouts).toBeUndefined();
  });

  test("a correct code sent during the cool-down is refused", async () => {
    const store = openStore();
    const code = await lockAliceOut(store);

    expect(await store.redeem("tg", ALICE, code)).toBe(false);
    now = T0 + PAIRING_LOCKOUT_MS - 1;
    expect(await store.redeem("tg", ALICE, code)).toBe(false);

    expect(store.isPaired("tg", "alice")).toBe(false);
    expect(store.lockedUntil("tg", "alice")).toBe(T0 + PAIRING_LOCKOUT_MS);
  });

  test("a lockout refuses the correct code even when a pending record still holds it", async () => {
    // Not a state this store writes, but one another writer could leave behind.
    writeState({
      version: 1,
      paired: {},
      pending: {
        [ALICE_ON_TG]: { code: "STILLHERE", expiresAt: T0 + PAIRING_CODE_TTL_MS },
      },
      lockouts: { [ALICE_ON_TG]: { until: T0 + PAIRING_LOCKOUT_MS } },
    });
    const store = openStore();

    expect(await store.redeem("tg", ALICE, "STILLHERE")).toBe(false);
    expect(store.isPaired("tg", "alice")).toBe(false);
    expect(await store.beginChallenge("tg", ALICE)).toEqual({
      kind: "locked",
      lockedUntil: T0 + PAIRING_LOCKOUT_MS,
    });
  });

  test("no new challenge is created while the sender is locked out", async () => {
    const store = openStore();
    await lockAliceOut(store);

    expect(await store.beginChallenge("tg", ALICE)).toEqual({
      kind: "locked",
      lockedUntil: T0 + PAIRING_LOCKOUT_MS,
    });
    await expect(store.challenge("tg", ALICE)).rejects.toThrow(
      `pairing is locked for 'alice' on 'tg' until ${new Date(T0 + PAIRING_LOCKOUT_MS).toISOString()}`,
    );
    expect(issued).toEqual(["CODE0001"]);
    expect(await store.listPending()).toEqual([]);
  });

  test("after the cool-down a new challenge is issued and the lockout is pruned", async () => {
    const store = openStore();
    const voided = await lockAliceOut(store);

    now = T0 + PAIRING_LOCKOUT_MS;
    expect(store.lockedUntil("tg", "alice")).toBeUndefined();
    expect(await store.beginChallenge("tg", ALICE)).toEqual({
      kind: "challenge",
      code: "CODE0002",
      issued: true,
    });
    expect(readState().lockouts).toBeUndefined();
    expect(readState().pending[ALICE_ON_TG]).toEqual({
      code: "CODE0002",
      expiresAt: now + PAIRING_CODE_TTL_MS,
    });

    // The voided code is one more wrong code now; the new one pairs.
    expect(await store.redeem("tg", ALICE, voided)).toBe(false);
    expect(await store.redeem("tg", ALICE, "CODE0002")).toBe(true);
    expect(store.isPaired("tg", "alice")).toBe(true);
  });

  test("text that cannot be a code is not counted", async () => {
    const store = openStore();
    const code = await store.challenge("tg", ALICE);
    const chatter = [
      "",
      "   ",
      "hi",
      "abc",
      " ok ",
      "hello there",
      "two\nlines",
      "tab\tseparated",
      "x".repeat(65),
    ];
    expect(chatter.length).toBeGreaterThan(MAX_PAIRING_ATTEMPTS);

    for (const text of chatter) {
      expect(await store.redeem("tg", ALICE, text)).toBe(false);
    }
    expect(readState().pending[ALICE_ON_TG]).toEqual({
      code,
      expiresAt: T0 + PAIRING_CODE_TTL_MS,
    });
    expect(store.lockedUntil("tg", "alice")).toBeUndefined();

    // The edges of the shape do count: 4 and 64 characters, once trimmed.
    expect(await store.redeem("tg", ALICE, "abcd")).toBe(false);
    expect(await store.redeem("tg", ALICE, ` ${"x".repeat(64)}\n`)).toBe(false);
    expect(readState().pending[ALICE_ON_TG]?.failedAttempts).toBe(2);
    expect(await store.redeem("tg", ALICE, code)).toBe(true);
  });

  test("approve() during a lockout clears it and pairs the sender", async () => {
    const store = openStore();
    await lockAliceOut(store);

    // The host CLI is a separate store on the same file.
    await openStore().approve("tg", "alice");

    expect(store.isPaired("tg", "alice")).toBe(true);
    expect(store.lockedUntil("tg", "alice")).toBeUndefined();
    expect(readState().lockouts).toBeUndefined();
    expect(
      await evaluateDmAccess({ channelId: "tg", sender: ALICE, store }),
    ).toEqual({ kind: "allowed" });
  });

  test("a pairing.json written before the limit existed loads unchanged", async () => {
    // What the previous release wrote: no failedAttempts, no lockouts.
    const legacy = `${JSON.stringify(
      {
        version: 1,
        paired: { tg: ["bob"] },
        pending: {
          [ALICE_ON_TG]: { code: "LEGACY01", expiresAt: T0 + 60_000 },
        },
      },
      null,
      2,
    )}\n`;
    writeStateText(legacy);

    const store = openStore();
    expect(store.isPaired("tg", "bob")).toBe(true);
    expect(store.lockedUntil("tg", "alice")).toBeUndefined();
    expect(await store.listPending()).toEqual([
      { channelId: "tg", peerId: "alice", code: "LEGACY01", expiresAt: T0 + 60_000 },
    ]);
    expect(await store.beginChallenge("tg", ALICE)).toEqual({
      kind: "challenge",
      code: "LEGACY01",
      issued: false,
    });
    // Reading it rewrote nothing.
    expect(readFileSync(statePath(), "utf8")).toBe(legacy);

    // Its count starts at zero: four wrong codes later the old code pairs.
    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 1);
    expect(await store.redeem("tg", ALICE, "legacy01")).toBe(true);
    expect(store.listPaired("tg")).toEqual(["bob", "alice"]);
    // With nobody locked out the file keeps the old shape.
    expect(Object.keys(readState())).toEqual(["version", "paired", "pending"]);
  });

  test("a file that holds only paired senders loads", async () => {
    writeStateText(JSON.stringify({ version: 1, paired: { tg: ["bob"] } }));
    const store = openStore();

    expect(store.isPaired("tg", "bob")).toBe(true);
    expect(store.lockedUntil("tg", "bob")).toBeUndefined();
    await lockAliceOut(store);
    expect(store.isPaired("tg", "bob")).toBe(true);
    expect(store.lockedUntil("tg", "alice")).toBe(T0 + PAIRING_LOCKOUT_MS);
  });

  test("failed attempts and the lockout survive a reload", async () => {
    const first = openStore();
    const code = await first.challenge("tg", ALICE);
    await sendWrongCodes(first, 3);

    // A new PairingStore on the same file carries on from the stored count.
    const second = openStore();
    expect(await second.redeem("tg", ALICE, "WRONG4")).toBe(false);
    expect(second.lockedUntil("tg", "alice")).toBeUndefined();
    expect(await second.redeem("tg", ALICE, "WRONG5")).toBe(false);
    expect(second.lockedUntil("tg", "alice")).toBe(T0 + PAIRING_LOCKOUT_MS);

    const third = openStore();
    expect(third.lockedUntil("tg", "alice")).toBe(T0 + PAIRING_LOCKOUT_MS);
    expect(await third.redeem("tg", ALICE, code)).toBe(false);
    expect(third.isPaired("tg", "alice")).toBe(false);
  });

  test("the count and the lockout are per sender and per channel", async () => {
    const store = openStore();
    await store.challenge("tg", ALICE);
    const bobCode = await store.challenge("tg", BOB);
    const discordCode = await store.challenge("discord", ALICE);

    // Twelve wrong codes in all, four on each code: nobody is at the limit.
    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 1, "tg", ALICE);
    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 1, "tg", BOB);
    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 1, "discord", ALICE);
    expect(readState().lockouts).toBeUndefined();

    // Alice's 5th on tg locks her out there, and only there.
    expect(await store.redeem("tg", ALICE, "WRONG5")).toBe(false);
    expect(readState().lockouts).toEqual({
      [ALICE_ON_TG]: { until: T0 + PAIRING_LOCKOUT_MS },
    });
    expect(store.lockedUntil("tg", "bob")).toBeUndefined();
    expect(store.lockedUntil("discord", "alice")).toBeUndefined();
    expect(await store.redeem("tg", BOB, bobCode)).toBe(true);
    expect(await store.redeem("discord", ALICE, discordCode)).toBe(true);
    expect(store.isPaired("tg", "bob")).toBe(true);
    expect(store.isPaired("discord", "alice")).toBe(true);
    expect(store.isPaired("tg", "alice")).toBe(false);
    expect(store.lockedUntil("tg", "alice")).toBe(T0 + PAIRING_LOCKOUT_MS);
  });

  test("a count belongs to one code: an expired code takes its count with it", async () => {
    const store = openStore();
    await store.challenge("tg", ALICE);
    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 1);

    now = T0 + PAIRING_CODE_TTL_MS;
    expect(await store.beginChallenge("tg", ALICE)).toEqual({
      kind: "challenge",
      code: "CODE0002",
      issued: true,
    });
    expect(readState().pending[ALICE_ON_TG]).toEqual({
      code: "CODE0002",
      expiresAt: now + PAIRING_CODE_TTL_MS,
    });
    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 1);
    expect(store.lockedUntil("tg", "alice")).toBeUndefined();
  });

  test("asking again for the live code keeps the code and its count", async () => {
    const store = openStore();
    const code = await store.challenge("tg", ALICE);
    await sendWrongCodes(store, 2);

    expect(await store.beginChallenge("tg", ALICE)).toEqual({
      kind: "challenge",
      code,
      issued: false,
    });
    expect(await store.challenge("tg", ALICE)).toBe(code);
    expect(readState().pending[ALICE_ON_TG]?.failedAttempts).toBe(2);

    await sendWrongCodes(store, MAX_PAIRING_ATTEMPTS - 2);
    expect(store.lockedUntil("tg", "alice")).toBe(T0 + PAIRING_LOCKOUT_MS);
  });

  test("a stored count the limit cannot have produced voids that code", async () => {
    const record = (failedAttempts: unknown) => ({
      code: "KEPT0001",
      expiresAt: T0 + 60_000,
      failedAttempts,
    });
    writeState({
      version: 1,
      paired: {},
      pending: {
        "tg\u0000text": record("2"),
        "tg\u0000negative": record(-1),
        "tg\u0000fraction": record(1.5),
        "tg\u0000atlimit": record(MAX_PAIRING_ATTEMPTS),
        "tg\u0000null": record(null),
        "tg\u0000zero": record(0),
        "tg\u0000three": record(3),
      },
    });
    const store = openStore();

    expect((await store.listPending()).map((entry) => entry.peerId)).toEqual([
      "zero",
      "three",
    ]);
    // A voided code cannot be redeemed.
    expect(await store.redeem("tg", { peerId: "text" }, "KEPT0001")).toBe(false);
    expect(store.isPaired("tg", "text")).toBe(false);
    // A readable count carries on from where it was.
    await sendWrongCodes(store, 2, "tg", { peerId: "three" });
    expect(store.lockedUntil("tg", "three")).toBe(T0 + PAIRING_LOCKOUT_MS);
  });

  test("lockout entries that do not hold a time are ignored", async () => {
    writeState({
      version: 1,
      paired: { tg: ["bob"] },
      pending: {},
      lockouts: {
        "tg\u0000number": T0 + 60_000,
        "tg\u0000null": null,
        "tg\u0000text": { until: "later" },
        "tg\u0000missing": {},
        "tg\u0000beyond": { until: 1e300 },
        "tg\u0000valid": { until: T0 + 60_000 },
      },
    });
    const store = openStore();

    for (const peerId of ["number", "null", "text", "missing", "beyond"]) {
      expect(store.lockedUntil("tg", peerId)).toBeUndefined();
    }
    expect(store.lockedUntil("tg", "valid")).toBe(T0 + 60_000);
    expect(store.isPaired("tg", "bob")).toBe(true);

    // A lockouts value that is not a map leaves the rest of the file readable.
    writeState({ version: 1, paired: { tg: ["bob"] }, pending: {}, lockouts: "none" });
    expect(store.lockedUntil("tg", "valid")).toBeUndefined();
    expect(store.isPaired("tg", "bob")).toBe(true);
  });

  test("a corrupt file still fails closed: nobody is paired", async () => {
    const store = openStore();
    await store.approve("tg", "bob");
    await lockAliceOut(store);
    expect(store.isPaired("tg", "bob")).toBe(true);

    writeStateText(`${readFileSync(statePath(), "utf8")}}`);

    expect(store.isPaired("tg", "bob")).toBe(false);
    expect(openStore().listPaired("tg")).toEqual([]);
  });
});

describe("evaluateDmAccess under the attempt limit (#3443)", () => {
  test("a challenge says whether this evaluation issued its code", async () => {
    const store = openStore();

    expect(
      await evaluateDmAccess({ channelId: "tg", sender: ALICE, store }),
    ).toEqual({ kind: "pairing_challenge", code: "CODE0001", issued: true });
    expect(
      await evaluateDmAccess({ channelId: "tg", sender: ALICE, store }),
    ).toEqual({ kind: "pairing_challenge", code: "CODE0001", issued: false });
  });

  test("a locked-out sender is reported without opening a transaction", async () => {
    const store = openStore();
    await lockAliceOut(store);
    const beginChallenge = vi.spyOn(store, "beginChallenge");

    expect(
      await evaluateDmAccess({ channelId: "tg", sender: ALICE, store }),
    ).toEqual({ kind: "pairing_locked", lockedUntil: T0 + PAIRING_LOCKOUT_MS });
    expect(beginChallenge).not.toHaveBeenCalled();
  });

  test("a lockout that lands after the plain read is still reported", async () => {
    const store = openStore();
    await lockAliceOut(store);
    // The read ran just before the wrong code that locked the sender out.
    vi.spyOn(store, "lockedUntil").mockReturnValueOnce(undefined);

    expect(
      await evaluateDmAccess({ channelId: "tg", sender: ALICE, store }),
    ).toEqual({ kind: "pairing_locked", lockedUntil: T0 + PAIRING_LOCKOUT_MS });
    expect(issued).toEqual(["CODE0001"]);
  });

  test("an allowlisted sender is allowed even while a lockout is stored", async () => {
    const store = openStore();
    await lockAliceOut(store);

    expect(
      await evaluateDmAccess({
        policy: { dmPolicy: "pairing", allowlist: ["alice"] },
        channelId: "tg",
        sender: ALICE,
        store,
      }),
    ).toEqual({ kind: "allowed" });
  });
});
