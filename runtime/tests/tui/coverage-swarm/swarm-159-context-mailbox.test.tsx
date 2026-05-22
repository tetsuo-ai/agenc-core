import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test } from "vitest";

import { MailboxProvider, useMailbox } from "src/tui/context/mailbox.js";
import { createRoot, Text } from "src/tui/ink.js";
import type { Mailbox } from "src/utils/mailbox.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TestStdout = PassThrough & {
  columns: number;
  isTTY: boolean;
  rows: number;
};

type MailboxSnapshot = {
  readonly label: string;
  readonly length: number;
  readonly mailbox: Mailbox;
  readonly revision: number;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: TestStdout;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough() as TestStdout;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  stdout.columns = 100;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

async function sleep(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 1_000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep();
    }
  }

  throw lastError;
}

async function withRoot(
  run: (root: Awaited<ReturnType<typeof createRoot>>) => Promise<void>,
): Promise<void> {
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  try {
    await run(root);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep();
  }
}

function MailboxProbe({
  label,
  snapshots,
}: {
  readonly label: string;
  readonly snapshots: MailboxSnapshot[];
}): React.ReactNode {
  const mailbox = useMailbox();

  React.useEffect(() => {
    snapshots.push({
      label,
      length: mailbox.length,
      mailbox,
      revision: mailbox.revision,
    });
  }, [label, mailbox, snapshots]);

  return <Text>{label}</Text>;
}

function OutsideMailboxProbe(): React.ReactNode {
  useMailbox();
  return <Text>outside</Text>;
}

describe("MailboxProvider coverage swarm row 159", () => {
  test("provides one reusable mailbox across cached and changed children", async () => {
    const snapshots: MailboxSnapshot[] = [];
    const stableChild = (
      <MailboxProbe label="first" snapshots={snapshots} />
    );

    await withRoot(async (root) => {
      root.render(<MailboxProvider>{stableChild}</MailboxProvider>);
      await waitFor(() => {
        expect(snapshots).toHaveLength(1);
      });

      const mailbox = snapshots[0]!.mailbox;
      mailbox.send({
        content: "queued for the next render",
        id: "message-159",
        source: "user",
        timestamp: "2026-05-20T00:00:00.000Z",
      });

      root.render(<MailboxProvider>{stableChild}</MailboxProvider>);
      await sleep();

      root.render(
        <MailboxProvider>
          <MailboxProbe label="second" snapshots={snapshots} />
        </MailboxProvider>,
      );
      await waitFor(() => {
        expect(snapshots).toHaveLength(2);
      });
    });

    expect(snapshots[0]).toMatchObject({
      label: "first",
      length: 0,
      revision: 0,
    });
    expect(snapshots[1]).toMatchObject({
      label: "second",
      length: 1,
      revision: 1,
    });
    expect(snapshots[1]!.mailbox).toBe(snapshots[0]!.mailbox);
    expect(snapshots[1]!.mailbox.poll()).toMatchObject({
      content: "queued for the next render",
      id: "message-159",
      source: "user",
    });
  });

  test("reports missing provider usage through the renderer error path", async () => {
    const { stdin, stdout } = createStreams();
    const stderr = new PassThrough();
    let stderrOutput = "";
    stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
    const root = await createRoot({
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<OutsideMailboxProbe />);
      await waitFor(() => {
        expect(stderrOutput).toContain(
          "useMailbox must be used within a MailboxProvider",
        );
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
      await sleep();
    }
  });
});
