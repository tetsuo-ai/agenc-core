export const OPENROUTER_FREE_MODEL_IDS = Object.freeze([
  // OpenRouter free routes are shared provider pools. With one hosted AgenC
  // key they return upstream 429s under normal use, so do not expose them as
  // subscription-managed routes until we support per-user BYOK/OAuth routing
  // or a dedicated quota pool.
] as const);
