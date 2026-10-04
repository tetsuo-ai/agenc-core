import { RemoteApprovalProjection } from "./approvals.js";
import { RemoteError, type RemoteStatus } from "./types.js";
import type { RemoteService, RemoteServiceOptions } from "./service.js";

type Runtime = Pick<RemoteService, "handle" | "status" | "close">;
export type LazyRemoteService = Pick<RemoteService, "handle" | "status" | "observeSessionEvent"> & {
  close(): Promise<void>;
};

export function createLazyRemoteService(
  options: RemoteServiceOptions,
  load: (options: RemoteServiceOptions, approvals: RemoteApprovalProjection) => Promise<Runtime> = async (captured, approvals) => {
    const { RemoteService } = await import("./service.js");
    return new RemoteService(captured, approvals);
  },
): LazyRemoteService {
  const captured = { ...options };
  // Permission events can arrive before a remote client. Keep the original
  // bounded projection live and give the same object to the implementation.
  const approvals = new RemoteApprovalProjection();
  let pending: Promise<Runtime> | undefined;
  let current: Runtime | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const initialStatus = (): RemoteStatus => ({
    enabled: false, state: "stopped", connectedDevices: 0,
    devices: [], pairing: null, error: null,
  });
  return {
    observeSessionEvent: (sessionId, event) => approvals.observe(sessionId, event),
    status: () => current?.status() ?? initialStatus(),
    async handle(method, params) {
      if (closed) throw new RemoteError("REMOTE_OPERATION_CANCELLED");
      const service = await (pending ??= load(captured, approvals).then(value => {
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
