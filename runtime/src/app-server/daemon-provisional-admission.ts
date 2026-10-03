/**
 * Early-start protocol foundation, wired only by the exploratory variant.
 * This module itself does not acquire ownership, spawn, recover state or admit clients.
 * A JS lease cannot stop synchronous initialization; activation additionally
 * requires the native lifetime and side-effect proofs in the reviewed design.
 */
import type { ChildProcess } from "node:child_process";
import {
  isAgenCDaemonStartupGuardToken,
  type AgenCDaemonStartupGuardChannel,
} from "./daemon-startup-guard.js";

export const AGENC_DAEMON_PROVISIONAL_ENV = "AGENC_DAEMON_PROVISIONAL_START";

const ADMISSION_MESSAGE = "agenc.daemon.provisional.admission";

export type AgenCProvisionalDecision =
  | { readonly kind: "admitted" }
  | {
      readonly kind: "aborted";
      readonly reason: "parent-abort" | "disconnected" | "lease-expired" | "closed";
    };

export interface AgenCProvisionalChannel extends AgenCDaemonStartupGuardChannel {
  /** Must inspect current state, including disconnect before listener setup. */
  isConnected(): boolean;
}

function assertToken(token: string): void {
  if (!isAgenCDaemonStartupGuardToken(token)) {
    throw new TypeError("invalid provisional daemon capability");
  }
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError("invalid provisional daemon timeout");
  }
}

export function agenCProvisionalAdmissionMessage(
  token: string,
  action: "admit" | "abort",
): Readonly<{ type: string; version: 1; token: string; action: "admit" | "abort" }> {
  assertToken(token);
  if (action !== "admit" && action !== "abort") {
    throw new TypeError("invalid provisional daemon action");
  }
  return Object.freeze({ type: ADMISSION_MESSAGE, version: 1, token, action });
}

/** Install before importing any potentially effectful foreground module. */
export function createAgenCProvisionalAdmissionReceiver(
  token: string,
  channel: AgenCProvisionalChannel,
  leaseMs: number,
): {
  readonly decision: Promise<AgenCProvisionalDecision>;
  current(): AgenCProvisionalDecision | null;
  abort(): void;
  close(): void;
} {
  assertToken(token);
  assertTimeout(leaseMs);
  const deadline = performance.now() + leaseMs;
  let current: AgenCProvisionalDecision | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDecision!: (decision: AgenCProvisionalDecision) => void;
  const decision = new Promise<AgenCProvisionalDecision>((resolve) => {
    resolveDecision = resolve;
  });
  const detach = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    channel.removeMessageListener(onMessage);
    channel.removeCloseListener(onClose);
  };
  const settle = (next: AgenCProvisionalDecision): void => {
    if (current !== null) return;
    current = Object.freeze(next);
    detach();
    resolveDecision(current);
  };
  const onClose = (): void => settle({ kind: "aborted", reason: "disconnected" });
  const onMessage = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.type !== ADMISSION_MESSAGE || message.version !== 1 || message.token !== token) return;
    if (!channel.isConnected()) { onClose(); return; }
    // An IPC callback can run before an overdue timer after synchronous work.
    // Callback order must not extend the admission authority's lifetime.
    if (performance.now() >= deadline) {
      settle({ kind: "aborted", reason: "lease-expired" });
      return;
    }
    if (message.action === "admit") settle({ kind: "admitted" });
    else if (message.action === "abort") settle({ kind: "aborted", reason: "parent-abort" });
  };
  channel.addMessageListener(onMessage);
  channel.addCloseListener(onClose);
  // The close event may have happened before installation. Never treat that
  // case as a fresh lease, or a lost parent could leave a provisional owner.
  if (!channel.isConnected()) onClose();
  if (current === null) {
    // Keep this timer referenced while pending. It is not a readiness hint or
    // evidence that synchronous work can be interrupted by a JS timer.
    timer = setTimeout(() => settle({ kind: "aborted", reason: "lease-expired" }), leaseMs);
  }
  return {
    decision,
    current: () => current,
    abort: () => settle({ kind: "aborted", reason: "parent-abort" }),
    close: () => {
      settle({ kind: "aborted", reason: "closed" });
      detach();
      channel.close();
    },
  };
}

export interface AgenCSpawnedChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Bind immediately after canonical spawn, before awaiting PID publication.
 * Only this ChildProcess's exit event/state is evidence; no PID polling or
 * signalling is performed. A cleanup acknowledgement alone never resolves it.
 */
export function observeAgenCSpawnedChildExit(child: ChildProcess): {
  waitForExit(timeoutMs: number): Promise<AgenCSpawnedChildExit>;
  cancelAndWaitForExit(
    requestCleanup: () => Promise<void>,
    timeoutMs: number,
  ): Promise<AgenCSpawnedChildExit>;
} {
  let resolveExit!: (exit: AgenCSpawnedChildExit) => void;
  let rejectExit!: (error: Error) => void;
  let settled = false;
  const exited = new Promise<AgenCSpawnedChildExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const detach = (): void => {
    child.off("exit", onExit);
    child.off("error", onError);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    detach();
    resolveExit(Object.freeze({ code, signal }));
  };
  const onError = (error: Error): void => {
    // Runtime errors such as a failed IPC send do not establish process exit.
    if (child.pid !== undefined || settled) return;
    settled = true;
    detach();
    rejectExit(error);
  };
  child.on("exit", onExit);
  child.on("error", onError);
  if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  // A failed spawn can precede the caller's first wait. Preserve the rejected
  // result without producing an unhandled rejection in that interval.
  void exited.catch(() => {});

  const bounded = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
    assertTimeout(timeoutMs);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("exact spawned child cleanup/exit was not verified before timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
  return {
    waitForExit: (timeoutMs) => bounded(exited, timeoutMs),
    cancelAndWaitForExit: async (requestCleanup, timeoutMs) => {
      assertTimeout(timeoutMs);
      // Observe exit concurrently with cleanup: the exact child can exit
      // before the acknowledgement reaches the parent. Both must succeed.
      const [, exit] = await bounded(Promise.all([
        Promise.resolve().then(requestCleanup), exited,
      ]), timeoutMs);
      return exit;
    },
  };
}
