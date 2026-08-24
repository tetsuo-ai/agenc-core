/** Shared wire constants for the ChatGPT subscription backend. */

// branding-scan: allow factual reference to real provider in endpoint
export const CHATGPT_BACKEND_BASE_URL =
  "https://chatgpt.com/backend-api/codex";

/** Identify AgenC honestly rather than impersonating a first-party client. */
export const CHATGPT_BACKEND_ORIGINATOR = "agenc";

/** Version required by the backend's model-discovery endpoint. */
export const CHATGPT_MODELS_CLIENT_VERSION = "0.149.0";

export const CHATGPT_MODELS_PATH =
  `/models?client_version=` +
  encodeURIComponent(CHATGPT_MODELS_CLIENT_VERSION);

export const CHATGPT_MODELS_URL =
  `${CHATGPT_BACKEND_BASE_URL}${CHATGPT_MODELS_PATH}`;
