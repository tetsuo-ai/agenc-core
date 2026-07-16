import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { REPLHookContext } from '../../../src/utils/hooks/postSamplingHooks.js'

// Controllable thresholds/enabled state, mutated per-test before each call.
const settings = {
  autoDreamEnabled: true as boolean,
  autoDreamMinHours: 24 as number,
  autoDreamMinSessions: 5 as number,
}

// Controllable gate inputs.
const gateState = {
  lastConsolidatedAt: 0,
  touchedSessions: [] as string[],
  lockResult: 1 as number | null,
}

const CURRENT_SESSION = 'current-session-id'

vi.mock('../../../src/utils/settings/settings.js', () => ({
  getExecutionAuthoritySettings: () => settings,
  getInitialSettings: () => settings,
}))

vi.mock('../../../src/services/autoDream/config.js', () => ({
  isAutoDreamEnabled: () => settings.autoDreamEnabled,
}))

vi.mock('../../../src/bootstrap/state.js', async importOriginal => {
  const actual = await importOriginal<
    typeof import('../../../src/bootstrap/state.js')
  >()
  return {
    ...actual,
    getKairosActive: () => false,
    getIsRemoteMode: () => false,
    getSessionId: () => CURRENT_SESSION,
    getOriginalCwd: () => '/tmp/autodream-test',
  }
})

vi.mock('../../../src/memory/index.js', async importOriginal => {
  const actual = await importOriginal<
    typeof import('../../../src/memory/index.js')
  >()
  return {
    ...actual,
    isAutoMemoryEnabled: () => true,
    getAutoMemPath: () => '/tmp/autodream-test/memory',
  }
})

vi.mock('../../../src/utils/sessionStorage.js', async importOriginal => {
  const actual = await importOriginal<
    typeof import('../../../src/utils/sessionStorage.js')
  >()
  return {
    ...actual,
    getProjectDir: () => '/tmp/autodream-test/transcripts',
  }
})

vi.mock('../../../src/services/autoDream/consolidationLock.js', () => ({
  readLastConsolidatedAt: vi.fn(async () => gateState.lastConsolidatedAt),
  listSessionsTouchedSince: vi.fn(async () => gateState.touchedSessions),
  tryAcquireConsolidationLock: vi.fn(async () => gateState.lockResult),
  rollbackConsolidationLock: vi.fn(async () => undefined),
}))

