import { describe, expect, it } from 'vitest'

import {
  addProviderProfile,
  getProviderProfiles,
  type ProviderProfileInput,
} from 'src/utils/providerProfiles.js'
import type { GlobalConfig, ProviderProfile } from 'src/utils/config.js'

// gaphunt3 #39: sanitizeProfile must reject baseUrls that are not well-formed
// http(s) URLs (typos, wrong scheme, embedded whitespace/control chars) instead
// of silently accepting them and only failing later as an opaque network error.
//
// sanitizeProfile is module-private, so these tests exercise it through the two
// public entry points that flow through it:
//   - getProviderProfiles -> sanitizeProfiles -> sanitizeProfile (filters bad
//     profiles out of the returned list)
//   - addProviderProfile  -> toProfile        -> sanitizeProfile (returns null,
//     rejecting the input, before any config mutation)
//
// Before the fix every one of these malformed baseUrls produced a non-null
// sanitized profile; after the fix they are rejected.

function profile(baseUrl: string, id = 'p1'): ProviderProfile {
  return {
    id,
    name: 'Test',
    provider: 'openai',
    baseUrl,
    model: 'gpt-test',
  }
}

function configWith(profiles: ProviderProfile[]): GlobalConfig {
  return { providerProfiles: profiles } as unknown as GlobalConfig
}

function input(baseUrl: string): ProviderProfileInput {
  return {
    provider: 'openai',
    name: 'Test',
    baseUrl,
    model: 'gpt-test',
  }
}

describe('gaphunt3 #39: provider profile baseUrl URL validation', () => {
  it('drops profiles whose baseUrl is not a valid URL', () => {
    const result = getProviderProfiles(configWith([profile('not a url')]))
    expect(result).toHaveLength(0)
  })

  it('drops profiles with a typo / non-http(s) scheme', () => {
    expect(
      getProviderProfiles(configWith([profile('htps://typo')])),
    ).toHaveLength(0)
    expect(
      getProviderProfiles(configWith([profile('ftp://example.com')])),
    ).toHaveLength(0)
  })

  it('drops profiles whose baseUrl contains whitespace / control characters', () => {
    expect(
      getProviderProfiles(configWith([profile('https://has space.com')])),
    ).toHaveLength(0)
    expect(
      getProviderProfiles(configWith([profile('https://tab\there.com')])),
    ).toHaveLength(0)
    expect(
      getProviderProfiles(configWith([profile('https://ctrl.com')])),
    ).toHaveLength(0)
  })

  it('keeps profiles with well-formed http(s) baseUrls (incl. localhost)', () => {
    const valid = getProviderProfiles(
      configWith([
        profile('https://api.openai.com/v1', 'a'),
        profile('http://localhost:11434/v1', 'b'),
        profile('http://127.0.0.1:1337/v1', 'c'),
      ]),
    )
    expect(valid.map(p => p.id)).toEqual(['a', 'b', 'c'])
    // trailing slash is still normalized away on the kept profile
    expect(
      getProviderProfiles(configWith([profile('https://api.openai.com/v1/')]))[0]
        .baseUrl,
    ).toBe('https://api.openai.com/v1')
  })

  it('addProviderProfile rejects a malformed baseUrl (returns null, no mutation)', () => {
    // toProfile -> sanitizeProfile returns null, so addProviderProfile bails
    // out before touching global config.
    expect(addProviderProfile(input('htps://typo'))).toBeNull()
    expect(addProviderProfile(input('not a url'))).toBeNull()
    expect(addProviderProfile(input('https://has space.com'))).toBeNull()
  })
})
