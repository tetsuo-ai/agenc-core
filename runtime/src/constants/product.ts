export const PRODUCT_URL = 'https://agenc.tech/agenc-code'

// AgenC Remote session URLs
export const AGENC_AI_BASE_URL = 'https://agenc.tech'
export const AGENC_AI_STAGING_BASE_URL = 'https://agenc.tech'
export const AGENC_AI_LOCAL_BASE_URL = 'http://localhost:4000'

/**
 * Determine if we're in a staging environment for remote sessions.
 * Checks session ID format and ingress URL.
 */
export function isRemoteSessionStaging(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_staging_') === true ||
    ingressUrl?.includes('staging') === true
  )
}

/**
 * Determine if we're in a local-dev environment for remote sessions.
 * Checks session ID format (e.g. `session_local_...`) and ingress URL.
 */
export function isRemoteSessionLocal(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_local_') === true ||
    ingressUrl?.includes('localhost') === true
  )
}

/**
 * Get the base URL for AgenC AI based on environment.
 */
export function getAgenCAiBaseUrl(
  sessionId?: string,
  ingressUrl?: string,
): string {
  if (isRemoteSessionLocal(sessionId, ingressUrl)) {
    return AGENC_AI_LOCAL_BASE_URL
  }
  if (isRemoteSessionStaging(sessionId, ingressUrl)) {
    return AGENC_AI_STAGING_BASE_URL
  }
  return AGENC_AI_BASE_URL
}

/**
 * Get the full session URL for a remote session.
 *
 * The cse_→session_ translation is a short-lived shim gated by
 * tengu_bridge_repl_v2_cse_shim_enabled (see isCseShimEnabled). Worker
 * endpoints (/v1/code/sessions/{id}/worker/*) want `cse_*` but the AgenC web
 * frontend currently routes on `session_*` (compat/convert.go:27 validates
 * TagSession). Same UUID body, different tag prefix. Once the server tags by
 * environment_kind and the frontend accepts `cse_*` directly, flip the gate
 * off. No-op for IDs already in `session_*` form. See toCompatSessionId in
 * src/bridge/sessionIdCompat.ts for the canonical helper (lazy-required here
 * to keep constants/ leaf-of-DAG at module-load time).
 */
export function getRemoteSessionUrl(
  sessionId: string,
  ingressUrl?: string,
): string {
  // Donor sessionIdCompat helper was deleted with the bridge subsystem.
  // Pass the session id through unchanged until AgenC ships a real
  // session-id compatibility shim.
  const compatId = sessionId
  const baseUrl = getAgenCAiBaseUrl(compatId, ingressUrl)
  return `${baseUrl}/code/${compatId}`
}
