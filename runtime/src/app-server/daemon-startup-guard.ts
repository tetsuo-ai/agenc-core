export const AGENC_DAEMON_STARTUP_GUARD_ENV =
  "AGENC_DAEMON_STARTUP_GUARD_TOKEN";

const STARTUP_GUARD_CANCEL = "agenc.daemon.startup.cancel";
const STARTUP_GUARD_CANCELLED = "agenc.daemon.startup.cancelled";

export interface AgenCDaemonStartupGuardChannel {
  addMessageListener(listener: (message: unknown) => void): void;
  removeMessageListener(listener: (message: unknown) => void): void;
  addCloseListener(listener: () => void): void;
  removeCloseListener(listener: () => void): void;
  send(message: unknown): Promise<void>;
  close(): void;
  unref(): void;
}

export interface AgenCDaemonStartupGuardReceiver {
  readonly requested: Promise<void>;
  wasRequested(): boolean;
  acknowledgeAfterCleanup(cleanupOk: boolean): Promise<void>;
  close(): void;
}

export interface AgenCDaemonStartupGuardController {
  requestCancellation(timeoutMs: number): Promise<void>;
  close(): void;
}

/** Capture and scrub the one-shot child capability before services spawn. */
export function takeAgenCDaemonStartupGuardToken(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const token = env[AGENC_DAEMON_STARTUP_GUARD_ENV];
  delete env[AGENC_DAEMON_STARTUP_GUARD_ENV];
  return token;
}

export function createAgenCDaemonStartupGuardReceiver(
  token: string,
  channel: AgenCDaemonStartupGuardChannel,
): AgenCDaemonStartupGuardReceiver {
  assertStartupGuardToken(token);
  let requested = false;
  let closed = false;
  let resolveRequested!: () => void;
  const requestedPromise = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });
  const onMessage = (message: unknown): void => {
    if (!isStartupGuardMessage(message, STARTUP_GUARD_CANCEL, token)) return;
    if (requested) return;
    requested = true;
    resolveRequested();
  };
  const onClose = (): void => close();
  const close = (): void => {
    if (closed) return;
    closed = true;
    channel.removeMessageListener(onMessage);
    channel.removeCloseListener(onClose);
    channel.close();
  };
  channel.addMessageListener(onMessage);
  channel.addCloseListener(onClose);
  channel.unref();
  return {
    requested: requestedPromise,
    wasRequested: () => requested,
    acknowledgeAfterCleanup: async (cleanupOk) => {
      if (!requested || closed) {
        close();
        return;
      }
      try {
        await channel.send({
          type: STARTUP_GUARD_CANCELLED,
          token,
          cleanupOk,
        });
      } finally {
        close();
      }
    },
    close,
  };
}

export function createAgenCDaemonStartupGuardController(
  token: string,
  channel: AgenCDaemonStartupGuardChannel,
): AgenCDaemonStartupGuardController {
  assertStartupGuardToken(token);
  let closed = false;
  let cancellation: Promise<void> | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    channel.close();
  };
  channel.unref();
  return {
    requestCancellation: (timeoutMs) => {
      if (cancellation !== null) return cancellation;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(
          new TypeError("daemon startup cancellation timeout is invalid"),
        );
      }
      cancellation = new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          channel.removeMessageListener(onMessage);
          channel.removeCloseListener(onClose);
          close();
          if (error === undefined) resolve();
          else reject(error);
        };
        const onMessage = (message: unknown): void => {
          if (!isStartupGuardMessage(message, STARTUP_GUARD_CANCELLED, token)) {
            return;
          }
          const cleanupOk = (message as { readonly cleanupOk?: unknown })
            .cleanupOk;
          finish(
            cleanupOk === true
              ? undefined
              : new Error(
                  "spawned daemon acknowledged cancellation with cleanup failures",
                ),
          );
        };
        const onClose = (): void => {
          finish(
            new Error(
              "spawned daemon startup guard closed without a cleanup acknowledgement",
            ),
          );
        };
        timer = setTimeout(() => {
          finish(
            new Error(
              "spawned daemon did not acknowledge startup cancellation before timeout",
            ),
          );
        }, timeoutMs);
        channel.addMessageListener(onMessage);
        channel.addCloseListener(onClose);
        channel.send({ type: STARTUP_GUARD_CANCEL, token }).catch((error) => {
          finish(
            error instanceof Error
              ? error
              : new Error("failed to send daemon startup cancellation"),
          );
        });
      });
      return cancellation;
    },
    close,
  };
}

/** Shared validity contract for the one-shot startup capability token. */
export function isAgenCDaemonStartupGuardToken(
  token: unknown,
): token is string {
  return typeof token === "string" && token.length >= 32 && token.length <= 1_024;
}

function assertStartupGuardToken(token: string): void {
  if (!isAgenCDaemonStartupGuardToken(token)) {
    throw new TypeError("daemon startup guard token is invalid");
  }
}

function isStartupGuardMessage(
  value: unknown,
  type: string,
  token: string,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as {
    readonly type?: unknown;
    readonly token?: unknown;
  };
  return message.type === type && message.token === token;
}
