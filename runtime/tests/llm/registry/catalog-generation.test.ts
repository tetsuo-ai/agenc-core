import { expect, test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { OPENROUTER_MODEL_IDS } from '../../../src/llm/registry/openrouter-model-ids.js'
import { OPENROUTER_PRICING } from '../../../src/llm/registry/openrouter-pricing.js'
import { OPENROUTER_MODELS } from '../../../src/llm/registry/openrouter-models.js'

test('offline regeneration preserves the complete snapshot and both authority projections', async () => {
  expect(OPENROUTER_MODEL_IDS).toEqual(OPENROUTER_MODELS.map(row => row.model))
  expect(OPENROUTER_PRICING).toEqual(OPENROUTER_MODELS.map(({ model, pricing, priceOverrides }) => ({
    model, pricing, ...(priceOverrides === undefined ? {} : { priceOverrides }),
  })))
  const directory = await mkdtemp(join(tmpdir(), 'catalog-generation-'))
  try {
    const snapshot = join(directory, 'snapshot.json')
    await writeFile(snapshot, JSON.stringify({ data: OPENROUTER_MODELS.map(row => ({
      id: row.model, name: row.label, context_length: row.context,
      top_provider: { max_completion_tokens: row.output },
      architecture: { input_modalities: row.modalities, output_modalities: ['text'] },
      supported_parameters: row.parameters,
      reasoning: { supported_efforts: row.efforts, default_effort: row.defaultEffort },
      pricing: { ...row.pricing, overrides: row.priceOverrides },
    })) }))
    const child = spawnSync(process.execPath, ['scripts/generate-openrouter-catalog.mjs', snapshot, directory], {
      encoding: 'utf8', timeout: 30000,
    })
    expect(child.status, child.stderr).toBe(0)
    for (const name of ['openrouter-models.data.json', 'openrouter-pricing.data.json', 'openrouter-model-ids.ts']) {
      expect(await readFile(join(directory, name), 'utf8')).toBe(await readFile(join('src/llm/registry', name), 'utf8'))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
