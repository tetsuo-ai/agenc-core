// Telegram owner control state file (#3441). The state says who owns the bot
// and whether public group replies are paused, so:
//  - it is written by temporary file + rename, and a failed write leaves the
//    previous state in place;
//  - a state file that is present but cannot be used fails closed instead of
//    falling back to the first-run defaults (public replies on, no owners).

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  TelegramOwnerControl,
  type TelegramOwnerControlDecision,
} from "../../src/gateway/control-plane.js";
import { ChannelGateway } from "../../src/gateway/gateway.js";
import { TELEGRAM_CHANNEL_ID } from "../../src/gateway/telegram-channel.js";
import { InMemoryChannelAdapter } from "../../src/gateway/test-channel.js";
import type {
  GatewayDaemonClient,
  GatewaySession,
} from "../../src/gateway/types.js";

type FailureStage = "write" | "sync" | "rename";

interface FailedWrite {
  readonly path: string;
  readonly temporaryPath: string;
  readonly mode: number;
  /** What the temporary file held when the injected step failed. */
  readonly temporaryContent: string;
}

// The real durable write, with one step made to fail. Nothing is injected
// while `stage` is undefined.
const injected = vi.hoisted(() => ({
  stage: undefined as FailureStage | undefined,
  failures: [] as FailedWrite[],
}));
vi.mock("../../src/utils/durable-atomic-file.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/utils/durable-atomic-file.js")
    >();
  return {
    ...actual,
    writeDurableAtomicFileSync: (
      path: string,
      temporaryPath: string,
      data: string,
      mode = 0o600,
    ) => {
      const stage = injected.stage;
      if (stage === undefined) {
        return actual.writeDurableAtomicFileSync(
          path,
          temporaryPath,
          data,
          mode,
        );
      }
      const fail = (): never => {
        injected.failures.push({
          path,
          temporaryPath,
          mode,
          temporaryContent: readFileSync(temporaryPath, "utf8"),
        });
        throw new Error(`injected ${stage} failure`);
      };
      return actual.writeDurableAtomicFileSync(path, temporaryPath, data, mode, {
        mkdir: (directory) => {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
        },
        openTemporary: (temporary, fileMode) =>
          openSync(temporary, "wx", fileMode),
        write: (handle, content) => {
          if (stage === "write") {
            // A full disk: part of the data lands, then the write fails.
            writeFileSync(
              handle as number,
              content.slice(0, Math.floor(content.length / 2)),
            );
            fail();
          }
          writeFileSync(handle as number, content);
        },
        sync: (handle) => {
          if (stage === "sync") fail();
          fsyncSync(handle as number);
        },
        close: (handle) => closeSync(handle as number),
        rename: () => {
          if (stage === "rename") fail();
          throw new Error("a failed write reached the rename");
        },
        syncDirectory: () => {
          throw new Error("a failed write reached the directory sync");
        },
        remove: (temporary) => rmSync(temporary, { force: true }),
      });
    },
  };
});

const NOW = "2026-01-02T03:04:05.000Z";
const CLAIM_CODE = "CLAIM123";

interface Exchange {
  readonly decision: TelegramOwnerControlDecision;
  readonly replies: readonly string[];
}

/** The message goes on to the agent, past the access gate; nothing is said. */
const TO_AGENT: Exchange = {
  decision: { handled: false, bypassAccess: true },
  replies: [],
};
/** The owner control keeps the message and says nothing. */
const SILENT: Exchange = { decision: { handled: true }, replies: [] };

let home: string;
let gatewayDirectory: string;
let statePath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-control-plane-"));
  gatewayDirectory = join(home, "gateway");
  statePath = join(gatewayDirectory, "control.json");
});
afterEach(() => {
  injected.stage = undefined;
  injected.failures.length = 0;
  rmSync(home, { recursive: true, force: true });
});

