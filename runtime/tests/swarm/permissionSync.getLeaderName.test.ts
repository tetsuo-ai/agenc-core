import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock the team-file reader so we can exercise getLeaderName against
// well-formed and malformed team files without touching disk.
const readTeamFileAsync = vi.fn()
vi.mock('src/utils/swarm/teamHelpers.js', () => ({
  readTeamFileAsync: (...args: unknown[]) => readTeamFileAsync(...args),
  // getTeamName is referenced by getLeaderName when no teamName is passed;
  // our tests always pass an explicit team, but provide a stub anyway.
  getTeamName: () => undefined,
}))

import { getLeaderName } from 'src/utils/swarm/permissionSync.js'

afterEach(() => {
  readTeamFileAsync.mockReset()
})

describe('getLeaderName', () => {
  it('returns the lead member name for a well-formed team file', async () => {
    readTeamFileAsync.mockResolvedValue({
      leadAgentId: 'a1',
      members: [
        { agentId: 'a1', name: 'captain' },
        { agentId: 'a2', name: 'scout' },
      ],
    })
    await expect(getLeaderName('team-x')).resolves.toBe('captain')
  })

  it('falls back to "team-lead" when the lead member has no name', async () => {
    readTeamFileAsync.mockResolvedValue({
      leadAgentId: 'a1',
      members: [{ agentId: 'a1' }],
    })
    await expect(getLeaderName('team-x')).resolves.toBe('team-lead')
  })

  it('returns null (no throw) when the team file is missing', async () => {
    readTeamFileAsync.mockResolvedValue(null)
    await expect(getLeaderName('team-x')).resolves.toBeNull()
  })

  it('returns null (no throw) when the team file is malformed (missing members)', async () => {
    // Regression: readTeamFileAsync casts JSON to TeamFile without validation,
    // so a present-but-malformed file used to make .find() throw — surfacing as
    // an unhandled rejection in the fire-and-forget caller. It must instead
    // follow the graceful return-null contract.
    readTeamFileAsync.mockResolvedValue({ leadAgentId: 'a1' })
    await expect(getLeaderName('team-x')).resolves.toBeNull()
  })

  it('returns null when members is present but not an array', async () => {
    readTeamFileAsync.mockResolvedValue({ leadAgentId: 'a1', members: {} })
    await expect(getLeaderName('team-x')).resolves.toBeNull()
  })
})
