/**
 * Sole owner of the system-prompt cache boundary literal.
 *
 * Keep this module dependency-free so prompt assembly and provider wire
 * adapters can share the exact marker without importing each other's graphs.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "<!-- dynamic-boundary -->";
