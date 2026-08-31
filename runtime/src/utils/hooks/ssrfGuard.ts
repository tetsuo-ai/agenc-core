import type { AddressFamily, LookupAddress as AxiosLookupAddress } from 'axios'
import { lookup as dnsLookup } from 'dns'
import { isIP } from 'net'

/**
 * SSRF guard for HTTP hooks.
 *
 * Blocks private, link-local, and other non-routable address ranges to prevent
 * project-configured HTTP hooks from reaching cloud metadata endpoints
 * (169.254.169.254) or internal infrastructure.
 *
 * Loopback (127.0.0.0/8, ::1) is intentionally ALLOWED — local dev policy
 * servers are a primary HTTP hook use case.
 *
 * When a global proxy or the sandbox network proxy is in use, the guard is
 * effectively bypassed for the target host because the proxy performs DNS
 * resolution. The sandbox proxy enforces its own domain allowlist.
 */

/**
 * Returns true if the address is in a range that HTTP hooks should not reach.
 *
 * Blocked IPv4:
 *   0.0.0.0/8        "this" network
 *   10.0.0.0/8       private
 *   100.64.0.0/10    shared address space / CGNAT (some cloud metadata, e.g. Alibaba 100.100.100.200)
 *   169.254.0.0/16   link-local (cloud metadata)
 *   172.16.0.0/12    private
 *   192.168.0.0/16   private
 *   192.0.0.0/24     IETF protocol assignments
 *   192.0.2.0/24     documentation
 *   192.88.99.0/24   deprecated 6to4 relay anycast
 *   198.18.0.0/15    benchmarking
 *   198.51.100.0/24  documentation
 *   203.0.113.0/24   documentation
 *   224.0.0.0/4      multicast
 *   240.0.0.0/4      reserved
 *
 * Blocked IPv6:
 *   ::               unspecified
 *   fc00::/7         unique local
 *   fe80::/10        link-local
 *   ::ffff:<v4>      mapped IPv4 in a blocked range
 *   IPv4 translation, documentation, benchmarking, multicast, and other
 *   special-purpose ranges that are not ordinary public destinations
 *
 * Allowed (returns false):
 *   127.0.0.0/8      loopback (local dev hooks)
 *   ::1              loopback
 *   everything else
 */
export function isBlockedAddress(address: string): boolean {
  const v = isIP(address)
  if (v === 4) {
    return isBlockedV4(address)
  }
  if (v === 6) {
    return isBlockedV6(address)
  }
  // Not a valid IP literal — let the real DNS path handle it (this function
  // is only called on results from dns.lookup, which always returns valid IPs)
  return false
}

function isBlockedV4(address: string): boolean {
  const parts = address.split('.').map(Number)
  const [a, b] = parts
  if (
    parts.length !== 4 ||
    a === undefined ||
    b === undefined ||
    parts.some(n => Number.isNaN(n))
  ) {
    return false
  }

  // Loopback explicitly allowed
  if (a === 127) return false

  // 0.0.0.0/8
  if (a === 0) return true
  // 10.0.0.0/8
  if (a === 10) return true
  // 169.254.0.0/16 — link-local, cloud metadata
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 100.64.0.0/10 — shared address space (RFC 6598, CGNAT). Some cloud
  // providers use this range for metadata endpoints (e.g. Alibaba Cloud at
  // 100.100.100.200).
  if (a === 100 && b >= 64 && b <= 127) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true
  // 192.0.0.0/24 — IETF protocol assignments. The small globally reachable
  // exceptions in this block are infrastructure addresses, not webhook
  // destinations, so the public-egress policy fails closed on the whole block.
  if (a === 192 && b === 0 && parts[2] === 0) return true
  // Documentation and deprecated transition ranges.
  if (a === 192 && b === 0 && parts[2] === 2) return true
  if (a === 192 && b === 88 && parts[2] === 99) return true
  // 198.18.0.0/15 — benchmark networks.
  if (a === 198 && (b === 18 || b === 19)) return true
  // Documentation ranges.
  if (a === 198 && b === 51 && parts[2] === 100) return true
  if (a === 203 && b === 0 && parts[2] === 113) return true
  // Multicast and reserved/future-use space, including limited broadcast.
  if (a >= 224) return true

  return false
}

