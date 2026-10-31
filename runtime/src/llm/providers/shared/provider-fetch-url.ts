/**
 * Which URLs web_fetch may hand to a provider's server-side page fetch
 * (DeepSeek's Fetch API, Ollama Cloud's web fetch). The provider's servers
 * load the page and follow its redirects themselves, so web_fetch gives it
 * only a URL the local fetcher would dial too; the caller adds its own
 * permission, preapproval and DNS checks (bin/model-facing-tools.ts).
 *
 * @module
 */

import { isIP } from "node:net";

/**
 * Name suffixes that never name a public site: mDNS, private-use and
 * reserved namespaces. Their URLs stay with the local fetcher.
 */
const NON_PUBLIC_NAME_SUFFIXES = Object.freeze([
  "local",
  "localhost",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "test",
  "invalid",
  "onion",
  "arpa",
]);

/**
 * Why `url` must not be sent to a provider's fetch, or undefined when it may
 * be: an http(s) URL without a username or password whose host is a public
 * DNS name, so no IP address, no single-label name, and no local,
 * private-use or reserved suffix. The caller still resolves the name itself
 * before sending it.
 */
export function providerFetchSkipReason(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not an http or https URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "not an http or https URL";
  }
  if (parsed.username !== "" || parsed.password !== "") return "URL with credentials";
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  if (host.length === 0) return "URL without a host";
  if (isIP(host) !== 0) return "IP address host";
  const suffix = NON_PUBLIC_NAME_SUFFIXES.find(
    (name) => host === name || host.endsWith(`.${name}`),
  );
  if (suffix !== undefined) return `.${suffix} host`;
  return host.includes(".") ? undefined : "single-label host";
}
