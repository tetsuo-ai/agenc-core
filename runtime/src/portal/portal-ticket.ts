// Signs relay tickets the relay verifies (P2b). HMAC-SHA256 hex over "<accountId>:<role>:<exp>:
// <hostId>", emitted as s1:<accountId>:<role>:<exp>:<hostId>:<sig>. Node createHmac produces the
// exact same hex as the relay's WebCrypto hmacHex, so a portal-signed ticket verifies on the relay.
// The shared secret lives in AGENC_RELAY_TICKET_SECRET (set alongside the relay's wrangler secret);
// the phone never holds it — it receives a pre-signed client ticket via `agenc portal pair`.
import { createHmac } from "node:crypto";

export type RelayRole = "host" | "client";

export interface SignRelayTicketOptions {
  secret: string;
  accountId: string;
  role: RelayRole;
  ttlMs?: number;
  hostId?: string;
  now?: number;
}

/** Fields are colon-delimited in the signed message, so they must be colon-free (and we keep them to
 *  a safe charset). A ":" in accountId/hostId would shift the signed fields and mis-key the room. */
const SAFE_FIELD = /^[A-Za-z0-9._-]+$/;

export function signRelayTicket(opts: SignRelayTicketOptions): string {
  if (!SAFE_FIELD.test(opts.accountId)) {
    throw new Error(`invalid accountId "${opts.accountId}" — allowed characters: A-Za-z0-9._-`);
  }
  if (opts.hostId !== undefined && opts.hostId.length > 0 && !SAFE_FIELD.test(opts.hostId)) {
    throw new Error(`invalid hostId "${opts.hostId}" — allowed characters: A-Za-z0-9._-`);
  }
  const exp = (opts.now ?? Date.now()) + (opts.ttlMs ?? 3_600_000);
  const hostId = opts.hostId ?? "";
  const sig = createHmac("sha256", opts.secret)
    .update(`${opts.accountId}:${opts.role}:${exp}:${hostId}`)
    .digest("hex");
  return `s1:${opts.accountId}:${opts.role}:${exp}:${hostId}:${sig}`;
}
