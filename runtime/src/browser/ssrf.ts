/**
 * SSRF address policy for the built-in browser tool.
 *
 * Enforcement does NOT rely on pre-resolving a URL and then trusting the
 * browser to connect to the same address (that is a DNS-rebinding TOCTOU).
 * Instead the browser is launched with `--proxy-server` + a host-resolver pin
 * so it can neither resolve nor connect on its own; ALL egress goes through an
 * in-process loopback proxy (`proxy.ts`) that calls {@link resolveAllowedAddress}
 * exactly once per connection and dials that resolved IP directly. The address
 * classification here is the single source of truth the proxy consults.
 *
 * `isBlockedAddress` (the shared hook guard) intentionally ALLOWS loopback for
 * local-dev HTTP hooks. A browser reaching `localhost` can hit local admin
 * panels, so this policy is stricter: with `allowPrivateNetwork` false (the
 * default) loopback is blocked too. Cloud-metadata endpoints are blocked
 * unconditionally — the agent's browser never has a legitimate reason to read
 * them, and they are the highest-value SSRF target.
 *
 * @module
 */

import { isIP } from "node:net";
import { lookup as dnsLookupPromise } from "node:dns/promises";
import {
  isBlockedAddress,
  extractMappedIPv4,
  expandIPv6Groups,
} from "../utils/hooks/ssrfGuard.js";

export interface BrowserSsrfPolicy {
  /**
   * When true, private/loopback destinations are permitted (local dev, testing
   * against a localhost fixture). Cloud-metadata endpoints stay blocked either
   * way. Default false.
   */
  readonly allowPrivateNetwork: boolean;
}

/** Resolve a hostname to its addresses. Injectable so tests never touch DNS. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

export class BrowserSsrfError extends Error {
  readonly code = "BROWSER_SSRF_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "BrowserSsrfError";
  }
}

/**
 * Cloud-metadata IPv4 endpoints blocked regardless of `allowPrivateNetwork`.
 * 169.254.169.254 (AWS/GCP/Azure IMDS), 100.100.100.200 (Alibaba).
 */
const METADATA_V4_ADDRESSES: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "100.100.100.200",
]);

/** Cloud-metadata IPv6 endpoint (AWS IPv6 IMDS: fd00:ec2::254), expanded. */
const METADATA_V6_GROUPS: readonly number[] = expandIPv6Groups("fd00:ec2::254")!;

/**
 * Compare two expanded IPv6 group arrays for equality (both are 8 hextets).
 */
function sameGroups(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * True if `address` is a cloud-metadata endpoint in ANY representation —
 * dotted IPv4, an IPv4-mapped IPv6 form (`::ffff:169.254.169.254`, or the hex
 * `::ffff:a9fe:a9fe` that Chrome/WHATWG canonicalizes it to), or a non-canonical
 * IPv6 spelling of the AWS IPv6 IMDS address. Metadata stays blocked even when
 * `allowPrivateNetwork` is true, so this check must not depend on a literal
 * string set the browser's URL canonicalizer can sidestep.
 */
function isCloudMetadataAddress(address: string): boolean {
  const bare = stripBrackets(address).toLowerCase();
  const version = isIP(bare);
  if (version === 4) return METADATA_V4_ADDRESSES.has(bare);
  if (version === 6) {
    const mapped = extractMappedIPv4(bare);
    if (mapped !== null) return METADATA_V4_ADDRESSES.has(mapped);
    const groups = expandIPv6Groups(bare);
    return groups !== null && sameGroups(groups, METADATA_V6_GROUPS);
  }
  return false;
}

/** True for IPv4 127.0.0.0/8 and IPv6 ::1 (loopback). */
export function isLoopbackAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return address.split(".")[0] === "127";
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
  }
  return false;
}

/**
 * Classify a single resolved IP address against the policy. Returns true when
 * the browser must NOT be allowed to reach it.
 */
export function isDisallowedAddress(
  address: string,
  policy: BrowserSsrfPolicy,
): boolean {
  // Metadata endpoints are blocked in every representation, even when private
  // networking is allowed — this must run before the allowPrivateNetwork gate.
  if (isCloudMetadataAddress(address)) return true;
  if (policy.allowPrivateNetwork) return false;
  // Private / link-local / CGNAT ranges (loopback excluded by this guard).
  if (isBlockedAddress(address)) return true;
  // Loopback: allowed by the shared hook guard, blocked here by default.
  if (isLoopbackAddress(address)) return true;
  return false;
}

const defaultLookup: HostLookup = async (hostname) => {
  const records = await dnsLookupPromise(hostname, { all: true });
  return records.map((record) => record.address);
};

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Validate a navigation URL's scheme and credentials (synchronous — no DNS).
 * Address enforcement is the proxy's job; this rejects the classes that must
 * never even reach navigation: non-http(s) schemes and embedded credentials.
 * Returns the parsed URL. Throws {@link BrowserSsrfError} otherwise.
 */
export function validateNavigableUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BrowserSsrfError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserSsrfError(
      `unsupported scheme "${url.protocol}" — only http and https can be navigated`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new BrowserSsrfError("URLs with embedded credentials are not allowed");
  }
  if (stripBrackets(url.hostname) === "") {
    throw new BrowserSsrfError(`URL has no host: ${rawUrl}`);
  }
  return url;
}

/**
 * Resolve a host to a single permitted IP for the proxy to dial. Fails closed:
 * throws if the host does not resolve, or if ANY resolved address is
 * disallowed (mirrors the WebFetch guard's "reject if any address is blocked"
 * strictness so a mixed public/private answer cannot be exploited). The
 * returned address is the exact one the proxy connects to — no second
 * resolution, so no rebinding window.
 */
export async function resolveAllowedAddress(
  host: string,
  policy: BrowserSsrfPolicy,
  lookup: HostLookup = defaultLookup,
): Promise<string> {
  const bare = stripBrackets(host);
  const addresses = isIP(bare) !== 0 ? [bare] : await lookup(bare);
  if (addresses.length === 0) {
    throw new BrowserSsrfError(`could not resolve host: ${bare}`);
  }
  for (const address of addresses) {
    if (isDisallowedAddress(address, policy)) {
      throw new BrowserSsrfError(
        `blocked ${bare} — resolves to ${address} (private/loopback/metadata address; set [browser].allow_private_network to permit local targets)`,
      );
    }
  }
  return addresses[0]!;
}
