import { describe, expect, it } from 'vitest'

import { getCachedNvidiaNimModelOptions } from '../../../src/utils/model/nvidiaNimModels.js'

describe('NVIDIA NIM model options', () => {
  it('exposes each picker model value once', () => {
    const options = getCachedNvidiaNimModelOptions()
    const values = options.map(option => option.value)

    expect(new Set(values).size).toBe(values.length)
    expect(
      values.filter(
        value => value === 'mistralai/mixtral-8x22b-instruct-v0.1',
      ),
    ).toHaveLength(1)
  })

  it('preserves selected model category metadata', () => {
    const options = getCachedNvidiaNimModelOptions()

    expect(options[0]).toEqual({
      value: 'nvidia/cosmos-reason2-8b',
      label: 'Cosmos Reason 2 8B',
      description: 'Reasoning',
    })
    expect(
      options.find(
        option => option.value === 'mistralai/mathstral-7b-v0.1',
      ),
    ).toMatchObject({ description: 'Math' })
    expect(
      options.find(
        option =>
          option.value === 'mistralai/devstral-2-123b-instruct-2512',
      ),
    ).toMatchObject({ description: 'Code' })
  })

  it('keeps model option caching stable', () => {
    expect(getCachedNvidiaNimModelOptions()).toBe(
      getCachedNvidiaNimModelOptions(),
    )
  })
})
