/**
 * Backend absence, kept in its own module so the platform backends and the
 * native adapter can share it without importing the (test-mocked) index.
 */

/**
 * The native backend cannot be used on this host at all: the library or
 * helper is missing, or (Linux) there is no Secret Service session bus.
 * Distinct from a record that exists but cannot be read: nothing can have
 * been stored in a backend that does not exist here, so read-only callers
 * may treat it as empty while every write stays fail-closed.
 */
export class SecureStorageUnavailableError extends Error {
  readonly name = 'SecureStorageUnavailableError'
}

const SECURE_STORAGE_UNAVAILABLE_MARKERS: readonly RegExp[] = [
  /^Secret Service is unavailable:/u,
  /^Secret Service helper could not load /u,
  /session initialization failed/iu,
  /message bus/iu,
  /D-?Bus/iu,
  /org\.freedesktop\.secrets/u,
  /Failed to connect to socket/iu,
  /Native secure storage is unavailable on this platform/u,
]

/** True when a backend failure message means the backend is absent, not that a record is unreadable. */
export function isSecureStorageUnavailableMessage(message: string): boolean {
  const text = message.trim()
  return SECURE_STORAGE_UNAVAILABLE_MARKERS.some((marker) => marker.test(text))
}
