/**
 * Ports the donor shutdown-message semantics into non-UI AgenC lifecycle
 * summaries.
 *
 * Why this lives here:
 *   - The daemon shutdown path needs structured, renderer-neutral messages for
 *     tests and logs. React/Ink rendering is intentionally owned by the TUI.
 *
 * Cross-cuts deliberately NOT carried:
 *   - teammate mailbox rendering and swarm-specific request/approval parsing.
 */

import type { AgenCShutdownSignalEvent } from "./signal-handlers.js";

export function summarizeAgenCShutdown(event: AgenCShutdownSignalEvent): string {
  switch (event.signal) {
    case "SIGTERM":
      return "AgenC daemon received SIGTERM; running orderly shutdown";
    case "SIGINT":
      return "AgenC daemon received SIGINT; interrupting and shutting down";
    case "SIGHUP":
      return "AgenC daemon received SIGHUP; treating terminal loss as shutdown";
  }
}
