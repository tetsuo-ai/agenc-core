/** Keep provider credentials on the origin to which the request was addressed. */

const CREDENTIAL_NAME = /(?:authorization|api[-_]?key|access[-_]?key|(?:access|auth|session|security)[-_]?token|(?:^|[-_])auth(?:$|[-_])|password|secret|signature|credential)/iu;
const MAX_SAME_ORIGIN_REDIRECTS = 10;
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

function carriesCredential(url: URL, headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (CREDENTIAL_NAME.test(name)) return true;
  }
  for (const name of url.searchParams.keys()) {
    if (name.toLowerCase() === "key" || CREDENTIAL_NAME.test(name)) return true;
  }
  return false;
}

/** Fetch with explicit redirect handling for authenticated provider traffic. */
export async function fetchProviderRequest(
  input: RequestInfo | URL,
  init: RequestInit,
  fetchImpl: typeof fetch,
  allowedOrigins?: ReadonlySet<string>,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    throw new Error("Provider request has an invalid URL");
  }
  if (allowedOrigins !== undefined && !allowedOrigins.has(url.origin)) {
    throw new Error("Provider request to another origin was refused");
  }
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  if (allowedOrigins === undefined && !carriesCredential(url, headers)) return fetchImpl(input, init);

  let request: RequestInit = {
    ...(input instanceof Request ? {
      method: input.method,
      headers: input.headers,
      ...(input.body !== null ? {
        body: input.body,
        duplex: "half" as const,
      } : {}),
      signal: input.signal,
    } : {}),
    ...init,
    ...(input instanceof Request && init.headers === undefined
      ? { headers: input.headers }
      : {}),
    redirect: "manual",
  };
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(url, request);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error("Provider redirect has an invalid location");
    }
    if (next.origin !== url.origin ||
        (allowedOrigins !== undefined && !allowedOrigins.has(next.origin))) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Provider redirect to another origin was refused");
    }
    if (!FOLLOWED_REDIRECTS.has(response.status)) return response;
    if (redirects >= MAX_SAME_ORIGIN_REDIRECTS) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Provider redirect limit exceeded");
    }
    void response.body?.cancel().catch(() => {});
    if (response.status === 303 ||
        ((response.status === 301 || response.status === 302) && request.method?.toUpperCase() === "POST")) {
      const redirectedHeaders = new Headers(request.headers);
      redirectedHeaders.delete("content-type");
      redirectedHeaders.delete("content-length");
      request = { ...request, headers: redirectedHeaders, method: "GET", body: undefined };
    }
    url = next;
  }
}

/** Bind a child's transport to the registry origins before any request is sent. */
export function createPinnedProviderFetch(
  canonicalBaseURLs: readonly string[],
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const bases = canonicalBaseURLs.map((baseURL) => new URL(baseURL));
  const allowedOrigins = new Set(bases.map((base) => base.origin));
  const guardedFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!bases.some((base) => url.origin === base.origin &&
        (url.pathname === base.pathname.replace(/\/$/u, "") ||
          url.pathname.startsWith(`${base.pathname.replace(/\/$/u, "")}/`)))) {
      throw new Error("Provider request outside its canonical endpoint was refused");
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchProviderRequest(input, init ?? {}, guardedFetch, allowedOrigins)) as typeof fetch;
}
