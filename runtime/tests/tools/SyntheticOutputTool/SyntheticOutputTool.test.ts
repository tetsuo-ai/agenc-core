import { describe, expect, it } from 'vitest'
import {
  SyntheticOutputTool,
  createSyntheticOutputTool,
} from './SyntheticOutputTool.js'

describe('SyntheticOutputTool', () => {
  it('rejects direct calls to the unbound singleton', async () => {
    await expect(SyntheticOutputTool.call({ ok: true })).rejects.toThrow(
      'createSyntheticOutputTool(jsonSchema)',
    )
  })

  it('accepts schema-bound output that satisfies the JSON schema', async () => {
    const schema = {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['ok'],
      additionalProperties: false,
    }
    const built = createSyntheticOutputTool(schema)
    expect('tool' in built).toBe(true)
    if (!('tool' in built)) throw new Error('expected structured output tool')

    const result = await built.tool.call({ ok: true, reason: 'done' })

    expect(result.data).toBe('Structured output provided successfully')
    expect(result.structured_output).toEqual({ ok: true, reason: 'done' })
  })

  it('rejects schema-bound output that does not satisfy the JSON schema', async () => {
    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
      },
      required: ['score'],
      additionalProperties: false,
    }
    const built = createSyntheticOutputTool(schema)
    if (!('tool' in built)) throw new Error('expected structured output tool')

    await expect(built.tool.call({ score: 101 })).rejects.toThrow(
      'Output does not match required schema',
    )
    await expect(built.tool.call({ score: 10, extra: true })).rejects.toThrow(
      'Output does not match required schema',
    )
  })

  it('reports invalid JSON schemas before a tool is exposed', () => {
    const built = createSyntheticOutputTool({ type: 'not-a-json-schema-type' })

    expect('error' in built).toBe(true)
    if (!('error' in built)) throw new Error('expected schema error')
    expect(built.error.length).toBeGreaterThan(0)
  })

  it('caches schema-bound tools by schema object identity', () => {
    const schema = { type: 'object' }
    const first = createSyntheticOutputTool(schema)
    const second = createSyntheticOutputTool(schema)
    const distinct = createSyntheticOutputTool({ type: 'object' })

    expect(first).toBe(second)
    expect(distinct).not.toBe(first)
  })
})
