// In-container paths shared by the agent-run lanes and the egress
// orchestration. The overlay is bind-mounted read-only at
// OVERLAY_CONTAINER_PATH; the helper dir is agent scratch outside the repo.

export const OVERLAY_CONTAINER_PATH = "/agenc-overlay";
export const AGENT_HELPER_DIR = "/agenc-eval";
export const AGENT_HOME = `${AGENT_HELPER_DIR}/agent-home`;

export const OVERLAY_AGENT_ENTRY_SUBPATH =
  "runtime/node_modules/@tetsuo-ai/runtime/dist/bin/agenc.js";
export const AGENT_RUNTIME_ENTRY = `${OVERLAY_CONTAINER_PATH}/${OVERLAY_AGENT_ENTRY_SUBPATH}`;
export const OVERLAY_NODE = `${OVERLAY_CONTAINER_PATH}/node/bin/node`;
export const OVERLAY_PROXY_ENTRY = `${OVERLAY_CONTAINER_PATH}/proxy/allowlist-proxy.mjs`;
export const OVERLAY_PROBE_ENTRY = `${OVERLAY_CONTAINER_PATH}/proxy/eval-egress-probe.mjs`;
