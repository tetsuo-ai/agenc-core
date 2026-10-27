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
      ...(row.expires === undefined ? {} : { expiration_date: row.expires }),
    })) }))
    // The generation day of the committed snapshot: rows retiring after it stay.
    const child = spawnSync(process.execPath, ['scripts/generate-openrouter-catalog.mjs', snapshot, directory], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, AGENC_CATALOG_DATE: '2026-10-20' },
    })
    expect(child.status, child.stderr).toBe(0)
    for (const name of ['openrouter-models.data.json', 'openrouter-pricing.data.json', 'openrouter-model-ids.ts']) {
      expect(await readFile(join(directory, name), 'utf8')).toBe(await readFile(join('src/llm/registry', name), 'utf8'))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('generation retains every advertised model and its retirement date', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-expiry-'))
  try {
    const listing = (id: string, expirationDate?: string) => ({
      id, name: id, context_length: 131072, top_provider: { max_completion_tokens: 8192 },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' },
      ...(expirationDate === undefined ? {} : { expiration_date: expirationDate }),
    })
    const snapshot = join(directory, 'snapshot.json')
    await writeFile(snapshot, JSON.stringify({ data: [
      listing('vendor/retired-in-october', '2026-10-01'),
      listing('vendor/retiring-later', '2026-11-30'),
      { ...listing('vendor/current'), supported_parameters: [] },
      { id: '~vendor/alias', architecture: { output_modalities: ['image'] } },
    ] }))
    const child = spawnSync(process.execPath, ['scripts/generate-openrouter-catalog.mjs', snapshot, directory], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, AGENC_CATALOG_DATE: '2026-10-20' },
    })
    expect(child.status, child.stderr).toBe(0)
    const rows = JSON.parse(await readFile(join(directory, 'openrouter-models.data.json'), 'utf8')) as
      Array<{ model: string; expires?: string }>
    // The provider's listing owns membership, including non-tool and media rows.
    expect(rows.map(row => row.model)).toEqual(['vendor/retired-in-october', 'vendor/retiring-later', 'vendor/current', '~vendor/alias'])
    expect(rows[1]?.expires).toBe('2026-11-30')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
