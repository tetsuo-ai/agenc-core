import { describe, expect, test } from 'vitest'

import { decodeSecureStorageData } from '../../../src/utils/secureStorage/decode.js'

describe('native secure-storage decoder', () => {
  test.each([
    ['null', /non-null JSON object/u],
    ['[]', /non-null JSON object/u],
    ['"secret"', /non-null JSON object/u],
    ['42', /non-null JSON object/u],
    ['{"primaryApiKey":"one","primaryApiKey":"two"}', /duplicate object keys/u],
  ])('rejects corrupt shared-vault payload %s', (payload, message) => {
    expect(() => decodeSecureStorageData(payload, 'test vault')).toThrow(message)
  })

  test('accepts a plain credential object', () => {
    expect(
      decodeSecureStorageData('{"primaryApiKey":"secret"}', 'test vault'),
    ).toEqual({ primaryApiKey: 'secret' })
  })
})
