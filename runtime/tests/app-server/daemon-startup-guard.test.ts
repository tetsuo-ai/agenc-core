import { describe, expect, it } from "vitest";

import {
  AGENC_DAEMON_STARTUP_GUARD_ENV,
  createAgenCDaemonStartupGuardController,
  createAgenCDaemonStartupGuardReceiver,
  isAgenCDaemonStartupGuardToken,
  takeAgenCDaemonStartupGuardToken,
  type AgenCDaemonStartupGuardChannel,
} from "./daemon-startup-guard.js";

class TestGuardChannel implements AgenCDaemonStartupGuardChannel {
  peer: TestGuardChannel | null = null;
  readonly messages = new Set<(message: unknown) => void>();
  readonly closes = new Set<() => void>();
  closed = false;
  unrefCount = 0;

  addMessageListener(listener: (message: unknown) => void): void {
    this.messages.add(listener);
  }

  removeMessageListener(listener: (message: unknown) => void): void {
    this.messages.delete(listener);
  }

  addCloseListener(listener: () => void): void {
    this.closes.add(listener);
  }

  removeCloseListener(listener: () => void): void {
    this.closes.delete(listener);
  }

  async send(message: unknown): Promise<void> {
    if (this.closed || this.peer === null || this.peer.closed) {
      throw new Error("test startup guard channel is closed");
    }
    await Promise.resolve();
    for (const listener of [...this.peer.messages]) listener(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    if (peer !== null && !peer.closed) {
      peer.closed = true;
      for (const listener of [...peer.closes]) listener();
    }
    for (const listener of [...this.closes]) listener();
  }

  unref(): void {
    this.unrefCount += 1;
  }
}

function channelPair(): readonly [TestGuardChannel, TestGuardChannel] {
  const parent = new TestGuardChannel();
  const child = new TestGuardChannel();
  parent.peer = child;
  child.peer = parent;
  return [parent, child];
}

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

describe("daemon startup cancellation guard", () => {
  it("owns the startup capability token bounds", () => {
    expect(isAgenCDaemonStartupGuardToken("a".repeat(31))).toBe(false);
    expect(isAgenCDaemonStartupGuardToken("a".repeat(32))).toBe(true);
    expect(isAgenCDaemonStartupGuardToken("a".repeat(1_024))).toBe(true);
    expect(isAgenCDaemonStartupGuardToken("a".repeat(1_025))).toBe(false);
    expect(isAgenCDaemonStartupGuardToken(undefined)).toBe(false);
  });

  it("acknowledges exact-child cancellation only after cleanup", async () => {
    const [parentChannel, childChannel] = channelPair();
    const parent = createAgenCDaemonStartupGuardController(
      TOKEN_A,
      parentChannel,
    );
    const child = createAgenCDaemonStartupGuardReceiver(TOKEN_A, childChannel);

    const cancelled = parent.requestCancellation(1_000);
    await child.requested;
    let parentSettled = false;
    void cancelled.finally(() => {
      parentSettled = true;
    });
    await Promise.resolve();
    expect(parentSettled).toBe(false);

    await child.acknowledgeAfterCleanup(true);
    await expect(cancelled).resolves.toBeUndefined();
    expect(parentChannel.closed).toBe(true);
    expect(childChannel.closed).toBe(true);
    expect(parentChannel.unrefCount).toBe(1);
    expect(childChannel.unrefCount).toBe(1);
  });

  it("ignores the wrong capability token and times out closed", async () => {
    const [parentChannel, childChannel] = channelPair();
    const parent = createAgenCDaemonStartupGuardController(
      TOKEN_A,
      parentChannel,
    );
    const child = createAgenCDaemonStartupGuardReceiver(TOKEN_B, childChannel);

    await expect(parent.requestCancellation(10)).rejects.toThrow(
      /did not acknowledge/u,
    );
    expect(child.wasRequested()).toBe(false);
    child.close();
  });

  it("treats channel close without acknowledgement as a hard failure", async () => {
    const [parentChannel, childChannel] = channelPair();
    const parent = createAgenCDaemonStartupGuardController(
      TOKEN_A,
      parentChannel,
    );
    const child = createAgenCDaemonStartupGuardReceiver(TOKEN_A, childChannel);

    const cancelled = parent.requestCancellation(1_000);
    await child.requested;
    child.close();
    await expect(cancelled).rejects.toThrow(/closed without.*acknowledgement/u);
  });

  it("does not deliver one daemon's cancellation to an unrelated child", async () => {
    const [parentAChannel, childAChannel] = channelPair();
    const [parentBChannel, childBChannel] = channelPair();
    const parentA = createAgenCDaemonStartupGuardController(
      TOKEN_A,
      parentAChannel,
    );
    const childA = createAgenCDaemonStartupGuardReceiver(
      TOKEN_A,
      childAChannel,
    );
    const parentB = createAgenCDaemonStartupGuardController(
      TOKEN_B,
      parentBChannel,
    );
    const childB = createAgenCDaemonStartupGuardReceiver(
      TOKEN_B,
      childBChannel,
    );

    const cancelledA = parentA.requestCancellation(1_000);
    await childA.requested;
    expect(childB.wasRequested()).toBe(false);
    await childA.acknowledgeAfterCleanup(true);
    await cancelledA;

    parentB.close();
    childB.close();
  });

  it("unrefs and closes both ends on the successful no-cancellation path", () => {
    const [parentChannel, childChannel] = channelPair();
    const parent = createAgenCDaemonStartupGuardController(
      TOKEN_A,
      parentChannel,
    );
    const child = createAgenCDaemonStartupGuardReceiver(TOKEN_A, childChannel);

    expect(parentChannel.unrefCount).toBe(1);
    expect(childChannel.unrefCount).toBe(1);
    parent.close();
    child.close();
    expect(parentChannel.closed).toBe(true);
    expect(childChannel.closed).toBe(true);
    expect(child.wasRequested()).toBe(false);
    expect(childChannel.messages.size).toBe(0);
    expect(childChannel.closes.size).toBe(0);
  });

  it("scrubs the one-shot capability from the daemon runtime environment", () => {
    const env = { [AGENC_DAEMON_STARTUP_GUARD_ENV]: TOKEN_A };
    expect(takeAgenCDaemonStartupGuardToken(env)).toBe(TOKEN_A);
    expect(env[AGENC_DAEMON_STARTUP_GUARD_ENV]).toBeUndefined();
  });
});
