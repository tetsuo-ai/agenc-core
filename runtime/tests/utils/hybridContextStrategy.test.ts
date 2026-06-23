import { describe, expect, it } from 'bun:test'
import {
  splitContext,
  applyHybridStrategy,
  optimizeForCost,
  optimizeForAccuracy,
  getHybridStats,
} from '../../src/utils/hybridContextStrategy.ts'

function createMessage(role: string, content: string, createdAt: number = Date.now()): any {
  return {
    message: { role, content, id: 'test', type: 'message', created_at: createdAt },
    sender: role,
  }
}

// Distinct-id message factory: applyHybridStrategy/splitContext dedup by
// `uuid ?? message.id`, so the shared `id: 'test'` from createMessage collapses
// otherwise-distinct messages into one. Tests that need budget/weight behavior
// to actually bite must use distinct ids.
function createDistinctMessage(
  id: string,
  role: string,
  content: string,
  createdAt: number,
): any {
  return {
    uuid: id,
    message: { role, content, id, type: 'message', created_at: createdAt },
    sender: role,
  }
}

// roughTokenCountEstimation = Math.round(content.length / 4); mirror it so tests
// assert against the same token contract the strategy uses internally.
function estTokens(content: string): number {
  return Math.round(content.length / 4)
}

describe('hybridContextStrategy', () => {
  describe('splitContext', () => {
    it('splits context into cached and fresh', () => {
      // All three are clearly recent (1h old) so age is well under the 24h
      // cache-eligibility threshold and they deterministically land in `fresh`.
      const recent = Date.now() - 60 * 60 * 1000
      const messages = [
        createMessage('system', 'System prompt', recent),
        createMessage('user', 'Hello', recent),
        createMessage('assistant', 'Hi there', recent),
      ]

      const split = splitContext(messages, {
        cacheWeight: 0.4,
        freshWeight: 0.6,
        maxTotalTokens: 10000,
      })

      // Token accounting is exact: 13/4->3, 5/4->1, 8/4->2 = 6 total, all fresh.
      const expectedFresh =
        estTokens('System prompt') + estTokens('Hello') + estTokens('Hi there')
      expect(expectedFresh).toBe(6)
      expect(split.cachedTokens).toBe(0)
      expect(split.freshTokens).toBe(expectedFresh)
      expect(split.totalTokens).toBe(split.cachedTokens + split.freshTokens)
      expect(split.totalTokens).toBe(expectedFresh)
      // No message is dropped within budget, and none leaks into both buckets.
      expect(split.cached).toHaveLength(0)
      expect(split.fresh).toHaveLength(3)
    })

    it('respects weight configuration', () => {
      // Old (5-day) messages are eligible for the cache bucket, so the weights
      // genuinely steer how tokens are distributed between cached and fresh.
      const oldBase = Date.now() - 86400000 * 5
      const messages = Array.from({ length: 10 }, (_, i) =>
        createDistinctMessage('o' + i, 'user', 'x'.repeat(400), oldBase - i * 1000),
      )

      const cacheHeavy = splitContext(messages, {
        cacheWeight: 0.8,
        freshWeight: 0.2,
        maxTotalTokens: 1000,
      })
      const freshHeavy = splitContext(messages, {
        cacheWeight: 0.2,
        freshWeight: 0.8,
        maxTotalTokens: 1000,
      })

      // Each bucket stays within its weight-derived target.
      expect(cacheHeavy.cachedTokens).toBeLessThanOrEqual(Math.floor(1000 * 0.8))
      expect(cacheHeavy.freshTokens).toBeLessThanOrEqual(Math.floor(1000 * 0.2))
      expect(freshHeavy.cachedTokens).toBeLessThanOrEqual(Math.floor(1000 * 0.2))
      expect(freshHeavy.freshTokens).toBeLessThanOrEqual(Math.floor(1000 * 0.8))

      // Each 400-char message is 100 tokens, so the split lands on exact counts.
      expect(cacheHeavy.cachedTokens).toBe(800)
      expect(cacheHeavy.freshTokens).toBe(200)
      expect(freshHeavy.cachedTokens).toBe(200)
      expect(freshHeavy.freshTokens).toBe(800)

      // The weights actually move tokens between buckets (not a fixed split).
      expect(cacheHeavy.cachedTokens).toBeGreaterThan(freshHeavy.cachedTokens)
      expect(freshHeavy.freshTokens).toBeGreaterThan(cacheHeavy.freshTokens)
    })
  })

  describe('applyHybridStrategy', () => {
    it('applies strategy and returns messages', () => {
      // Distinct ids so both survive dedup; assert exact content and ordering.
      const messages = [
        createDistinctMessage('a', 'user', 'Message 1', 1000),
        createDistinctMessage('b', 'assistant', 'Response 1', 2000),
      ]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })

      // Both messages fit the budget and are returned in chronological order.
      expect(result.selectedMessages.map(m => m.message.content)).toEqual([
        'Message 1',
        'Response 1',
      ])
      // Two recent, equal-weight messages produce a balanced strategy label.
      expect(result.strategy).toBe('balanced')
      // Total tokens equal the sum of the individual message estimates.
      expect(result.totalTokens).toBe(estTokens('Message 1') + estTokens('Response 1'))
    })

    it('calculates estimated cost', () => {
      const messages = [createDistinctMessage('c', 'user', 'Test message', 1000)]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })

      // Cost is derived deterministically from the counted tokens, not a stub.
      expect(result.totalTokens).toBe(estTokens('Test message'))
      expect(result.estimatedCost).toBeCloseTo(result.totalTokens * 0.000001 * 0.5, 12)
      expect(result.estimatedCost).toBeGreaterThan(0)
    })

    it('preserves distinct messages that do not have stable ids', () => {
      const messages = [
        {
          message: {
            role: 'user',
            content: 'Anonymous user message',
            created_at: 1000,
          },
          sender: 'user',
        },
        {
          message: {
            role: 'assistant',
            content: 'Anonymous assistant response',
            created_at: 2000,
          },
          sender: 'assistant',
        },
      ] as any[]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })

      expect(result.selectedMessages.map(m => m.message.content)).toEqual([
        'Anonymous user message',
        'Anonymous assistant response',
      ])
    })
  })

  describe('optimizeForCost', () => {
    it('returns messages within budget', () => {
      // 12 distinct 100-token messages, all recent (age < 24h) so they are
      // not cache-eligible and the fresh budget alone governs the core. budget
      // 0.4 -> maxTotalTokens 400, cacheWeight 0.7 / freshWeight 0.3. The last 5
      // messages are the always-preserved conversation tail; the remaining 7 are
      // "core" and must be trimmed to fit the budget-derived fresh target
      // (floor(400 * 0.3) = 120), which admits exactly one more 100-token message.
      const base = Date.now() + 50_000
      const messages = Array.from({ length: 12 }, (_, i) =>
        createDistinctMessage('c' + i, 'user', 'x'.repeat(400), base + i * 1000),
      )

      // optimizeForCost returns the selected Message[] directly.
      const selected = optimizeForCost(messages, 0.4)

      const tailIds = ['c7', 'c8', 'c9', 'c10', 'c11']
      const selectedIds = selected.map(m => m.message.id)

      // Over-budget core content is excluded: 12 in, 6 out (not all 12).
      expect(selected.length).toBe(6)
      expect(selected.length).toBeLessThan(messages.length)

      // The conversation tail (last 5) is always retained.
      for (const id of tailIds) {
        expect(selectedIds).toContain(id)
      }

      // Only one non-tail message survives the budget; the rest are dropped.
      const keptCore = selectedIds.filter(id => !tailIds.includes(id))
      expect(keptCore).toHaveLength(1)

      // The non-tail (budgeted) selection fits the budget-derived fresh target.
      const coreTokens = selected
        .filter(m => !tailIds.includes(m.message.id))
        .reduce((sum, m) => sum + estTokens(m.message.content), 0)
      expect(coreTokens).toBeLessThanOrEqual(Math.floor(Math.floor(0.4 * 1000) * 0.3))

      // Result is chronologically ordered.
      const createdAts = selected.map(m => m.message.created_at)
      expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b))
    })

    it('preserves all messages when the budget is generous', () => {
      // Same 12 messages, but a large budget admits the full conversation.
      const base = Date.now() + 50_000
      const messages = Array.from({ length: 12 }, (_, i) =>
        createDistinctMessage('c' + i, 'user', 'x'.repeat(400), base + i * 1000),
      )

      const selected = optimizeForCost(messages, 100)

      expect(selected).toHaveLength(messages.length)
      expect(selected.map(m => m.message.id).sort()).toEqual(
        messages.map(m => m.message.id).sort(),
      )
    })
  })

  describe('optimizeForAccuracy', () => {
    it('optimizes for accuracy with token limit', () => {
      const messages = [
        createDistinctMessage('a', 'user', 'Message 1', 1000),
        createDistinctMessage('b', 'assistant', 'Response 1', 2000),
      ]

      const result = optimizeForAccuracy(messages, 5000)

      // With ample headroom both messages are kept, in chronological order.
      expect(result.map(m => m.message.content)).toEqual(['Message 1', 'Response 1'])
    })
  })

  describe('getHybridStats', () => {
    it('returns statistics', () => {
      // Clearly recent (1h old) -> not cache-eligible -> all tokens land in fresh.
      const recent = Date.now() - 60 * 60 * 1000
      const messages = [
        createMessage('system', 'System', recent),
        createMessage('user', 'Hello', recent),
      ]

      const split = splitContext(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })
      const stats = getHybridStats(split)

      const expectedTotal = estTokens('System') + estTokens('Hello')
      expect(stats.totalTokens).toBe(expectedTotal)
      expect(stats.totalTokens).toBe(3)
      // Ratios are percentages of the split and sum to 100 when there are tokens.
      expect(stats.cacheRatio + stats.freshRatio).toBe(100)
      // Nothing is cache-eligible here, so the split is entirely fresh.
      expect(stats.cacheRatio).toBe(0)
      expect(stats.freshRatio).toBe(100)
      // messageCount reflects the cached + fresh message counts.
      expect(stats.messageCount).toBe(split.cached.length + split.fresh.length)
      expect(stats.messageCount).toBe(2)
    })
  })

  describe('tool_use/tool_result pairing', () => {
    it('preserves tool_use and tool_result together', () => {
      const toolUseId = 'tool-use-123'
      const messages = [
        {
          type: 'assistant',
          uuid: 'uuid-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: toolUseId, name: 'Read' }],
            id: 'msg-1',
            created_at: 1000,
          },
        },
        {
          type: 'user',
          uuid: 'uuid-2',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file content' }],
            id: 'msg-2',
            created_at: 2000,
          },
        },
        {
          type: 'assistant',
          uuid: 'uuid-3',
          message: {
            role: 'assistant',
            content: 'Response after tool',
            id: 'msg-3',
            created_at: 3000,
          },
        },
      ] as any[]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })

      const hasToolUse = result.selectedMessages.some(
        m => Array.isArray(m.message?.content) && m.message.content.some((b: any) => b.type === 'tool_use')
      )
      const hasToolResult = result.selectedMessages.some(
        m => Array.isArray(m.message?.content) && m.message.content.some((b: any) => b.type === 'tool_result')
      )

      expect(hasToolUse).toBe(true)
      expect(hasToolResult).toBe(true)
    })

    it('accounts for large tool_use input in token counting', () => {
      const largeInput = 'x'.repeat(5000)
      const messages = [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Edit', input: { path: 'test.js', content: largeInput } },
            ],
            created_at: 1000,
          },
        },
      ] as any[]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 20000,
      })

      expect(result.totalTokens).toBeGreaterThan(1000)
    })

    it('accounts for large thinking blocks in token counting', () => {
      const longThinking = 'Thinking '.repeat(1000)
      const messages = [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: longThinking },
              { type: 'text', text: 'Final response' },
            ],
            created_at: 1000,
          },
        },
      ] as any[]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 20000,
      })

      expect(result.totalTokens).toBeGreaterThan(500)
    })
  })
})
