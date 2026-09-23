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
): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  if (!carriesCredential(url, headers)) return fetchImpl(input, init);

  let request: RequestInit = {
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
    if (next.origin !== url.origin) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Provider credential redirect to another origin was refused (${next.hostname})`);
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
