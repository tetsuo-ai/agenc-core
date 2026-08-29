/**
 * Pure adapter from the canonical immutable config snapshot to the gateway's
 * execution shape. Persistent gateway policy is owned only by `[gateway]` in
 * schema-v2 config.toml; this module performs no file or environment reads.
 */

import type { AgenCConfig } from "../config/schema.js";
import {
  DEFAULT_GATEWAY_CONFIG,
  type GatewayConfig,
} from "./types.js";

export function gatewayConfigFromCanonical(
  config: Pick<AgenCConfig, "gateway">,
): GatewayConfig {
  const canonical = config.gateway;
  if (canonical === undefined) return DEFAULT_GATEWAY_CONFIG;

  const channels = Object.freeze(Object.fromEntries(
    Object.entries(canonical.channels ?? {}).map(([channelId, policy]) => [
      channelId,
      Object.freeze({
        dmPolicy: policy.dmPolicy,
        allowlist: Object.freeze([...(policy.allowlist ?? [])]),
      }),
    ]),
  ));
  const bindings = Object.freeze(
    (canonical.bindings ?? []).map((binding) => Object.freeze({ ...binding })),
  );
  const hooks = canonical.hooks === undefined
    ? undefined
    : Object.freeze({
        enabled: canonical.hooks.enabled === true,
        ...(canonical.hooks.host !== undefined
          ? { host: canonical.hooks.host }
          : {}),
        ...(canonical.hooks.port !== undefined
          ? { port: canonical.hooks.port }
          : {}),
        ...(canonical.hooks.allowNonLoopback === true
          ? { allowNonLoopback: true }
          : {}),
      });

  return Object.freeze({
    channels,
    bindings,
    defaultAgent: canonical.defaultAgent ?? DEFAULT_GATEWAY_CONFIG.defaultAgent,
    ...(hooks !== undefined ? { hooks } : {}),
  });
}
