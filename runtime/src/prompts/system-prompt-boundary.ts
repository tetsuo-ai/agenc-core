/**
 * Sole owner of the system-prompt cache boundary literals.
 *
 * Keep this module dependency-free so prompt assembly and provider wire
 * adapters can share the exact markers without importing each other's graphs.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "<!-- dynamic-boundary -->";

/**
 * Separates the part of the dynamic tail that is fixed for the session
 * (environment, memory directories, client rendering) from the part that can
 * change between requests (the permission section, per-turn guidance). Only
 * present when session-tail caching is on; wires that honour it place the
 * session part right after the static head, inside the cached prefix, and
 * keep the volatile part at the end of the request.
 */
export const SYSTEM_PROMPT_VOLATILE_BOUNDARY = "<!-- volatile-boundary -->";