function isBlockedV6(address: string): boolean {
  const lower = address.toLowerCase()
  const groups = expandIPv6Groups(lower)

  // ::1 loopback explicitly allowed, including its fully expanded spelling.
  if (
    lower === '::1' ||
    (groups !== null &&
      groups.slice(0, 7).every(group => group === 0) &&
      groups[7] === 1)
  ) {
    return false
  }

  // :: unspecified
  if (lower === '::') return true

  // IPv4-mapped IPv6 (0:0:0:0:0:ffff:X:Y in any representation — ::ffff:a.b.c.d,
  // ::ffff:XXXX:YYYY, expanded, or partially expanded). Extract the embedded
  // IPv4 address and delegate to the v4 check. Without this, hex-form mapped
  // addresses (e.g. ::ffff:a9fe:a9fe = 169.254.169.254) bypass the guard.
  const mappedV4 = extractMappedIPv4(lower)
  if (mappedV4 !== null) {
    return isBlockedV4(mappedV4)
  }

  if (groups === null) return false

  const [first, second, third] = groups

  // Deprecated IPv4-compatible addresses (::/96). Unspecified and loopback
  // were handled above; the remaining forms are not public IPv6 destinations.
  if (groups.slice(0, 6).every(group => group === 0)) return true

  // IPv4 translation prefixes. Blocking the prefixes avoids using a NAT64
  // gateway to reach an IPv4 range that was not visible to this process.
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    ((groups.slice(2, 6).every(group => group === 0)) ||
      third === 1)
  ) {
    return true
  }

  // 100::/64 — discard-only.
  if (
    first === 0x0100 &&
    second === 0 &&
    third === 0 &&
    groups[3] === 0
  ) {
    return true
  }

  // IETF protocol assignments, benchmarking, ORCHID, documentation, and
  // transition mechanisms. These are not ordinary public webhook targets.
  if (first === 0x2001 && second !== undefined && second <= 0x01ff) return true
  if (first === 0x2001 && second === 0x0db8) return true
  if (first === 0x2002) return true
  if (
    first === 0x3fff &&
    second !== undefined &&
    (second & 0xf000) === 0
  ) {
    return true
  }

  // fc00::/7 — unique local addresses (fc00:: through fdff::)
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true
  }

  // fe80::/10 — link-local. The /10 means fe80 through febf, but the first
  // hextet is always fe80 in practice (RFC 4291 requires the next 54 bits
  // to be zero). Check both to be safe.
  const firstHextet = lower.split(':')[0]
  if (
    firstHextet &&
    firstHextet.length === 4 &&
    firstHextet >= 'fe80' &&
    firstHextet <= 'febf'
  ) {
    return true
  }

  // fec0::/10 — deprecated site-local addresses.
  if (
    first !== undefined &&
    first >= 0xfec0 &&
    first <= 0xfeff
  ) {
    return true
  }

  // ff00::/8 — multicast.
  if (first !== undefined && (first & 0xff00) === 0xff00) return true

  return false
}

/**
 * Expand `::` and optional trailing dotted-decimal so an IPv6 address is
 * represented as exactly 8 hex groups. Returns null if expansion is not
 * well-formed (the caller has already validated with isIP, so this is
 * defensive).
 */
