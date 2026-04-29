/**
 * I-18 (docs/plan/invariants.md:592-619): compaction shrink
 * assertion.
 *
 * This file has two halves:
 *
 * 1. A pure unit test of `assertCompactionShrank`, the helper
 *    `compactConversation` delegates to at the end of the happy
 *    path. A near-identity summary must throw
 *    `CompactionShrinkRatioError`; a real shrink must pass. This
 *    is the same assertion that fires inside `compactConversation`
 *    so it exercises the exact production code path.
 *
 * 2. An integration test of the `autoCompactIfNeeded` catch block:
 *    we stub `compactConversation` to throw `CompactionShrinkRatioError`
 *    (the exact "near-identity summary" symptom the assertion
 *    catches inside compactConversation), and assert the
 *    `consecutiveFailures` counter increments. Repeated failures
 *    must trip the `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`
 *    circuit breaker so subsequent turns skip auto-compact and
 *    fall through to alternative recovery.
 *
 * The spec in invariants.md line 617-619 asks for a test that
 * "mock[s a] provider that returns a summary 90% the size of the
 * original; assert[s the] circuit-breaker counter incremented,
 * summary discarded". Driving the real `compactConversation`
 * through its full hook/fork/attachment graph just to reach the
 * shrink-ratio site would require ~15 module-level stubs; the
 * two-half approach above exercises the same contract
 * end-to-end while keeping the seams at the right granularity.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import type { Mock } from 'vitest'

vi.mock('axios', () => ({
  default: {},
  AxiosError: class AxiosError extends Error {},
}))

import {
  CompactionShrinkRatioError,
  DEFAULT_COMPACTION_MIN_SHRINK_RATIO,
  assertCompactionShrank,
  buildPostCompactMessages,
  createSkillAttachmentIfNeeded,
  createReferenceContextMessages,
  getCompactionMinShrinkRatio,
} from './compact.ts'
import {
  clearInvokedSkills,
  recordInvokedSkill,
} from '../../skills/local-loader.js'

// ─────────────────────────────────────────────────────────────────────
// Part 1: pure assertion helper
// ─────────────────────────────────────────────────────────────────────

describe('assertCompactionShrank (I-18)', () => {
  const originalEnv = process.env.AGENC_COMPACTION_MIN_SHRINK_RATIO

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENC_COMPACTION_MIN_SHRINK_RATIO
    } else {
      process.env.AGENC_COMPACTION_MIN_SHRINK_RATIO = originalEnv
    }
  })

  test('throws CompactionShrinkRatioError on near-identity summary (post = 90% of pre)', () => {
    // Spec wording: "mock provider that returns a summary 90% the
    // size of the original". 90% ≥ 70% threshold → assertion fires.
    const pre = 1_000
    const post = 900
    let caught: unknown
    try {
      assertCompactionShrank(pre, post)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CompactionShrinkRatioError)
    const err = caught as CompactionShrinkRatioError
    expect(err.preCompactTokenCount).toBe(pre)
    expect(err.postCompactTokenCount).toBe(post)
    expect(err.minShrinkRatio).toBe(DEFAULT_COMPACTION_MIN_SHRINK_RATIO)
    // Surface the invariant tag in the error message so operators
    // can grep for I-18 in logs.
    expect(err.message).toMatch(/I-18/)
  })

  test('no-throw on a real compaction (post = 50% of pre, default ratio = 0.7)', () => {
    expect(() => assertCompactionShrank(10_000, 5_000)).not.toThrow()
  })

  test('no-throw right below the threshold (post = 69.9% of pre, default ratio = 0.7)', () => {
    // pre * 0.7 = 7_000. post = 6_999 is strictly below → pass.
    expect(() => assertCompactionShrank(10_000, 6_999)).not.toThrow()
  })

  test('throws exactly at the threshold (post = 70% of pre, default ratio = 0.7)', () => {
    // Threshold uses `>=` not `>`, so exact equality trips the assertion.
    // This matches auto-compact's behavior: a summary that barely
    // shrank is still a soft compaction failure because the next
    // turn's autocompact will fire on the same (barely reduced)
    // token count, creating a loop.
    expect(() => assertCompactionShrank(10_000, 7_000)).toThrow(
      CompactionShrinkRatioError,
    )
  })

  test('no-throw when preCompactTokenCount <= 0 (treated as no-op)', () => {
    expect(() => assertCompactionShrank(0, 5_000)).not.toThrow()
    expect(() => assertCompactionShrank(-100, 5_000)).not.toThrow()
  })

  test('respects custom minShrinkRatio argument (tightens the bar)', () => {
    // With ratio = 0.3, post must be strictly below 30% of pre.
    // 5000/10000 = 50% → fails.
    expect(() => assertCompactionShrank(10_000, 5_000, 0.3)).toThrow(
      CompactionShrinkRatioError,
    )
    // 2999/10000 = 29.99% → passes.
    expect(() => assertCompactionShrank(10_000, 2_999, 0.3)).not.toThrow()
  })

  test('AGENC_COMPACTION_MIN_SHRINK_RATIO env override is honored', () => {
    process.env.AGENC_COMPACTION_MIN_SHRINK_RATIO = '0.5'
    expect(getCompactionMinShrinkRatio()).toBeCloseTo(0.5)
    // With ratio = 0.5, post=6000 vs pre=10000 → 60% ≥ 50% → throws.
    expect(() => assertCompactionShrank(10_000, 6_000)).toThrow(
      CompactionShrinkRatioError,
    )
  })

  test('AGENC_COMPACTION_MIN_SHRINK_RATIO >= 1 disables the check (infinite budget)', () => {
    process.env.AGENC_COMPACTION_MIN_SHRINK_RATIO = '1'
    expect(getCompactionMinShrinkRatio()).toBe(Number.POSITIVE_INFINITY)
    // Even with post > pre the check passes because the ratio is +Inf.
    // pre * Infinity = Infinity, and truePost >= Infinity is false.
    expect(() => assertCompactionShrank(10_000, 50_000)).not.toThrow()
  })

  test('CompactionShrinkRatioError carries the diagnostic fields', () => {
    try {
      assertCompactionShrank(1_000, 950, 0.7)
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionShrinkRatioError)
      const err = error as CompactionShrinkRatioError
      expect(err.name).toBe('CompactionShrinkRatioError')
      expect(err.preCompactTokenCount).toBe(1_000)
      expect(err.postCompactTokenCount).toBe(950)
      expect(err.minShrinkRatio).toBe(0.7)
    }
  })
})

describe('createSkillAttachmentIfNeeded', () => {
  afterEach(() => {
    clearInvokedSkills()
  })

  test('restores invoked skill content for compaction', () => {
    recordInvokedSkill({
      skillName: 'repo-docs',
      skillPath: '/skills/repo-docs/SKILL.md',
      content: 'Use repository docs.',
      invokedAt: 10,
    })

    const attachment = createSkillAttachmentIfNeeded()

    expect(attachment?.attachment).toMatchObject({
      type: 'invoked_skills',
      skills: [
        {
          name: 'repo-docs',
          path: '/skills/repo-docs/SKILL.md',
          content: 'Use repository docs.',
        },
      ],
    })
  })
})

describe('mid-turn initial context injection', () => {
  test('buildPostCompactMessages inserts reference context immediately before the last real user message', () => {
    const referenceContextMessages = createReferenceContextMessages({
      cwd: '/tmp/project',
      approvalPolicy: 'never',
      sandboxPolicy: 'read_only',
      model: 'claude-sonnet-4',
    })

    const built = buildPostCompactMessages({
      boundaryMarker: {
        role: 'system',
        content: '[boundary] compacted',
      } as never,
      summaryMessages: [
        {
          type: 'user',
          isCompactSummary: true,
          message: {
            role: 'user',
            content: 'summary',
          },
        } as never,
      ],
      referenceContextMessages,
      messagesToKeep: [
        { role: 'user', content: 'older user' } as never,
        { role: 'user', content: 'latest user' } as never,
      ],
      attachments: [],
      hookResults: [],
    })

    expect(built.map((message) => (message as { content?: string }).content ?? (message as { message?: { content?: string } }).message?.content)).toEqual([
      '[boundary] compacted',
      'summary',
      'older user',
      expect.stringContaining('<reference_context_item>'),
      'latest user',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────
// Part 2: autoCompact circuit-breaker increment on I-18 failure.
//
// Strategy: mock `./compact.js` so `compactConversation` is a throwing
// stub that raises the exact `CompactionShrinkRatioError` the real
// function would raise on a near-identity summary. Then drive
// `autoCompactIfNeeded` directly and verify:
//   (a) the returned `consecutiveFailures` starts at 1 on the first
//       failure and grows by 1 per failing call;
//   (b) once the caller-maintained tracking hits
//       MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3, the next call short-
//       circuits with `wasCompacted: false` (no `compactConversation`
//       call) — the circuit-breaker gate in auto-compact.ts:270.
//
// All other heavy deps stay real; we only replace the outbound
// compaction and the session-memory fallback (so we deterministically
// take the compactConversation path, not session-memory compaction).
// ─────────────────────────────────────────────────────────────────────

vi.mock('./session-memory-compact.js', () => ({
  trySessionMemoryCompaction: vi.fn(async () => null),
}))

vi.mock('./compact.js', async () => {
  const actual = await vi.importActual<typeof import('./compact.js')>(
    './compact.js',
  )
  return {
    ...actual,
    compactConversation: vi.fn(async () => {
      // Near-identity summary: 950 tokens out of 1000 pre.
      // 950 >= 1000 * 0.7 → the assertion inside compactConversation
      // would throw this exact error type.
      throw new actual.CompactionShrinkRatioError(
        1_000,
        950,
        actual.DEFAULT_COMPACTION_MIN_SHRINK_RATIO,
      )
    }),
  }
})

// Keep post-compact cleanup inert so the failure path doesn't touch it
// through any transitive catch (autoCompact calls cleanup on the
// success branch only, but the mock guards against silent breakage).
vi.mock('./post-compact-cleanup.js', () => ({
  runPostCompactCleanup: vi.fn(),
}))

type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
}

function mkToolUseContext(): unknown {
  // Minimal shape: auto-compact reads `options.mainLoopModel`,
  // `options.querySource`, `agentId`, and routes `abortController` +
  // `getAppState` through compactConversation (which we've mocked to
  // throw before it ever touches those). Cast to unknown so we don't
  // have to stub the full AgenC ToolUseContext surface.
  return {
    agentId: 'test-agent',
    options: {
      mainLoopModel: 'claude-sonnet-4',
      querySource: 'repl_main_thread',
      isNonInteractiveSession: false,
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      appendSystemPrompt: undefined,
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    loadedNestedMemoryPaths: new Set(),
    getAppState: () => ({
      toolPermissionContext: {},
      effortValue: undefined,
    }),
    setSDKStatus: () => {},
    setStreamMode: () => {},
    setResponseLength: () => {},
    onCompactProgress: () => {},
    emitWarning: vi.fn(),
    queryTracking: undefined,
  }
}

describe('autoCompactIfNeeded circuit breaker on I-18 failure', () => {
  const originalPctOverride = process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE
  const originalDisable = process.env.DISABLE_COMPACT
  const originalAutoDisable = process.env.DISABLE_AUTO_COMPACT

  beforeEach(() => {
    // Force shouldAutoCompact to return true by dropping the
    // threshold to 1% of the effective context window. With even a
    // tiny message list the token count clears 1% of ~180k = ~1.8k,
    // so autoCompactIfNeeded proceeds into compactConversation.
    process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = '1'
    delete process.env.DISABLE_COMPACT
    delete process.env.DISABLE_AUTO_COMPACT
    vi.clearAllMocks()
  })

  test('session-memory fast path carries reference context injection for before_last_user_message', async () => {
    const { autoCompactIfNeeded } = await import('./auto-compact.ts')
    const smCompact = await import('./session-memory-compact.js')
    vi.mocked(smCompact.trySessionMemoryCompaction).mockResolvedValueOnce({
      boundaryMarker: {
        role: 'system',
        content: '[boundary] compacted',
      },
      summaryMessages: [
        {
          type: 'user',
          isCompactSummary: true,
          message: { role: 'user', content: 'summary' },
        },
      ],
      attachments: [],
      hookResults: [],
      messagesToKeep: [{ role: 'user', content: 'latest user' }],
    } as never)

    const toolUseContext = mkToolUseContext() as {
      referenceContextItem?: unknown
    }
    toolUseContext.referenceContextItem = {
      cwd: '/tmp/project',
      approvalPolicy: 'never',
      sandboxPolicy: 'read_only',
      model: 'claude-sonnet-4',
    }

    const result = await autoCompactIfNeeded(
      makeFatMessages(40),
      toolUseContext as never,
      {} as never,
      'repl_main_thread',
      undefined,
      0,
      'before_last_user_message',
    )

    expect(result.wasCompacted).toBe(true)
    expect(
      result.compactionResult?.referenceContextMessages?.[0],
    ).toMatchObject({
      role: 'user',
      content: expect.stringContaining('<reference_context_item>'),
    })
  })

  afterEach(() => {
    if (originalPctOverride === undefined) {
      delete process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE
    } else {
      process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = originalPctOverride
    }
    if (originalDisable === undefined) {
      delete process.env.DISABLE_COMPACT
    } else {
      process.env.DISABLE_COMPACT = originalDisable
    }
    if (originalAutoDisable === undefined) {
      delete process.env.DISABLE_AUTO_COMPACT
    } else {
      process.env.DISABLE_AUTO_COMPACT = originalAutoDisable
    }
  })

  test('first I-18 failure bumps consecutiveFailures to 1', async () => {
    const { autoCompactIfNeeded, shouldAutoCompact } = await import(
      './auto-compact.ts'
    )
    const context = mkToolUseContext() as {
      emitWarning: Mock
    }
    // Pad messages so tokenCountWithEstimation clears the 1% threshold.
    const messages = makeFatMessages(40)
    // Smoke-check the upstream gate so a failure in `shouldAutoCompact`
    // shows up as an explicit precondition failure rather than a silent
    // `wasCompacted: false`. With `AGENC_AUTOCOMPACT_PCT_OVERRIDE=1`
    // the threshold is about 1% of the effective context window
    // (~10k tokens for claude-sonnet-4), which our fat fixture clears.
    const gate = await shouldAutoCompact(
      messages as never,
      'claude-sonnet-4',
      'repl_main_thread',
      0,
    )
    expect(gate).toBe(true)

    const tracking: AutoCompactTrackingState = {
      compacted: false,
      turnCounter: 0,
      turnId: 'turn-0',
      consecutiveFailures: 0,
    }

    const result = await autoCompactIfNeeded(
      messages,
      context as never,
      {} as never, // cacheSafeParams — irrelevant because compactConversation is mocked
      'repl_main_thread',
      tracking,
      0,
    )

    expect(result.wasCompacted).toBe(false)
    // On I-18 failure the caller should observe the increment so
    // subsequent turns can enforce MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES.
    expect(result.consecutiveFailures).toBe(1)
    expect(context.emitWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'auto_compact_failed',
      }),
    )
    expect(context.emitWarning.mock.calls[0]?.[0]?.message).toContain(
      'auto compact failed',
    )
    expect(result.warning?.cause).toBe('auto_compact_failed')
  })

  test('consecutiveFailures grows by 1 per failed turn', async () => {
    const { autoCompactIfNeeded } = await import('./auto-compact.ts')

    const messages = makeFatMessages(40)

    // Simulate the turn-loop threading: caller writes
    // `consecutiveFailures` onto tracking after each call.
    let consecutiveFailures = 0
    for (let i = 1; i <= 2; i += 1) {
      const tracking: AutoCompactTrackingState = {
        compacted: false,
        turnCounter: i - 1,
        turnId: `turn-${i - 1}`,
        consecutiveFailures,
      }
      const result = await autoCompactIfNeeded(
        messages,
        mkToolUseContext() as never,
        {} as never,
        'repl_main_thread',
        tracking,
        0,
      )
      expect(result.wasCompacted).toBe(false)
      expect(result.consecutiveFailures).toBe(i)
      consecutiveFailures = result.consecutiveFailures ?? 0
    }
  })

  test('circuit breaker trips at MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3 — further turns short-circuit without calling compactConversation', async () => {
    const { autoCompactIfNeeded } = await import('./auto-compact.ts')
    const compactMod = await import('./compact.js')
    const compactSpy = compactMod.compactConversation as unknown as Mock

    const messages = makeFatMessages(40)

    // Prime tracking to the already-tripped state.
    const trippedTracking: AutoCompactTrackingState = {
      compacted: false,
      turnCounter: 3,
      turnId: 'turn-3',
      consecutiveFailures: 3,
    }

    const result = await autoCompactIfNeeded(
      messages,
      mkToolUseContext() as never,
      {} as never,
      'repl_main_thread',
      trippedTracking,
      0,
    )

    expect(result.wasCompacted).toBe(false)
    // After the cap, auto-compact returns early — no compactConversation call.
    expect(compactSpy).not.toHaveBeenCalled()
    // And does NOT re-report consecutiveFailures (caller keeps its
    // existing value, matching the guard at auto-compact.ts:270-275
    // which returns `{ wasCompacted: false }` without threading a
    // fresh count).
    expect(result.consecutiveFailures).toBeUndefined()
  })
})

/**
 * Pad messages until `tokenCountWithEstimation` clears the lowered
 * autocompact threshold. The helper walks back to the LAST assistant
 * message with real usage; the usage numbers below are chosen to
 * exceed the 1% threshold for claude-sonnet-4 under
 * `AGENC_AUTOCOMPACT_PCT_OVERRIDE=1` (about 9-10k tokens).
 */
function makeFatMessages(count: number): unknown[] {
  const body = 'x'.repeat(20_000)
  const out: unknown[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({
      type: 'assistant',
      uuid: `msg-${i}`,
      message: {
        id: `resp-${i}`,
        role: 'assistant',
        content: [{ type: 'text', text: body }],
        model: 'claude-sonnet-4',
        usage: {
          input_tokens: 50_000,
          output_tokens: 10_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      costUSD: 0,
      durationMs: 0,
      requestId: `req-${i}`,
    })
  }
  return out
}