const runForkedAgent = vi.fn(async () => ({
  totalUsage: {
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  outputMessages: [],
}))

vi.mock('../../../src/utils/forkedAgent.js', () => ({
  runForkedAgent,
  createCacheSafeParams: vi.fn(() => ({})),
}))

vi.mock('../../../src/services/extractMemories/extractMemories.js', () => ({
  createAutoMemoryToolPolicy: vi.fn(() => ({})),
}))

vi.mock('../../../src/services/autoDream/consolidationPrompt.js', () => ({
  buildConsolidationPrompt: vi.fn(() => 'prompt'),
}))

vi.mock('../../../src/tasks/DreamTask/DreamTask.js', () => ({
  registerDreamTask: vi.fn(() => 'dream-task-id'),
  addDreamTurn: vi.fn(),
  completeDreamTask: vi.fn(),
  failDreamTask: vi.fn(),
  isDreamTask: vi.fn(() => false),
}))

function makeContext(): REPLHookContext {
  return {
    messages: [],
    systemPrompt: [] as unknown as REPLHookContext['systemPrompt'],
    userContext: {},
    systemContext: {},
    toolUseContext: {
      setAppState: vi.fn(),
      getAppState: () => ({ tasks: {} }),
    } as unknown as REPLHookContext['toolUseContext'],
  }
}

const HOUR = 3_600_000

// Re-import the module fresh each test so the closure-scoped scan throttle
// (lastSessionScanAt) and the module-level runner singleton are reset — see
// autoDream.ts header comment: tests re-init the closure per test.
async function freshExecute() {
  vi.resetModules()
  const mod = await import('../../../src/services/autoDream/autoDream.js')
  return mod.executeAutoDream
}

beforeEach(() => {
  runForkedAgent.mockClear()
  settings.autoDreamEnabled = true
  settings.autoDreamMinHours = 24
  settings.autoDreamMinSessions = 5
  gateState.lastConsolidatedAt = 0
  gateState.touchedSessions = []
  gateState.lockResult = 1
})

describe('executeAutoDream gates', () => {
  describe('time gate', () => {
    it('does not fire when fewer than minHours have elapsed', async () => {
      gateState.lastConsolidatedAt = Date.now() - 1 * HOUR
      settings.autoDreamMinHours = 24
      gateState.touchedSessions = ['s1', 's2', 's3', 's4', 's5', 's6']
      const executeAutoDream = await freshExecute()
      await executeAutoDream(makeContext())
      expect(runForkedAgent).not.toHaveBeenCalled()
    })

    it('fires when minHours have elapsed (and other gates open)', async () => {
      gateState.lastConsolidatedAt = Date.now() - 25 * HOUR
      settings.autoDreamMinHours = 24
      gateState.touchedSessions = ['s1', 's2', 's3', 's4', 's5', 's6']
      gateState.lockResult = 1
      const executeAutoDream = await freshExecute()
      await executeAutoDream(makeContext())
      expect(runForkedAgent).toHaveBeenCalledTimes(1)
    })
  })

  describe('session-count gate', () => {
    it('does not fire when fewer than minSessions have accumulated', async () => {
      gateState.lastConsolidatedAt = Date.now() - 25 * HOUR
      settings.autoDreamMinSessions = 5
      gateState.touchedSessions = ['s1', 's2']
      const executeAutoDream = await freshExecute()
      await executeAutoDream(makeContext())
      expect(runForkedAgent).not.toHaveBeenCalled()
    })

    it('fires when enough sessions have accumulated', async () => {
      gateState.lastConsolidatedAt = Date.now() - 25 * HOUR
      settings.autoDreamMinSessions = 5
      gateState.touchedSessions = ['s1', 's2', 's3', 's4', 's5', 's6']
      const executeAutoDream = await freshExecute()
      await executeAutoDream(makeContext())
      expect(runForkedAgent).toHaveBeenCalledTimes(1)
    })

    it('excludes the current session from the count', async () => {
      gateState.lastConsolidatedAt = Date.now() - 25 * HOUR
      settings.autoDreamMinSessions = 5
      // 5 real sessions + the current one. After excluding current → 5, which
      // meets the threshold. If the current session were NOT excluded the count
      // would be 6; either way it fires, so to prove exclusion we set 4 reals +
      // current → excluded count 4 < 5 → must NOT fire.
      gateState.touchedSessions = ['s1', 's2', 's3', 's4', CURRENT_SESSION]
      const executeAutoDream = await freshExecute()
      await executeAutoDream(makeContext())
      expect(runForkedAgent).not.toHaveBeenCalled()
    })
  })

  describe('filesystem-lock gate', () => {
    it('does not fire when the lock is held (null)', async () => {
      gateState.lastConsolidatedAt = Date.now() - 25 * HOUR
      gateState.touchedSessions = ['s1', 's2', 's3', 's4', 's5', 's6']
      gateState.lockResult = null
      const executeAutoDream = await freshExecute()
      await executeAutoDream(makeContext())
      expect(runForkedAgent).not.toHaveBeenCalled()
    })

    it('fires when the lock is acquired', async () => {
      gateState.lastConsolidatedAt = Date.now() - 25 * HOUR
      gateState.touchedSessions = ['s1', 's2', 's3', 's4', 's5', 's6']
      gateState.lockResult = 0
      const executeAutoDream = await freshExecute()
      await executeAutoDream(makeContext())
      expect(runForkedAgent).toHaveBeenCalledTimes(1)
    })
  })

  describe('enabled gate', () => {
    it('does not fire when auto-dream is disabled', async () => {
      settings.autoDreamEnabled = false
      gateState.lastConsolidatedAt = Date.now() - 25 * HOUR
      gateState.touchedSessions = ['s1', 's2', 's3', 's4', 's5', 's6']
      const executeAutoDream = await freshExecute()
      await executeAutoDream(makeContext())
      expect(runForkedAgent).not.toHaveBeenCalled()
    })
  })
})
