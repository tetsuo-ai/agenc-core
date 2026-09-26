import { describe, expect, it } from 'vitest'

import { isSecureStorageUnavailableMessage } from '../../../src/utils/secureStorage/unavailable.js'

describe('isSecureStorageUnavailableMessage', () => {
  it('recognizes a backend that is absent on this host', () => {
    const absent = [
      'Secret Service is unavailable: libsecret-1.so.0: cannot open shared object file',
      'Secret Service helper could not load /usr/lib/libsecret-1.so.0',
      'session initialization failed: no session bus',
      'Could not connect to the session message bus',
      'Failed to connect to D-Bus',
      'org.freedesktop.secrets is not provided on this bus',
      'Failed to connect to socket /run/user/1000/bus',
      'Native secure storage is unavailable on this platform',
      '  Secret Service is unavailable: no helper  ',
    ]
    for (const message of absent) {
      expect(isSecureStorageUnavailableMessage(message), message).toBe(true)
    }
  })

  it('does not treat an unreadable or missing record as an absent backend', () => {
    const unreadable = [
      '',
      '   ',
      'Secret Service returned an empty credential record',
      'Secret Service lookup failed with exit code 1',
      'The Secret Service is unavailable',
      'item not found',
      'decryption failed',
      'GPG error: no secret key',
      'permission denied',
    ]
    for (const message of unreadable) {
      expect(isSecureStorageUnavailableMessage(message), message).toBe(false)
    }
  })
})
