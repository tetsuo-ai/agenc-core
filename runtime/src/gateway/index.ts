/**
 * Gateway barrel — lean rebuild.
 *
 * Stripped of every daemon/WebSocket/channel/autonomy export from the
 * pre-gut barrel. The next tranches will rewrite most of these files
 * into a thin query-loop adapter; for now this barrel is intentionally
 * empty. Consumers should import from individual modules directly.
 */

export {};
