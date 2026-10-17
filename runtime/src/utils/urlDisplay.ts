/**
 * Display helpers that keep lookalike hostnames from fooling the user.
 *
 * A hostname written with letters from another alphabet (Cyrillic `а` in
 * `аmazon.com`) renders exactly like the real name but resolves to a
 * different site. The network only ever sees the ASCII (punycode) form,
 * `xn--mazon-3ve.com`, so that is the form every user-facing surface shows.
 *
 * @module
 */

// Scheme plus authority of an http(s) URL inside free text. The authority
// stops at characters that cannot be part of a hostname so surrounding
// prose punctuation stays out of it. No lookbehind: it defeats YARR JIT in
// JSC.
const WEB_URL_AUTHORITY_PATTERN =
  /\b(https?:\/\/)([^\s/?#<>"'`\\()[\]{},;|]+)/giu

const NON_ASCII = /[^\x00-\x7f]/u

/** ASCII (punycode) form of a hostname, or undefined when it is not valid. */
function asciiHost(host: string): string | undefined {
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname.length > 0 ? hostname : undefined
  } catch {
    return undefined
  }
}

function revealAuthority(authority: string): string {
  const at = authority.lastIndexOf('@')
  const userinfo = at === -1 ? '' : authority.slice(0, at + 1)
  const hostPort = authority.slice(at + 1)
  const portMatch = /:\d*$/u.exec(hostPort)
  const port = portMatch?.[0] ?? ''
  const host = hostPort.slice(0, hostPort.length - port.length)
  if (!NON_ASCII.test(host)) return authority
  const ascii = asciiHost(host)
  return ascii === undefined ? authority : `${userinfo}${ascii}${port}`
}

/**
 * Rewrites every non-ASCII hostname inside http(s) URLs in `text` to the
 * ASCII form the network actually uses. Everything else is left as written.
 */
export function revealUrlHosts(text: string): string {
  if (!NON_ASCII.test(text)) return text
  return text.replace(
    WEB_URL_AUTHORITY_PATTERN,
    (_match, scheme: string, authority: string) =>
      `${scheme}${revealAuthority(authority)}`,
  )
}

/** Hostname of an http(s) URL as the network sees it, or undefined. */
export function webUrlHost(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.hostname.length > 0 ? url.hostname : undefined
  } catch {
    return undefined
  }
}

/**
 * True when the hostname was written with letters outside plain ASCII
 * (any `xn--` label). Such names can imitate another site.
 */
export function isInternationalizedHost(host: string): boolean {
  return host
    .toLowerCase()
    .split('.')
    .some(label => label.startsWith('xn--'))
}

/**
 * True when `text` already shows `host` (ignoring a leading `www.`), so a
 * reader can see where a link goes without an extra hint.
 */
export function textShowsHost(text: string, host: string): boolean {
  const bare = host.toLowerCase().replace(/^www\./u, '')
  return text.toLowerCase().includes(bare)
}
