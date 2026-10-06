import { TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START } from "./realtime-admission.js";
import { defaultRealtimeFetch } from "./realtime-default-fetch.js";
import type { AgenCRealtimeRpcHandlers, AgenCRealtimeRpcServiceOptions } from "./realtime.js";
import type {
  AgenCRealtimeCallClient,
  AgenCRealtimeCallClientLike,
  AgenCRealtimeCallClientOptions,
  AgenCRealtimeWebSocketTransportConnector,
} from "./realtime-transport.js";

export function createLazyRealtimeRpcService(
  options: AgenCRealtimeRpcServiceOptions = {},
): AgenCRealtimeRpcHandlers {
  const captured = { ...options };
  let pending: Promise<AgenCRealtimeRpcHandlers> | undefined;
  const get = () => pending ??= import("./realtime.js").then(
    ({ AgenCRealtimeRpcService }) => new AgenCRealtimeRpcService(captured),
  );
  return {
    startEnabled: options.unadmittedStartOverride === TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
    start: async (params, context) => (await get()).start(params, context),
    appendAudio: async params => (await get()).appendAudio(params),
    appendText: async params => (await get()).appendText(params),
    stop: async params => (await get()).stop(params),
    listVoices: async params => (await get()).listVoices(params),
  };
}

export function createLazyRealtimeTransports(options: AgenCRealtimeCallClientOptions): {
  readonly callClient: AgenCRealtimeCallClientLike;
  readonly connect: AgenCRealtimeWebSocketTransportConnector["connect"];
} {
  // Preserve the constructor's host fetch capture and immediate unavailable
  // error. Headers remain the original live provider callback across reload.
  const captured = { ...options, fetch: options.fetch ?? defaultRealtimeFetch() };
  let calls: Promise<AgenCRealtimeCallClient> | undefined;
  let sockets: Promise<AgenCRealtimeWebSocketTransportConnector> | undefined;
  const getCalls = () => calls ??= import("./realtime-transport.js").then(
    ({ AgenCRealtimeCallClient }) => new AgenCRealtimeCallClient(captured),
  );
  const getSockets = () => sockets ??= import("./realtime-transport.js").then(
    ({ AgenCRealtimeWebSocketTransportConnector }) => new AgenCRealtimeWebSocketTransportConnector(captured),
  );
  return {
    callClient: {
      create: async (...args) => (await getCalls()).create(...args),
      createWithSession: async (...args) => (await getCalls()).createWithSession(...args),
    },
    connect: async request => (await getSockets()).connect(request),
  };
}
