// Shared per-connection wiring used by both transports (the loopback listener and the relay
// dialer): one PortalAdapter bound to one PortalGatewayClient. Keeps the translation logic in one
// place so the relay transport is purely about moving frames.

import { PortalAdapter } from "./portal-adapter.js";
import { PortalGatewayClient } from "./portal-gateway-client.js";
import type { JsonRpcNotification, JsonRpcResponse } from "./portal-protocol.js";

export interface PortalConnectionOptions {
  daemonUrl: string;
  sendToApp: (msg: JsonRpcResponse | JsonRpcNotification) => void;
  /** Called when the daemon socket drops, so the transport can close its app side. */
  onGatewayClose: () => void;
  /** True for the relay/remote transport — enables the adapter's remote scope gate. */
  isRemote?: boolean;
  logger?: (msg: string) => void;
}

export interface PortalConnection {
  handleAppMessage: (raw: string) => void;
  close: () => void;
}

export function createPortalConnection(opts: PortalConnectionOptions): PortalConnection {
  let adapter: PortalAdapter;
  const gateway = new PortalGatewayClient({
    daemonUrl: opts.daemonUrl,
    onMessage: (m) => adapter.handleGatewayMessage(m),
    onClose: () => {
      adapter.handleGatewayClose();
      opts.onGatewayClose();
    },
    onError: (e) => opts.logger?.(`[portal] gateway error: ${e.message}`),
  });
  adapter = new PortalAdapter({
    sendToApp: opts.sendToApp,
    sendToGateway: (env) => gateway.send(env),
    isRemote: opts.isRemote,
    logger: opts.logger,
  });
  return {
    handleAppMessage: (raw) => adapter.handleAppMessage(raw),
    close: () => gateway.close(),
  };
}
