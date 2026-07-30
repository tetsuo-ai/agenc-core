import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ledgerCommand,
  parseLedgerArguments,
} from "../../src/commands/ledger.js";
import {
  getLedgerVerificationSnapshot,
  resetLedgerVerificationForTests,
} from "../../src/services/Ledger/ledgerVerification.js";

type FakeResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly error?: Error;
  readonly neverClose?: boolean;
};

let lastSpawn: {
  cmd: string;
  args: readonly string[];
  options: { readonly stdio?: readonly unknown[] };
} | null = null;

const walletCliServiceState = vi.hoisted(() => ({
  executable: "wallet-cli" as string | null,
  installResult: {
    installed: true as const,
    executable: "/home/test/.agenc/tools/wallet-cli/versions/2.0.1/bin/wallet-cli",
    version: "2.0.1",
    platformPackage: "@ledgerhq/wallet-cli-linux-x64",
    package: "@ledgerhq/wallet-cli" as const,
    alreadyCurrent: false,
  },
}));

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
  spawn: vi.fn(
    (
      cmd: string,
      args: readonly string[],
      options: { readonly stdio?: readonly unknown[] },
    ) => {
      lastSpawn = { cmd, args, options };
      return fakeChild(nextResult);
    },
  ),
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

vi.mock("../../src/services/Ledger/walletCli.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/Ledger/walletCli.js")>();
  return {
    ...actual,
    resolveWalletCliExecutable: vi.fn(async () =>
      walletCliServiceState.executable === null
        ? null
        : {
            path: walletCliServiceState.executable,
            source: "path" as const,
          },
    ),
    getWalletCliStatus: vi.fn(async () =>
      walletCliServiceState.executable === null
        ? {
            installed: false,
            executable: null,
            source: null,
            version: null,
            installTool: "install_ledger_wallet_cli",
            package: "@ledgerhq/wallet-cli",
          }
        : {
            installed: true,
            executable: walletCliServiceState.executable,
            source: "path",
            version: null,
            installTool: "install_ledger_wallet_cli",
            package: "@ledgerhq/wallet-cli",
          },
    ),
    installLatestWalletCli: vi.fn(
      async () => walletCliServiceState.installResult,
    ),
  };
});

function makeCtx(argsRaw: string, tui = false) {
  return {
    argsRaw,
    cwd: "/tmp",
    home: "/home/test",
    agencHome: "/home/test/.agenc",
    ...(tui ? { appState: {} } : {}),
  } as never;
}

afterEach(() => {
  lastSpawn = null;
  nextResult = { code: 0, stdout: "" };
  walletCliServiceState.executable = "wallet-cli";
  walletCliServiceState.installResult = {
    installed: true,
    executable:
      "/home/test/.agenc/tools/wallet-cli/versions/2.0.1/bin/wallet-cli",
    version: "2.0.1",
    platformPackage: "@ledgerhq/wallet-cli-linux-x64",
    package: "@ledgerhq/wallet-cli",
    alreadyCurrent: false,
  };
  resetLedgerVerificationForTests();
});