function ownerControl(
  options: {
    readonly adminPeerIds?: readonly string[];
    readonly ownerClaimCode?: string;
    readonly logs?: string[];
  } = {},
): TelegramOwnerControl {
  const { logs } = options;
  return new TelegramOwnerControl({
    agencHome: home,
    now: () => new Date(NOW),
    ...(options.adminPeerIds !== undefined
      ? { adminPeerIds: options.adminPeerIds }
      : {}),
    ...(options.ownerClaimCode !== undefined
      ? { ownerClaimCode: options.ownerClaimCode }
      : {}),
    ...(logs !== undefined ? { log: (line: string) => logs.push(line) } : {}),
  });
}

async function send(
  control: TelegramOwnerControl,
  peerId: string,
  kind: "dm" | "group",
  text: string,
): Promise<Exchange> {
  const replies: string[] = [];
  const decision = await control.handle({
    message: {
      channelId: TELEGRAM_CHANNEL_ID,
      sender: { peerId },
      conversation: { kind, id: kind === "dm" ? `dm-${peerId}` : "group-1" },
      text,
    },
    reply: async (line) => {
      replies.push(line);
      return "sent";
    },
  });
  return { decision, replies };
}

/** The one reply to a message that the owner control kept. */
async function replyTo(
  control: TelegramOwnerControl,
  peerId: string,
  kind: "dm" | "group",
  text: string,
): Promise<string> {
  const exchange = await send(control, peerId, kind, text);
  expect(exchange.decision).toEqual({ handled: true });
  expect(exchange.replies).toHaveLength(1);
  return exchange.replies[0];
}

