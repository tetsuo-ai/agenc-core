import { afterEach, expect, test } from 'vitest';
import { compactConversation, retainedUserPromptIndexes } from '../../../src/services/compact/compact.js';
import { createCompactionTransactionHarness, type CompactionTransactionHarness } from '../../helpers/compaction-transaction-harness.js';
import type { RuntimeMessage } from '../../../src/services/compact/types.js';

let harness: CompactionTransactionHarness | undefined;
afterEach(() => { harness?.close(); harness = undefined; });

test('a first prompt over the retention cap does not exclude small recent corrections', () => {
  const messages: RuntimeMessage[] = [
    { role: 'user', runtimeOnly: { userMessageId: 'submitted' }, content: 'large original task '.repeat(100) },
    { role: 'assistant', content: 'work' },
    { role: 'user', runtimeOnly: { userMessageId: 'submitted' }, content: 'Use the staging endpoint only.' },
    { role: 'assistant', content: 'work' },
  ];
  expect([...retainedUserPromptIndexes(messages, 4, 100)]).toEqual([2]);
});

test('automatic compaction retains recent corrections when the original task exceeds 64 KiB', async () => {
  const correction = 'CORRECTION: use the staging endpoint only; never deploy to production.';
  const messages: RuntimeMessage[] = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    ...(index % 2 === 0 ? { runtimeOnly: { userMessageId: `prompt-${index}` } } : {}),
    content: index === 0 ? 'original task detail '.repeat(3500)
      : index === 20 ? correction
      : index % 2 === 0 ? `next step ${index}` : `work-${index}:${'x'.repeat(3000)}`,
  }));
  harness = createCompactionTransactionHarness(messages, {
    sessionId: 'cr11-retention-large-first', contextWindowTokens: 200000, compactionMode: 'automatic',
  });
  const result = await compactConversation(messages, harness.context);
  expect(result.transaction).toBeDefined();
  const committed = harness.store.readAll().find(item => item.type === 'compaction_committed') as any;
  const texts = committed.payload.replacement_history.map((message: any) => message.content);
  expect(texts).toContain(correction);
});
