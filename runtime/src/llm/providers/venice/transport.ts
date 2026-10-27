/**
 * Seconds until a Venice rate-limit window clears, from one reset header.
 *
 * Venice sends `x-ratelimit-reset-requests` and `x-ratelimit-reset-tokens`
 * as Unix timestamps in milliseconds (13 digits, observed on live 429s).
 * Seconds-precision timestamps and plain delays in seconds are read too, so
 * a change of unit on Venice's side still yields a short, correct wait
 * instead of a multi-year Retry-After that ends the turn.
 */
function resetHeaderSeconds(value: string | null, nowMs: number): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  if (number >= 1e12) return Math.max(0, (number - nowMs) / 1000);
  if (number >= 1e9) return Math.max(0, number - nowMs / 1000);
  return number;
}

/**
 * Venice's Retry-After equivalent: the reset of each window that is used up
 * (remaining 0). When the response names no used-up window, wait for the
 * later of the two resets, because one of them is what refused the request.
 */
function veniceRetryAfterSeconds(headers: Headers, nowMs: number): number | undefined {
  const windows = [
    { remaining: headers.get("x-ratelimit-remaining-requests"), reset: headers.get("x-ratelimit-reset-requests") },
    { remaining: headers.get("x-ratelimit-remaining-tokens"), reset: headers.get("x-ratelimit-reset-tokens") },
  ].map(window => ({ exhausted: window.remaining?.trim() === "0", seconds: resetHeaderSeconds(window.reset, nowMs) }))
    .filter(window => window.seconds !== undefined);
  const exhausted = windows.filter(window => window.exhausted);
  const chosen = exhausted.length > 0 ? exhausted : windows;
  if (chosen.length === 0) return undefined;
  return Math.ceil(Math.max(...chosen.map(window => window.seconds!)));
}

/** Venice error bodies can be plain strings. Redact the actual credential
 * before shared diagnostics see them, even if an upstream error echoes it.
 */
export function veniceFetch(fetchImpl: typeof fetch, apiKey: string | undefined): typeof fetch {
  const redact = (value: string): string => apiKey ? value.replaceAll(apiKey, "[REDACTED]") : value;
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (!(error instanceof Error) || !apiKey || !error.message.includes(apiKey)) throw error;
      throw new Error(redact(error.message));
    }
    if (response.ok) return response;
    const headers = new Headers(response.headers);
    headers.forEach((value, name) => headers.set(name, redact(value)));
    // Convert Venice's reset headers to the shared Retry-After contract
    // without overriding a standard Retry-After header from the endpoint.
    if (response.status === 429 && !headers.has("retry-after")) {
      const seconds = veniceRetryAfterSeconds(headers, Date.now());
      if (seconds !== undefined && Number.isSafeInteger(seconds) && seconds > 0) {
        headers.set("retry-after", String(seconds));
      }
    }
    const body = redact(await response.text());
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(body, { status: response.status, statusText: redact(response.statusText), headers });
  };
}