function storedState(): unknown {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Changes whenever the entry at `path` is rewritten, replaced or re-moded. */
function fingerprint(path: string): string {
  const stats = lstatSync(path, { bigint: true });
  return [
    stats.ino,
    stats.size,
    stats.mode,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(":");
}

function unreadableLogs(logs: readonly string[]): string[] {
  return logs.filter((line) => line.includes("is unreadable"));
}

describe("isOwnerControlMessage", () => {
  function isControl(
    control: TelegramOwnerControl,
    peerId: string,
    kind: "dm" | "group",
    text: string,
    channelId: string = TELEGRAM_CHANNEL_ID,
  ): boolean {
    return control.isOwnerControlMessage({
      channelId,
      sender: { peerId },
      conversation: { kind, id: kind === "dm" ? `dm-${peerId}` : "group-1" },
      text,
    });
  }

  test("is true for an owner's control command in the private chat", () => {
    const control = ownerControl({ adminPeerIds: ["admin"] });
    for (const text of [
      "/stop",
      "/start",
      "/status",
      "/help",
      "/pause",
      "/resume",
      "  /stop  ",
      "/STOP",
      "/stop@agenc_bot",
      "/stop now please",
    ]) {
      expect(isControl(control, "admin", "dm", text)).toBe(true);
    }
  });

  test("is false for anyone who is not an owner", () => {
    const control = ownerControl({
      adminPeerIds: ["admin"],
      ownerClaimCode: CLAIM_CODE,
    });
    expect(isControl(control, "guest", "dm", "/stop")).toBe(false);
    expect(isControl(control, "", "dm", "/stop")).toBe(false);
  });

  test("is false for anything that is answered with a turn or by a claim", () => {
    const control = ownerControl({ adminPeerIds: ["admin"] });
    for (const text of [
      "stop",
      "please /stop",
      "/image a cat",
      "/unknown",
      "/",
      "",
      // A claim comes from an account that is not an owner yet.
      `/owner ${CLAIM_CODE}`,
    ]) {
      expect(isControl(control, "admin", "dm", text)).toBe(false);
    }
  });

  test("is false in a group and on another channel", () => {
    const control = ownerControl({ adminPeerIds: ["admin"] });
    expect(isControl(control, "admin", "group", "/stop")).toBe(false);
    expect(isControl(control, "admin", "dm", "/stop", "discord")).toBe(false);
  });

  test("knows an owner who claimed the bot", async () => {
    const control = ownerControl({ ownerClaimCode: CLAIM_CODE });
    expect(isControl(control, "owner", "dm", "/stop")).toBe(false);
    await send(control, "owner", "dm", `/owner ${CLAIM_CODE}`);
    expect(isControl(control, "owner", "dm", "/stop")).toBe(true);
    expect(isControl(control, "guest", "dm", "/stop")).toBe(false);
  });

  test("with unreadable state only owners from adminPeerIds count", async () => {
    const control = ownerControl({
      adminPeerIds: ["admin"],
      ownerClaimCode: CLAIM_CODE,
    });
    await send(control, "admin", "dm", "/start");
    writeFileSync(statePath, JSON.stringify({ ownerPeerIds: ["stored"] }));
    expect(isControl(control, "stored", "dm", "/stop")).toBe(true);

    writeFileSync(statePath, "");
    expect(isControl(control, "stored", "dm", "/stop")).toBe(false);
    expect(isControl(control, "admin", "dm", "/stop")).toBe(true);
  });
});

describe("first run: no state file", () => {
  test("keeps the open defaults and writes nothing until an owner command saves", async () => {
    const logs: string[] = [];
    const control = ownerControl({ ownerClaimCode: CLAIM_CODE, logs });

    expect(await send(control, "guest", "group", "hello")).toEqual(TO_AGENT);
    expect(await replyTo(control, "guest", "group", "/stop")).toBe(
      "Owner setup is not claimed yet. The owner must DM /owner <code>.",
    );
    expect(await replyTo(control, "owner", "dm", "/owner nope")).toBe(
      "Wrong owner code.",
    );
    expect(existsSync(gatewayDirectory)).toBe(false);

    expect(
      await replyTo(control, "owner", "dm", `/owner ${CLAIM_CODE}`),
    ).toContain("Owner claimed.");
    expect(storedState()).toEqual({
      publicEnabled: true,
      ownerPeerIds: ["owner"],
      updatedAt: NOW,
    });
    expect(unreadableLogs(logs)).toEqual([]);
  });

  test("a failed first write leaves no file, so the bot is unclaimed and not locked", async () => {
    const logs: string[] = [];
    const control = ownerControl({ ownerClaimCode: CLAIM_CODE, logs });

    injected.stage = "write";
    await expect(
      send(control, "owner", "dm", `/owner ${CLAIM_CODE}`),
    ).rejects.toThrow("injected write failure");
    injected.stage = undefined;

    expect(readdirSync(gatewayDirectory)).toEqual([]);
    expect(await send(control, "guest", "group", "hello")).toEqual(TO_AGENT);
    expect(unreadableLogs(logs)).toEqual([]);
    expect(
      await replyTo(control, "owner", "dm", `/owner ${CLAIM_CODE}`),
    ).toContain("Owner claimed.");
    expect(storedState()).toMatchObject({ ownerPeerIds: ["owner"] });
  });
});

describe("a readable state file", () => {
  test("is written 0600 in a 0700 directory, by replacing the file", async () => {
    const control = ownerControl({ adminPeerIds: ["admin"] });

    await send(control, "admin", "dm", "/stop");
    expect(fileMode(statePath)).toBe(0o600);
    expect(fileMode(gatewayDirectory)).toBe(0o700);

    // An in-place write would keep both the inode and the loose mode.
    chmodSync(statePath, 0o644);
    const previousInode = statSync(statePath).ino;
    await send(control, "admin", "dm", "/start");

    expect(statSync(statePath).ino).not.toBe(previousInode);
    expect(fileMode(statePath)).toBe(0o600);
    expect(readdirSync(gatewayDirectory)).toEqual(["control.json"]);
    expect(storedState()).toEqual({
      publicEnabled: true,
      ownerPeerIds: [],
      updatedAt: NOW,
    });
  });

  test("holding a JSON object is normalized field by field, as before", async () => {
    const logs: string[] = [];
    const control = ownerControl({ ownerClaimCode: CLAIM_CODE, logs });
    mkdirSync(gatewayDirectory, { recursive: true });

    // No fields at all: the defaults, exactly like a first run.
    writeFileSync(statePath, "{}");
    expect(await send(control, "guest", "group", "hello")).toEqual(TO_AGENT);

    writeFileSync(
      statePath,
      JSON.stringify({
        publicEnabled: false,
        ownerPeerIds: ["stored", 7, " spaced "],
        extra: true,
      }),
    );
    expect(await send(control, "guest", "group", "hello")).toEqual(SILENT);
    const status = await replyTo(control, "spaced", "dm", "/status");
    expect(status).toContain("Public group: paused");
    expect(status).toContain("Owners: 2");
    expect(status).not.toContain("unreadable");
    expect(unreadableLogs(logs)).toEqual([]);
  });
});

const UNUSABLE_STATE_FILES: ReadonlyArray<{
  readonly name: string;
  readonly reason: string;
  readonly damage: (path: string) => void;
}> = [
  {
    name: "an empty file",
    reason: "the file is empty",
    damage: (path) => writeFileSync(path, ""),
  },
  {
    name: "truncated JSON",
    reason: "the file is not valid JSON",
    damage: (path) => {
      const stored = readFileSync(path, "utf8");
      writeFileSync(path, stored.slice(0, Math.floor(stored.length / 2)));
    },
  },
  {
    name: "a JSON array",
    reason: "the JSON value is not an object",
    damage: (path) => writeFileSync(path, `[${readFileSync(path, "utf8")}]`),
  },
  {
    name: "JSON null",
    reason: "the JSON value is not an object",
    damage: (path) => writeFileSync(path, "null\n"),
  },
  {
    name: "a JSON string",
    reason: "the JSON value is not an object",
    damage: (path) => writeFileSync(path, '"paused"\n'),
  },
  {
    name: "an unreadable file (no read permission)",
    reason: "the read failed with EACCES",
    damage: (path) => {
      // The stored state stays valid: only the read can fail.
      chmodSync(path, 0o000);
      // Needs a process the permission bits apply to. The hermetic lane
      // drops every capability, so that holds there even for uid 0.
      expect(() => readFileSync(path)).toThrow(/EACCES/);
    },
  },
  {
    name: "an unreadable file (a link to itself)",
    reason: "the read failed with ELOOP",
    damage: (path) => {
      // Unreadable for every user, a privileged one included.
      rmSync(path);
      symlinkSync("control.json", path);
    },
  },
];

describe.each(UNUSABLE_STATE_FILES)(
  "state file present but unusable: $name",
  ({ reason, damage }) => {
    // The same state file seen by two gateway configurations: an owner claim
    // code only, and a claim code plus an admin owner from the environment.
    let logs: string[];
    let claimOnly: TelegramOwnerControl;
    let withAdmin: TelegramOwnerControl;
    let damaged: string;

    beforeEach(async () => {
      logs = [];
      claimOnly = ownerControl({ ownerClaimCode: CLAIM_CODE, logs });
      withAdmin = ownerControl({
        ownerClaimCode: CLAIM_CODE,
        adminPeerIds: ["admin"],
      });

      // A claimed bot with public replies on: the opposite of the closed state.
      expect(
        await replyTo(claimOnly, "stored", "dm", `/owner ${CLAIM_CODE}`),
      ).toContain("Owner claimed.");
      expect(await send(claimOnly, "guest", "group", "hi")).toEqual(TO_AGENT);
      expect(await send(claimOnly, "stored", "dm", "hi")).toEqual(TO_AGENT);

      damage(statePath);
      damaged = fingerprint(statePath);
    });

    function expectFileLeftAlone(): void {
      expect(fingerprint(statePath)).toBe(damaged);
      expect(readdirSync(gatewayDirectory)).toEqual(["control.json"]);
    }

    test("group messages are not answered", async () => {
      expect(await send(claimOnly, "guest", "group", "hi")).toEqual(SILENT);
      expect(await send(claimOnly, "stored", "group", "hi")).toEqual(SILENT);
      expect(await send(withAdmin, "guest", "group", "hi")).toEqual(SILENT);
      // Public replies are off for everyone, as after /stop.
      expect(await send(withAdmin, "admin", "group", "hi")).toEqual(SILENT);

      expectFileLeftAlone();
      expect(unreadableLogs(logs)).toHaveLength(1);
      expect(unreadableLogs(logs)[0]).toContain(`'${statePath}'`);
      expect(unreadableLogs(logs)[0]).toContain(`(${reason})`);
    });

    test("/owner is refused", async () => {
      const refused =
        "Owner claim refused: the owner state on the host is unreadable.";
      const refusal = `${refused}\nThe host operator must repair the state file first.`;
      const claim = `/owner ${CLAIM_CODE}`;
      expect(await replyTo(claimOnly, "mallory", "dm", claim)).toBe(refusal);
      expect(await replyTo(claimOnly, "stored", "dm", claim)).toBe(refusal);
      expect(await replyTo(claimOnly, "mallory", "group", claim)).toBe(refusal);
      expect(await replyTo(withAdmin, "mallory", "dm", claim)).toBe(refusal);
      // An admin owner is pointed at /status, which says how to replace it.
      expect(await replyTo(withAdmin, "admin", "dm", claim)).toBe(
        `${refused}\nUse /status to see how to replace it.`,
      );

      // Nobody became an owner, and nothing was written.
      expect(await send(claimOnly, "mallory", "dm", "hi")).toEqual(SILENT);
      expect(await send(withAdmin, "mallory", "dm", "hi")).toEqual(SILENT);
      expectFileLeftAlone();
    });

    test("the stored owner is no longer an owner", async () => {
      for (const control of [claimOnly, withAdmin]) {
        expect(await send(control, "stored", "dm", "hi")).toEqual(SILENT);
        expect(await send(control, "stored", "dm", "/status")).toEqual(SILENT);
        expect(await send(control, "stored", "dm", "/start")).toEqual(SILENT);
      }
      // A claim would be refused, so the group reply does not invite one.
      expect(await replyTo(claimOnly, "stored", "group", "/start")).toBe(
        "Owner-only command.",
      );
      expectFileLeftAlone();
    });

    test("an admin owner still works and /stop repairs the file", async () => {
      expect(await send(withAdmin, "admin", "dm", "hi")).toEqual(TO_AGENT);
      const status = await replyTo(withAdmin, "admin", "dm", "/status");
      expect(status).toContain("Public group: paused");
      expect(status).toContain("Owners: 1");
      expect(status).toContain("Stored state: unreadable on the host.");
      expect(status).toContain("Send /stop or /start");
      expectFileLeftAlone();

      expect(await replyTo(withAdmin, "admin", "dm", "/stop")).toBe(
        "Public group replies are PAUSED. Use /start to resume.",
      );

      // A fresh, valid, private file. The stored owner is not restored.
      expect(lstatSync(statePath).isFile()).toBe(true);
      expect(fileMode(statePath)).toBe(0o600);
      expect(readdirSync(gatewayDirectory)).toEqual(["control.json"]);
      expect(storedState()).toEqual({
        publicEnabled: false,
        ownerPeerIds: [],
        updatedAt: NOW,
      });
      const repaired = await replyTo(withAdmin, "admin", "dm", "/status");
      expect(repaired).toContain("Public group: paused");
      expect(repaired).toContain("Owners: 1");
      expect(repaired).not.toContain("unreadable");
      expect(await send(withAdmin, "stored", "dm", "hi")).toEqual(SILENT);
      expect(await send(withAdmin, "guest", "group", "hi")).toEqual(SILENT);

      // From here on it is an ordinary paused bot.
      expect(await replyTo(withAdmin, "admin", "dm", "/start")).toBe(
        "Public group replies are ON.",
      );
      expect(await send(withAdmin, "guest", "group", "hi")).toEqual(TO_AGENT);
    });

    test("an admin owner can also repair it with /start", async () => {
      expect(await replyTo(withAdmin, "admin", "dm", "/start")).toBe(
        "Public group replies are ON.",
      );

      expect(lstatSync(statePath).isFile()).toBe(true);
      expect(fileMode(statePath)).toBe(0o600);
      expect(storedState()).toEqual({
        publicEnabled: true,
        ownerPeerIds: [],
        updatedAt: NOW,
      });
      expect(await send(withAdmin, "guest", "group", "hi")).toEqual(TO_AGENT);
      expect(await send(withAdmin, "stored", "dm", "hi")).toEqual(SILENT);
    });
  },
);

describe("the unreadable state log line", () => {
  test("is written once until the state is readable again, not once per message", async () => {
    const logs: string[] = [];
    const control = ownerControl({ adminPeerIds: ["admin"], logs });
    await send(control, "admin", "dm", "/start");

    writeFileSync(statePath, "");
    await send(control, "guest", "group", "one");
    await send(control, "guest", "group", "two");
    await send(control, "guest", "dm", "three");
    await send(control, "admin", "dm", "/status");
    await send(control, "guest", "dm", "/owner whatever");
    expect(unreadableLogs(logs)).toEqual([
      [
        `telegram-control: control state '${statePath}' is unreadable (the file is empty);`,
        "failing closed: public group replies are off, stored owners are ignored and /owner claims are refused.",
        "Repair the file, or have an admin owner send /stop or /start to replace it.",
        "Removing the file instead resets the bot to its first-run state: public replies on, no stored owner, and open to a new /owner claim.",
      ].join(" "),
    ]);

    // Repaired by an owner command, then damaged again before any other
    // message: it was readable in between, so it is reported again.
    await send(control, "admin", "dm", "/stop");
    writeFileSync(statePath, "[]");
    await send(control, "guest", "group", "four");
    await send(control, "guest", "group", "five");
    expect(unreadableLogs(logs)).toHaveLength(2);
    expect(unreadableLogs(logs)[1]).toContain(
      "(the JSON value is not an object)",
    );

    // Removed by the operator: a first run again, with the open defaults.
    rmSync(statePath);
    expect(await send(control, "guest", "group", "six")).toEqual(TO_AGENT);
    expect(unreadableLogs(logs)).toHaveLength(2);

    // Repaired by the operator on the host, then damaged once more.
    writeFileSync(
      statePath,
      JSON.stringify({ publicEnabled: true, ownerPeerIds: [] }),
    );
    expect(await send(control, "guest", "group", "seven")).toEqual(TO_AGENT);
    writeFileSync(statePath, '{"publicEnabled":');
    await send(control, "guest", "group", "eight");
    await send(control, "guest", "group", "nine");
    expect(unreadableLogs(logs)).toHaveLength(3);
    expect(unreadableLogs(logs)[2]).toContain("(the file is not valid JSON)");
  });
});

describe("a state write that fails before the rename", () => {
  test.each(["write", "sync", "rename"] as const)(
    "keeps the previous state when the %s step fails",
    async (stage) => {
      const control = ownerControl({ ownerClaimCode: CLAIM_CODE });
      await send(control, "owner", "dm", `/owner ${CLAIM_CODE}`);
      await send(control, "owner", "dm", "/stop");
      const previous = readFileSync(statePath, "utf8");
      expect(JSON.parse(previous)).toEqual({
        publicEnabled: false,
        ownerPeerIds: ["owner"],
        updatedAt: NOW,
      });

      injected.stage = stage;
      await expect(send(control, "owner", "dm", "/start")).rejects.toThrow(
        `injected ${stage} failure`,
      );
      injected.stage = undefined;

      // The failure hit a temporary file next to the state, never the state.
      expect(injected.failures).toHaveLength(1);
      const failure = injected.failures[0];
      expect(failure.path).toBe(statePath);
      expect(failure.mode).toBe(0o600);
      expect(failure.temporaryPath).not.toBe(statePath);
      expect(dirname(failure.temporaryPath)).toBe(gatewayDirectory);
      if (stage === "write") {
        expect(() => JSON.parse(failure.temporaryContent)).toThrow();
      } else {
        // The new state was complete; only the rename was missing.
        expect(JSON.parse(failure.temporaryContent)).toEqual({
          publicEnabled: true,
          ownerPeerIds: ["owner"],
          updatedAt: NOW,
        });
      }

      expect(readFileSync(statePath, "utf8")).toBe(previous);
      expect(fileMode(statePath)).toBe(0o600);
      expect(readdirSync(gatewayDirectory)).toEqual(["control.json"]);

      // Still paused, still owned by the same account.
      expect(await send(control, "guest", "group", "hi")).toEqual(SILENT);
      const status = await replyTo(control, "owner", "dm", "/status");
      expect(status).toContain("Public group: paused");
      expect(status).toContain("Owners: 1");
      expect(status).not.toContain("unreadable");
      expect(
        await replyTo(control, "mallory", "dm", `/owner ${CLAIM_CODE}`),
      ).toBe("Owner already configured. Private control is owner-only.");

      // The next write goes through.
      expect(await replyTo(control, "owner", "dm", "/start")).toBe(
        "Public group replies are ON.",
      );
      expect(storedState()).toEqual({
        publicEnabled: true,
        ownerPeerIds: ["owner"],
        updatedAt: NOW,
      });
    },
  );

  test("leaves an unreadable file as it was when the repair fails", async () => {
    const logs: string[] = [];
    const control = ownerControl({ adminPeerIds: ["admin"], logs });
    await send(control, "admin", "dm", "/start");
    writeFileSync(statePath, "");
    const damaged = fingerprint(statePath);

    injected.stage = "rename";
    await expect(send(control, "admin", "dm", "/start")).rejects.toThrow(
      "injected rename failure",
    );
    injected.stage = undefined;

    // Still the same unusable file, still closed, and not reported twice.
    expect(fingerprint(statePath)).toBe(damaged);
    expect(readdirSync(gatewayDirectory)).toEqual(["control.json"]);
    expect(await send(control, "guest", "group", "hi")).toEqual(SILENT);
    expect(await replyTo(control, "admin", "dm", "/status")).toContain(
      "Stored state: unreadable on the host.",
    );
    expect(unreadableLogs(logs)).toHaveLength(1);

    expect(await replyTo(control, "admin", "dm", "/start")).toBe(
      "Public group replies are ON.",
    );
    expect(await send(control, "guest", "group", "hi")).toEqual(TO_AGENT);
  });
});

describe("through the channel gateway", () => {
  class RecordingDaemonClient implements GatewayDaemonClient {
    readonly prompts: string[] = [];

    async createSession(): Promise<GatewaySession> {
      return this.#session("sess-1");
    }
    async attachSession(sessionId: string): Promise<GatewaySession> {
      return this.#session(sessionId);
    }
    async close(): Promise<void> {}

    #session(sessionId: string): GatewaySession {
      return {
        sessionId,
        prompt: async (text, handlers) => {
          this.prompts.push(text);
          await handlers.onEvent({ type: "text", delta: "agent reply" });
          return { stopReason: "completed", finalMessage: "agent reply" };
        },
      };
    }
  }

  test("an emptied state file keeps a paused group and the private DM away from the agent", async () => {
    const client = new RecordingDaemonClient();
    const telegram = new InMemoryChannelAdapter({ id: TELEGRAM_CHANNEL_ID });
    const gateway = new ChannelGateway({
      agencHome: home,
      client,
      config: {
        channels: { telegram: { dmPolicy: "pairing", allowlist: [] } },
        bindings: [],
        defaultAgent: "default",
      },
      controlPlane: ownerControl({ ownerClaimCode: CLAIM_CODE }),
    });
    await gateway.registerAdapter(telegram);
    const dm = (peerId: string, text: string) =>
      telegram.receive({
        sender: { peerId },
        conversation: { kind: "dm", id: `dm-${peerId}` },
        text,
      });
    const group = (peerId: string, text: string) =>
      telegram.receive({
        sender: { peerId },
        conversation: { kind: "group", id: "group-1" },
        text,
      });

    await dm("owner", `/owner ${CLAIM_CODE}`);
    await group("guest", "while public");
    expect(client.prompts).toHaveLength(1);
    await dm("owner", "/stop");
    expect(telegram.lastText("dm-owner")).toContain("PAUSED");

    // What an interrupted or out-of-space in-place write left behind.
    writeFileSync(statePath, "");
    const sent = telegram.sent.length;

    await group("guest", "while the state is unreadable");
    await dm("owner", "/status");
    await dm("owner", "let me in");
    expect(client.prompts).toHaveLength(1);
    expect(telegram.sent).toHaveLength(sent);

    await dm("mallory", `/owner ${CLAIM_CODE}`);
    expect(telegram.lastText("dm-mallory")).toContain(
      "the owner state on the host is unreadable",
    );
    await dm("mallory", "let me in");
    expect(client.prompts).toHaveLength(1);
    expect(readFileSync(statePath, "utf8")).toBe("");
  });
});
