import { describe, expect, it } from 'vitest'

import { validateOfficialNameSource } from 'src/utils/plugins/schemas.js'

const RESERVED = 'agenc-code-plugins'

describe('validateOfficialNameSource — git URL official-source check', () => {
  it('rejects attacker hosts that embed the magic substring in query/fragment/path', () => {
    // Regression: a substring check on the raw URL accepted these.
    const attacks = [
      'https://evil.com/?u=github.com/tetsuo-ai/x',
      'https://evil.com/path#git@github.com:tetsuo-ai/x',
      'https://evil.com/github.com/tetsuo-ai/repo.git',
      'https://github.com.evil.com/tetsuo-ai/repo.git',
    ]
    for (const url of attacks) {
      expect(
        validateOfficialNameSource(RESERVED, { source: 'git', url }),
        url,
      ).toMatch(/reserved for official provider marketplaces/)
    }
  })

  it('accepts legitimate github.com/tetsuo-ai URLs (https, scp-ssh, ssh://)', () => {
    const legit = [
      'https://github.com/tetsuo-ai/agenc-code-plugins.git',
      'git@github.com:tetsuo-ai/agenc-code-plugins.git',
      'ssh://git@github.com/tetsuo-ai/repo.git',
      'https://GitHub.com/Tetsuo-AI/Repo', // case-insensitive
    ]
    for (const url of legit) {
      expect(
        validateOfficialNameSource(RESERVED, { source: 'git', url }),
        url,
      ).toBeNull()
    }
  })

  it('still validates the github source arm by org prefix', () => {
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'github',
        repo: 'tetsuo-ai/x',
      }),
    ).toBeNull()
    expect(
      validateOfficialNameSource(RESERVED, {
        source: 'github',
        repo: 'evil/x',
      }),
    ).toMatch(/reserved/)
  })

  it('does not gate non-reserved names', () => {
    expect(
      validateOfficialNameSource('some-random-marketplace', {
        source: 'git',
        url: 'https://evil.com/whatever',
      }),
    ).toBeNull()
  })
})
