import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ledgerCommand } from "../../src/commands/ledger.js";

type FakeResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly error?: Error;
  readonly neverClose?: boolean;
};

let lastSpawn: { cmd: string; args: readonly string[] } | null = null;

function fakeChild(result: FakeResult) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  if (!result.neverClose) {
    process.nextTick(() => {
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      if (result.stdout) child.stdout.emit("data", result.stdout);
      if (result.stderr) child.stderr.emit("data", result.stderr);
      child.emit("close", result.code ?? 0);
    });
  }
  return child;
}

let nextResult: FakeResult = { code: 0, stdout: "" };

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: readonly string[]) => {
    lastSpawn = { cmd, args };
    return fakeChild(nextResult);
  }),
  // ledgerStatus.refreshLedgerStatus (fired by the command) reads via execFile;
  // resolve to "no device" so it stays inert in tests.
  execFile: vi.fn(
    (
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string) => void,
    ) => {
      cb(null, "");
    },
  ),
}));

function makeCtx(argsRaw: string) {
  return { argsRaw, cwd: "/tmp" } as never;
}

afterEach(() => {
  lastSpawn = null;
  nextResult = { code: 0, stdout: "" };
});

describe("/ledger command", () => {
  test("bare /ledger runs session view and appends usage", async () => {
    nextResult = { code: 0, stdout: "ethereum-1\nbitcoin-1\n" };
    const result = (await ledgerCommand.execute(makeCtx(""))) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(lastSpawn?.cmd).toBe("wallet-cli");
    expect(lastSpawn?.args).toEqual(["session", "view", "--output", "human"]);
    expect(result.text).toContain("ethereum-1");
    expect(result.text).toContain("/ledger balances");
  });

  test("passes a read-only subcommand through to wallet-cli", async () => {
    nextResult = { code: 0, stdout: "0.42 ETH\n" };
    const result = (await ledgerCommand.execute(
      makeCtx("balances ethereum-1"),
    )) as { kind: string; text: string };
    expect(result.kind).toBe("text");
    expect(lastSpawn?.args).toEqual([
      "balances",
      "ethereum-1",
      "--output",
      "human",
    ]);
    expect(result.text).toBe("0.42 ETH");
    expect(result.text).not.toContain("confirm on your Ledger");
  });

  test("flags device subcommands with an on-device confirmation note", async () => {
    nextResult = { code: 0, stdout: "broadcast tx 0xabc\n" };
    const result = (await ledgerCommand.execute(
      makeCtx("send ethereum-1 --to 0x123 --amount '0.01 ETH'"),
    )) as { kind: string; text: string };
    expect(result.kind).toBe("text");
    expect(result.text).toContain("confirm on your Ledger device");
    expect(result.text).toContain("broadcast tx 0xabc");
  });

  test("reports a clean error when wallet-cli is not installed", async () => {
    nextResult = { error: new Error("spawn wallet-cli ENOENT") };
    const result = (await ledgerCommand.execute(makeCtx("session"))) as {
      kind: string;
      message: string;
    };
    expect(result.kind).toBe("error");
    expect(result.message).toContain("wallet-cli not found");
    expect(result.message).toContain("@ledgerhq/wallet-cli");
  });

  test("surfaces wallet-cli failures with exit code and detail", async () => {
    nextResult = { code: 4, stderr: "Wrong app. Open Ledger dashboard." };
    const result = (await ledgerCommand.execute(makeCtx("genuine-check"))) as {
      kind: string;
      message: string;
    };
    expect(result.kind).toBe("error");
    expect(result.message).toContain("exit 4");
    expect(result.message).toContain("Open Ledger dashboard");
  });
});