describe("/ledger command", () => {
  test("parses quoted wallet-cli arguments without a shell", () => {
    expect(
      parseLedgerArguments(
        "send ethereum-1 --to 0x123 --amount '0.01 ETH' --memo \"rent payment\"",
      ),
    ).toEqual({
      ok: true,
      args: [
        "send",
        "ethereum-1",
        "--to",
        "0x123",
        "--amount",
        "0.01 ETH",
        "--memo",
        "rent payment",
      ],
    });
    expect(parseLedgerArguments("send 'unfinished")).toEqual({
      ok: false,
      error: "Ledger arguments contain an unclosed ' quote.",
    });
    expect(
      parseLedgerArguments(String.raw`ring decrypt -i C:\Users\paul\data.enc`),
    ).toEqual({
      ok: true,
      args: [
        "ring",
        "decrypt",
        "-i",
        String.raw`C:\Users\paul\data.enc`,
      ],
    });
  });

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
    expect(result.text).toContain("/ledger help");
  });

  test("normalizes the friendly session and discover aliases", async () => {
    nextResult = { code: 0, stdout: "ethereum-1\n" };
    await ledgerCommand.execute(makeCtx("session"));
    expect(lastSpawn?.args).toEqual([
      "session",
      "view",
      "--output",
      "human",
    ]);

    await ledgerCommand.execute(makeCtx("discover ethereum"));
    expect(lastSpawn?.args).toEqual([
      "account",
      "discover",
      "ethereum",
      "--output",
      "human",
    ]);
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
    expect(lastSpawn?.args).toEqual([
      "send",
      "ethereum-1",
      "--to",
      "0x123",
      "--amount",
      "0.01 ETH",
      "--output",
      "human",
    ]);
  });

  test("keeps genuine-check output inside the TUI popup", async () => {
    nextResult = {
      code: 0,
      stdout: "The connected Ledger device is genuine.\n",
    };

    const result = await ledgerCommand.execute(
      makeCtx("genuine-check", true),
    );

    expect(result).toEqual({ kind: "skip" });
    expect(getLedgerVerificationSnapshot()).toMatchObject({
      phase: "verified",
    });
  });

  test("does not verify ambiguous successful genuine-check output", async () => {
    nextResult = {
      code: 0,
      stdout: "Command completed successfully.\n",
    };

    const result = await ledgerCommand.execute(
      makeCtx("genuine-check", true),
    );

    expect(result).toEqual({ kind: "skip" });
    expect(getLedgerVerificationSnapshot()).toMatchObject({
      phase: "failed",
      detail:
        "Wallet CLI completed without an explicit genuine-device confirmation.",
    });
  });

  test("treats dry-run and unverified receive as non-device commands", async () => {
    nextResult = { code: 0, stdout: "validated\n" };
    const dryRun = (await ledgerCommand.execute(
      makeCtx(
        "send ethereum-1 --to 0x123 --amount '0.01 ETH' --dry-run",
      ),
    )) as { kind: string; text: string };
    expect(dryRun.text).toBe("validated");
    expect(dryRun.text).not.toContain("confirm on your Ledger");

    const receive = (await ledgerCommand.execute(
      makeCtx("receive ethereum-1 --no-verify"),
    )) as { kind: string; text: string };
    expect(receive.text).not.toContain("confirm on your Ledger");
  });

  test("reports the explicit managed install flow when wallet-cli is missing", async () => {
    walletCliServiceState.executable = null;
    const result = (await ledgerCommand.execute(makeCtx("session"))) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(result.text).toContain("not installed");
    expect(result.text).toContain("Nothing has been downloaded");
    expect(result.text).toContain("/ledger install");
    expect(result.text).toContain("@ledgerhq/wallet-cli");
    expect(lastSpawn).toBeNull();
  });

  test("shows built-in help even when wallet-cli is missing", async () => {
    walletCliServiceState.executable = null;
    const result = (await ledgerCommand.execute(makeCtx("help"))) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(result.text).toContain("/ledger status");
    expect(result.text).toContain("/ledger discover");
    expect(result.text).toContain("--dry-run");
    expect(lastSpawn).toBeNull();
  });

  test("reports install and passive USB status", async () => {
    walletCliServiceState.executable = null;
    const result = (await ledgerCommand.execute(makeCtx("status"))) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(result.text).toContain("LEDGER STATUS");
    expect(result.text).toContain("CLI      not installed");
    expect(result.text).toContain("DEVICE   not detected on USB");
    expect(result.text).toContain("/ledger install");
    expect(lastSpawn).toBeNull();
  });

  test("/ledger install installs the registry latest in managed storage", async () => {
    const result = (await ledgerCommand.execute(makeCtx("install"))) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(result.text).toContain("Installed Ledger Wallet CLI 2.0.1");
    expect(result.text).toContain(
      "/home/test/.agenc/tools/wallet-cli/versions/2.0.1/bin/wallet-cli",
    );
    expect(lastSpawn).toBeNull();
  });

  test("preserves an explicit JSON output format", async () => {
    nextResult = { code: 0, stdout: "{\"ok\":true}\n" };
    await ledgerCommand.execute(
      makeCtx("balances ethereum-1 --output json"),
    );
    expect(lastSpawn?.args).toEqual([
      "balances",
      "ethereum-1",
      "--output",
      "json",
    ]);
  });

  test("renders wallet-cli JSON help as readable text", async () => {
    nextResult = {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        data: {
          type: "help",
          text: "Usage: wallet-cli send [options]",
        },
      }),
    };
    const result = (await ledgerCommand.execute(makeCtx("help send"))) as {
      kind: string;
      text: string;
    };
    expect(lastSpawn?.args).toEqual([
      "send",
      "--help",
      "--output",
      "human",
    ]);
    expect(result.text).toBe("Usage: wallet-cli send [options]");
  });

  test("keeps decrypted payloads out of the transcript", async () => {
    const blocked = (await ledgerCommand.execute(
      makeCtx("ring decrypt --key project -i secrets.enc"),
    )) as { kind: string; message: string };
    expect(blocked.kind).toBe("error");
    expect(blocked.message).toContain("--out <file>");
    expect(lastSpawn).toBeNull();

    nextResult = { code: 0, stdout: "do-not-render-this-secret\n" };
    const result = (await ledgerCommand.execute(
      makeCtx(
        "ring decrypt --key project -i secrets.enc -o secrets.env",
      ),
    )) as { kind: string; text: string };
    expect(result.kind).toBe("text");
    expect(result.text).toBe(
      "Decrypted output written to the requested file.",
    );
    expect(result.text).not.toContain("do-not-render");
    expect(lastSpawn?.options.stdio?.[1]).toBe("ignore");
  });

  test("rejects unknown Ledger actions instead of passing them through", async () => {
    const result = (await ledgerCommand.execute(
      makeCtx("not-a-command"),
    )) as { kind: string; message: string };
    expect(result.kind).toBe("error");
    expect(result.message).toContain("Unknown Ledger command");
    expect(lastSpawn).toBeNull();
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