export function expandIPv6Groups(addr: string): number[] | null {
  // Node accepts scoped IPv6 addresses (for example `fe80::1%eth0`) as IP
  // literals. The zone identifies an interface, not address bits, so classify
  // the base address while preserving the original string for the socket.
  const zoneIndex = addr.indexOf('%')
  if (zoneIndex !== -1) {
    if (
      zoneIndex === 0 ||
      zoneIndex === addr.length - 1 ||
      zoneIndex !== addr.lastIndexOf('%')
    ) {
      return null
    }
    addr = addr.slice(0, zoneIndex)
  }

  // Handle trailing dotted-decimal IPv4 (e.g. ::ffff:169.254.169.254).
  // Replace it in place with two hex groups. Keeping the separator in the
  // normalized address preserves a preceding `::` compression marker.
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    if (lastColon === -1) return null
    const v4 = addr.slice(lastColon + 1)
    const octetStrings = v4.split('.')
    if (
      octetStrings.length !== 4 ||
      octetStrings.some(
        value => !/^(?:0|[1-9]\d{0,2})$/.test(value) || Number(value) > 255,
      )
    ) {
      return null
    }
    const octets = octetStrings.map(Number)
    const high = ((octets[0]! << 8) | octets[1]!).toString(16)
    const low = ((octets[2]! << 8) | octets[3]!).toString(16)
    addr = `${addr.slice(0, lastColon + 1)}${high}:${low}`
  }

  // Expand exactly one optional `::` into one or more zero groups.
  const dbl = addr.indexOf('::')
  let hex: string[]
  if (dbl === -1) {
    hex = addr.split(':')
    if (hex.length !== 8) return null
  } else {
    if (addr.indexOf('::', dbl + 2) !== -1) return null
    const headStr = addr.slice(0, dbl)
    const tailStr = addr.slice(dbl + 2)
    const head = headStr === '' ? [] : headStr.split(':')
    const tail = tailStr === '' ? [] : tailStr.split(':')
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    hex = [...head, ...new Array<string>(fill).fill('0'), ...tail]
  }

  if (hex.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null
  }
  return hex.map(group => parseInt(group, 16))
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address
 * (0:0:0:0:0:ffff:X:Y) in any valid representation — compressed, expanded,
 * hex groups, or trailing dotted-decimal. Returns null if the address is
 * not an IPv4-mapped IPv6 address.
 */
export function extractMappedIPv4(addr: string): string | null {
  const g = expandIPv6Groups(addr)
  if (!g) return null
  // IPv4-mapped: first 80 bits zero, next 16 bits ffff, last 32 bits = IPv4
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff
  ) {
    const hi = g[6]!
    const lo = g[7]!
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  return null
}

/**
 * A dns.lookup-compatible function that resolves a hostname and rejects
 * addresses in blocked ranges. Used as the `lookup` option in axios request
 * config so that the validated IP is the one the socket connects to — no
 * rebinding window between validation and connection.
 *
 * IP literals in the hostname are validated directly without DNS.
 *
 * Signature matches axios's `lookup` config option (not Node's dns.lookup).
 */
export function ssrfGuardedLookup(
  hostname: string,
  options: object,
  callback: (
    err: Error | null,
    address: AxiosLookupAddress | AxiosLookupAddress[],
    family?: AddressFamily,
  ) => void,
): void {
  const wantsAll = 'all' in options && options.all === true

  // If hostname is already an IP literal, validate it directly. dns.lookup
  // would short-circuit too, but checking here gives a clearer error and
  // avoids any platform-specific lookup behavior for literals.
  const ipVersion = isIP(hostname)
  if (ipVersion !== 0) {
    if (isBlockedAddress(hostname)) {
      callback(ssrfError(hostname, hostname), '')
      return
    }
    const family = ipVersion === 6 ? 6 : 4
    if (wantsAll) {
      callback(null, [{ address: hostname, family }])
    } else {
      callback(null, hostname, family)
    }
    return
  }

  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err, '')
      return
    }

    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        callback(ssrfError(hostname, address), '')
        return
      }
    }

    const first = addresses[0]
    if (!first) {
      callback(
        Object.assign(new Error(`ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
          hostname,
        }),
        '',
      )
      return
    }

    const family = first.family === 6 ? 6 : 4
    if (wantsAll) {
      callback(
        null,
        addresses.map(a => ({
          address: a.address,
          family: a.family === 6 ? 6 : 4,
        })),
      )
    } else {
      callback(null, first.address, family)
    }
  })
}

function ssrfError(hostname: string, address: string): NodeJS.ErrnoException {
  const err = new Error(
    `HTTP hook blocked: ${hostname} resolves to ${address} (private/link-local address). Loopback (127.0.0.1, ::1) is allowed for local dev.`,
  )
  return Object.assign(err, {
    code: 'ERR_HTTP_HOOK_BLOCKED_ADDRESS',
    hostname,
    address,
  })
}
