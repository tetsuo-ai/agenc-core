import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  allowPermissionDecision,
  rejectPermissionDecision,
  XaiAcpClient,
  type XaiAcpPermissionRequest,
} from '../../../src/services/xai/acp.ts'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-acp-agent.mjs',
)

function makeClient(options?: {
  env?: NodeJS.ProcessEnv
  onPermissionRequest?: (
    request: XaiAcpPermissionRequest,
  ) => { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
  requestTimeoutMs?: number
  promptTimeoutMs?: number
}): XaiAcpClient {
  return new XaiAcpClient({
    command: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: { ...process.env, ...options?.env },
    ...(options?.onPermissionRequest !== undefined
      ? { onPermissionRequest: options.onPermissionRequest }
      : {}),
    ...(options?.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options?.promptTimeoutMs !== undefined
      ? { promptTimeoutMs: options.promptTimeoutMs }
      : {}),
  })
}

describe('XaiAcpClient', () => {
  test('initialize → authenticate → session → prompt with streamed chunks', async () => {
    const client = makeClient()
    try {
      const init = await client.initialize()
      expect(init.authMethods).toContain('cached_token')

      await client.authenticate('cached_token')

      const session = await client.newSession()
      expect(session.sessionId).toBe('mock-session-1')
      expect(session.currentModelId).toBe('grok-build')
      expect(session.availableModels.map(m => m.modelId)).toContain(
        'grok-composer-2.5-fast',
      )

      await client.setSessionModel(session.sessionId, 'grok-composer-2.5-fast')

      const chunks: string[] = []
      const result = await client.prompt({
        sessionId: session.sessionId,
        text: 'hi',
        onTextChunk: chunk => chunks.push(chunk),
      })
      expect(result.stopReason).toBe('end_turn')
      expect(result.text).toBe('[grok-composer-2.5-fast] Hello world')
      expect(chunks.length).toBeGreaterThanOrEqual(3)
    } finally {
      client.dispose()
    }
  })

  test('permission requests reach the handler and the decision is applied', async () => {
    const seen: XaiAcpPermissionRequest[] = []
    const client = makeClient({
      env: { FAKE_ACP_REQUEST_PERMISSION: '1' },
      onPermissionRequest: request => {
        seen.push(request)
        return allowPermissionDecision(request)
      },
    })
    try {
      await client.initialize()
      await client.authenticate('cached_token')
      const session = await client.newSession()
      const result = await client.prompt({ sessionId: session.sessionId, text: 'hi' })
      expect(seen).toHaveLength(1)
      expect(seen[0].options.map(o => o.kind)).toEqual(['allow_once', 'reject_once'])
      expect(result.text).toContain('perm=selected:allow')
    } finally {
      client.dispose()
    }
  })

  test('default permission policy rejects', async () => {
    const client = makeClient({ env: { FAKE_ACP_REQUEST_PERMISSION: '1' } })
    try {
      await client.initialize()
      await client.authenticate('cached_token')
      const session = await client.newSession()
      const result = await client.prompt({ sessionId: session.sessionId, text: 'hi' })
      expect(result.text).toContain('perm=selected:reject')
    } finally {
      client.dispose()
    }
  })

  test('agent auth errors surface as typed agent_error', async () => {
    const client = makeClient({ env: { FAKE_ACP_FAIL_AUTH: '1' } })
    try {
      await client.initialize()
      await expect(client.authenticate('cached_token')).rejects.toMatchObject({
        code: 'agent_error',
        rpcCode: -32000,
      })
    } finally {
      client.dispose()
    }
  })

  test('missing binary fails with a helpful spawn error', async () => {
    const client = new XaiAcpClient({
      command: 'definitely-not-a-real-grok-binary',
      cwd: process.cwd(),
    })
    try {
      await expect(client.initialize()).rejects.toMatchObject({
        code: expect.stringMatching(/spawn_failed|closed/),
      })
    } finally {
      client.dispose()
    }
  })

  test('prompt timeout produces a typed timeout error', async () => {
    const client = makeClient({
      env: { FAKE_ACP_STALL_PROMPT: '1' },
      promptTimeoutMs: 300,
    })
    try {
      await client.initialize()
      await client.authenticate('cached_token')
      const session = await client.newSession()
      await expect(
        client.prompt({ sessionId: session.sessionId, text: 'hi' }),
      ).rejects.toMatchObject({ code: 'timeout' })
    } finally {
      client.dispose()
    }
  })
})

describe('permission decision helpers', () => {
  const request: XaiAcpPermissionRequest = {
    sessionId: 's',
    options: [
      { optionId: 'a1', kind: 'allow_once' },
      { optionId: 'aa', kind: 'allow_always' },
      { optionId: 'r1', kind: 'reject_once' },
    ],
    raw: {},
  }

  test('reject prefers reject_once, falls back to cancelled', () => {
    expect(rejectPermissionDecision(request)).toEqual({
      outcome: 'selected',
      optionId: 'r1',
    })
    expect(
      rejectPermissionDecision({ sessionId: 's', options: [], raw: {} }),
    ).toEqual({ outcome: 'cancelled' })
  })

  test('allow prefers allow_once', () => {
    expect(allowPermissionDecision(request)).toEqual({
      outcome: 'selected',
      optionId: 'a1',
    })
  })
})
