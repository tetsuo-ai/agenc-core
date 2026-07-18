import { expect, test } from 'bun:test'

import { applyPromptToMarkdown } from '../../../src/tools/WebFetchTool/utils.js'

async function runApply(
  markdown = 'Hello world.',
  signal?: AbortSignal,
): Promise<string> {
  const ctrl = new AbortController()
  return applyPromptToMarkdown(
    'summarize',
    markdown,
    signal ?? ctrl.signal,
    false,
    false,
  )
}

test('returns bounded raw markdown without a legacy secondary-model request', async () => {
  const output = await runApply('Gitlawb homepage content.')
  expect(output).toContain(
    'ADMISSION_DENIED: legacy_web_fetch_secondary_model_path_disabled',
  )
  expect(output).toContain('Gitlawb homepage content.')
})

test('truncates deterministic fallback content', async () => {
  const output = await runApply('x'.repeat(120_000))
  expect(output).toContain('[Content truncated due to length...]')
  expect(output.length).toBeLessThan(120_000)
})

test('propagates caller cancellation before producing fallback content', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  await expect(runApply('content', ctrl.signal)).rejects.toThrow()
})
