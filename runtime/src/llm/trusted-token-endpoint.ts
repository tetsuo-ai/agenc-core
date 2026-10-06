/** Send OAuth credentials only to the already validated token endpoint. */
export async function fetchTrustedTokenEndpoint(
  endpoint: string,
  init: RequestInit,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<Response> {
  const response = await fetchImpl(endpoint, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Trusted token endpoint redirect was refused");
  }
  return response;
}
