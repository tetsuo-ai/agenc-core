import {
  CHANNEL_ADAPTER_HOST_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_API_VERSION,
} from "@tetsuo-ai/plugin-kit";

import type { GatewayConnectorAbiStatus } from "./types.js";

export const AGENC_CONNECTOR_PLUGIN_API_VERSION =
  CHANNEL_ADAPTER_PLUGIN_API_VERSION;
export const AGENC_CONNECTOR_HOST_API_VERSION =
  CHANNEL_ADAPTER_HOST_API_VERSION;

export function buildGatewayConnectorAbiStatus(): GatewayConnectorAbiStatus {
  return {
    plugin_api_version: AGENC_CONNECTOR_PLUGIN_API_VERSION,
    host_api_version: AGENC_CONNECTOR_HOST_API_VERSION,
  };
}
