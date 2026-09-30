/** Fixture-only denied lookup classification. Never calls a native transport.
 * Inputs are the canonical trusted fetch arguments, not an arbitrary JS sandbox.
 */
const MODELS = 'https://api.openai.com/v1/models';

/** @param {RequestInfo | URL} input @param {RequestInit | undefined} init */
export function isDeniedModelsLookup(input, init) {
  try {
    const request = input instanceof Request ? input : null;
    const url = request !== null ? request.url : input instanceof URL ? input.href : input;
    const method = init?.method === undefined ? request?.method ?? 'GET' : init.method;
    return url === MODELS && method === 'GET' &&
      (init?.body === undefined || init.body === null) &&
      (request === null || request.body === null);
  } catch { return false; }
}

export function createPreflightFetchGuard() {
  let deniedMetadataRequests = 0, forbiddenFetches = 0;
  /** @type {typeof globalThis.fetch} */
  const fetchImpl = async (input, init) => {
    if (isDeniedModelsLookup(input, init)) {
      deniedMetadataRequests++;
      throw new Error('preflight_metadata_lookup_denied');
    }
    forbiddenFetches++;
    throw new Error('preflight_network_forbidden');
  };
  return Object.freeze({ fetchImpl,
    snapshot: () => Object.freeze({ deniedMetadataRequests, forbiddenFetches }) });
}
