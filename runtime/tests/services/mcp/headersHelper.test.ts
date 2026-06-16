import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

const headerHelperMocks = vi.hoisted(() => ({
  execFileNoThrowWithCwd: vi.fn(),
}))

vi.mock('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrowWithCwd: headerHelperMocks.execFileNoThrowWithCwd,
}))

vi.mock('../../utils/log.js', () => ({
  logError: vi.fn(),
  logMCPDebug: vi.fn(),
  logMCPError: vi.fn(),
}))

vi.mock('src/utils/debug.js', () => ({
  logAntError: vi.fn(),
}))

import { getMcpServerHeaders } from './headersHelper.js'
import { parseHeaders } from './utils.js'

afterEach(() => {
  vi.clearAllMocks()
})

function httpConfig(
  overrides: Partial<Parameters<typeof getMcpServerHeaders>[1]> = {},
): Parameters<typeof getMcpServerHeaders>[1] {
  return {
    type: 'http',
    url: 'https://example.test/mcp',
    ...overrides,
  }
}

test('getMcpServerHeaders merges validated static and helper headers', async () => {
  headerHelperMocks.execFileNoThrowWithCwd.mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({
      Authorization: 'Bearer dynamic',
      'X-Helper': 'yes',
    }),
    stderr: '',
  })

  const headers = await getMcpServerHeaders(
    'docs',
    httpConfig({
      headers: {
        Authorization: 'Bearer static',
        'X-Static': 'yes',
      },
      headersHelper: 'helper',
    }),
  )

  assert.deepEqual(headers, {
    Authorization: 'Bearer dynamic',
    'X-Static': 'yes',
    'X-Helper': 'yes',
  })
})

test('getMcpServerHeaders ignores helper headers with invalid names', async () => {
  headerHelperMocks.execFileNoThrowWithCwd.mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ 'Bad Header': 'value' }),
    stderr: '',
  })

  const headers = await getMcpServerHeaders(
    'docs',
    httpConfig({ headersHelper: 'helper' }),
  )

  assert.deepEqual(headers, {})
})

test('getMcpServerHeaders ignores helper headers with control characters', async () => {
  headerHelperMocks.execFileNoThrowWithCwd.mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({
      Authorization: 'Bearer token\r\nX-Evil: 1',
    }),
    stderr: '',
  })

  const headers = await getMcpServerHeaders(
    'docs',
    httpConfig({
      headers: { 'X-Static': 'yes' },
      headersHelper: 'helper',
    }),
  )

  assert.deepEqual(headers, { 'X-Static': 'yes' })
})

test('getMcpServerHeaders ignores helper headers that exceed the count cap', async () => {
  const manyHeaders = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`X-Test-${index}`, 'value']),
  )
  headerHelperMocks.execFileNoThrowWithCwd.mockResolvedValue({
    code: 0,
    stdout: JSON.stringify(manyHeaders),
    stderr: '',
  })

  const headers = await getMcpServerHeaders(
    'docs',
    httpConfig({ headersHelper: 'helper' }),
  )

  assert.deepEqual(headers, {})
})

test('getMcpServerHeaders rejects invalid static headers', async () => {
  await assert.rejects(
    () =>
      getMcpServerHeaders(
        'docs',
        httpConfig({ headers: { 'Bad Header': 'value' } }),
      ),
    /invalid header name/,
  )
})

test('parseHeaders rejects invalid names and control characters', () => {
  assert.throws(() => parseHeaders(['Bad Header: value']), /invalid header name/)
  assert.throws(
    () => parseHeaders(['Authorization: Bearer token\r\nX-Evil: 1']),
    /control characters/,
  )
})

test('parseHeaders rejects duplicate header names by case-insensitive match', () => {
  assert.throws(
    () => parseHeaders(['Authorization: Bearer one', 'authorization: Bearer two']),
    /duplicate header name/,
  )
})

test('parseHeaders rejects header count and size caps', () => {
  assert.throws(
    () =>
      parseHeaders(
        Array.from({ length: 65 }, (_, index) => [`X-Test-${index}: value`]).flat(),
      ),
    /too many headers/,
  )
  assert.throws(() => parseHeaders([`${'X'.repeat(129)}: value`]), /exceeds 128/)
  assert.throws(
    () => parseHeaders([`Authorization: ${'x'.repeat(8193)}`]),
    /exceeds 8192/,
  )
})
