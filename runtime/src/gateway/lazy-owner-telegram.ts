import { RemoteError } from "../remote/types.js";
import type { OwnerTelegramService, OwnerTelegramOptions } from "./owner-telegram.js";
import type { OwnerTelegramBinding, TelegramAgentRecord } from "./owner-telegram-types.js";

export interface OwnerTelegramStartupState {
  readonly binding: OwnerTelegramBinding | null;
  readonly records: readonly TelegramAgentRecord[];
}

type Runtime = Pick<OwnerTelegramService, "handle" | "observeSessionEvent" | "close">;
export type LazyOwnerTelegramService = Pick<Runtime, "handle" | "observeSessionEvent"> & {
  close(): Promise<void>;
};

export function createLazyOwnerTelegramService(
  options: OwnerTelegramOptions,
  load: (options: OwnerTelegramOptions, startup: OwnerTelegramStartupState) => Promise<Runtime> = async (captured, startup) => {
    const { OwnerTelegramService } = await import("./owner-telegram.js");
    return new OwnerTelegramService(captured, startup);
  },
): LazyOwnerTelegramService {
  const captured = { ...options };
  // Preserve the startup reads, their order and malformed-metadata failure
  // policy. Only the transport/service code waits for an actual Telegram RPC.
  const startup = {
    binding: options.storage.load(),
    records: options.storage.agents?.load() ?? [],
  };
  let pending: Promise<Runtime> | undefined;
  let current: Runtime | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    // Before any RPC all runtimes are stopped, so the original observer is a
    // no-op. Forward events as soon as the implementation exists.
    observeSessionEvent: (sessionId, event) => current?.observeSessionEvent(sessionId, event),
    async handle(method, params) {
      if (closed) throw new RemoteError("REMOTE_OPERATION_CANCELLED");
      const service = await (pending ??= load(captured, startup).then(value => {
        current = value;
        return value;
      }));
      if (closed) throw new RemoteError("REMOTE_OPERATION_CANCELLED");
      return service.handle(method, params);
    },
    close() {
      closed = true;
      if (closing !== undefined) return closing;
      if (current !== undefined) {
        current.close();
        return closing = Promise.resolve();
      }
      return closing = pending === undefined
        ? Promise.resolve()
        : pending.then(service => service.close());
    },
  };
}
