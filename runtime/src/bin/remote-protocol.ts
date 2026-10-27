/**
 * Requests the bridge never forwards for a legacy phone. The phone drives
 * sessions through the daemon protocol; it does not administer the daemon,
 * the account, project trust, standing configuration, MCP servers, routines,
 * remote-device management or an interactive shell. A relay peer that holds
 * a phone's ticket gets exactly what the phone gets, so these stay host-local.
 */
const LEGACY_BRIDGE_DENIED_METHODS: ReadonlySet<string> = new Set([
  "daemon.shutdown",
  "daemon.reload",
  "auth.login",
  "auth.logout",
  "project.trust",
  "plugin.settings.set",
  "plugin.settings.reset",
  "session.applyConfig",
  "session.permissions.mutateRule",
  "session.hooks.setDisabled",
  "session.mcp.addServer",
  "session.mcp.enableServer",
  "routine.create",
  "routine.update",
  "routine.delete",
  "routine.run",
  "routine.cancel",
  "routine.session.prepare.respond",
]);
const LEGACY_BRIDGE_DENIED_PREFIXES: readonly string[] = ["remote.", "telegram.", "commandExec."];

/** True when a legacy phone request must be answered with REMOTE_METHOD_DENIED instead of forwarded. */
export function legacyBridgeDeniesMethod(method: string): boolean {
  return LEGACY_BRIDGE_DENIED_METHODS.has(method) || LEGACY_BRIDGE_DENIED_PREFIXES.some((prefix) => method.startsWith(prefix));
}

/** Subprotocol name under which a legacy host offers its relay ticket. */
export const LEGACY_HOST_PROTOCOL = "agenc-relay-v1";

/**
 * How a legacy host presents its ticket to the relay. The ticket rides in the
 * `Sec-WebSocket-Protocol` header, base64url-encoded because `s1` tickets
 * contain ":" which is not a valid subprotocol token character, so it never
 * appears in a request URL that edge observability logs record. `fallback`
 * selects the old query form for relays that predate the subprotocol.
 */
export function legacyHostHandshake(
  relayUrl: string,
  ticket: string,
  fallback: boolean,
): { readonly url: string; readonly protocols: string[] } {
  if (fallback) {
    return { url: `${relayUrl}/v1/host?ticket=${encodeURIComponent(ticket)}`, protocols: [] };
  }
  return {
    url: `${relayUrl}/v1/host`,
    protocols: [LEGACY_HOST_PROTOCOL, Buffer.from(ticket, "utf8").toString("base64url")],
  };
}

