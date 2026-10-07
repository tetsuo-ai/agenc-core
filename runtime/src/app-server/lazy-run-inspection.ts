import type { AgenCDaemonRunInspectionService, AgenCDaemonRunInspectionOptions } from "./run-inspection.js";

type Method = "status" | "result" | "replay" | "evidence";
export type AgenCDaemonRunInspectionHandlers = {
  [K in Method]: (
    params: Parameters<AgenCDaemonRunInspectionService[K]>[0],
    signal?: AbortSignal,
  ) => ReturnType<AgenCDaemonRunInspectionService[K]> | Promise<ReturnType<AgenCDaemonRunInspectionService[K]>>;
};

export function createLazyRunInspection(
  options: AgenCDaemonRunInspectionOptions,
): AgenCDaemonRunInspectionHandlers {
  const captured = { ...options };
  let pending: Promise<AgenCDaemonRunInspectionService> | undefined;
  const get = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const service = await (pending ??= import("./run-inspection.js").then(
      ({ AgenCDaemonRunInspectionService }) => new AgenCDaemonRunInspectionService(captured),
    ));
    // Loading may yield across daemon shutdown or request cancellation.
    signal?.throwIfAborted();
    return service;
  };
  return {
    status: async (params, signal) => (await get(signal)).status(params),
    result: async (params, signal) => (await get(signal)).result(params),
    replay: async (params, signal) => (await get(signal)).replay(params),
    evidence: async (params, signal) => (await get(signal)).evidence(params),
  };
}
