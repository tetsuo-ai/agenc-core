/**
 * Hardcoded GitHub Copilot model registry from models.dev/api.json.
 */

export type CopilotModel = {
  id: string
  name: string
  family: string
  attachment: boolean
  reasoning: boolean
  tool_call: boolean
  temperature: boolean
  knowledge: string
  release_date: string
  last_updated: string
  modalities: {
    input: string[]
    output: string[]
  }
  open_weights: boolean
  cost: {
    input: number
    output: number
    cache_read?: number
  }
  limit: {
    context: number
    input?: number
    output: number
  }
}

type CopilotModelDefaults = Omit<CopilotModel, 'id' | 'name' | 'family'>

type CopilotModelDefinition = Pick<CopilotModel, 'name' | 'family'> &
  Partial<Omit<CopilotModelDefaults, 'cost' | 'limit' | 'modalities'>> & {
    cost?: Partial<CopilotModel['cost']>
    limit?: Partial<CopilotModel['limit']>
    modalities?: CopilotModel['modalities']
  }

const COPILOT_MODEL_DEFAULTS: CopilotModelDefaults = {
  attachment: false,
  reasoning: true,
  tool_call: true,
  temperature: true,
  knowledge: '2025-05',
  release_date: '2025-05-01',
  last_updated: '2025-05-01',
  modalities: { input: ['text'], output: ['text'] },
  open_weights: false,
  cost: { input: 0, output: 0 },
  limit: { context: 400000, output: 32768 },
}

const COPILOT_MODEL_DEFINITIONS = [
  ['gpt-5.5', { name: 'GPT-5.5', family: 'gpt' }],
  ['gpt-5.5-mini', { name: 'GPT-5.5 mini', family: 'gpt-mini' }],
  ['gpt-5.4', { name: 'GPT-5.4', family: 'gpt' }],
  ['gpt-5.4-mini', { name: 'GPT-5.4 mini', family: 'gpt-mini' }],
  ['gpt-5.3-codex', { name: 'GPT-5.3 coding', family: 'gpt-coding' }],
  ['gpt-5.2-codex', { name: 'GPT-5.2 coding', family: 'gpt-coding' }],
  [
    'gpt-5.2',
    {
      name: 'GPT-5.2',
      family: 'gpt',
      limit: { context: 264000 },
    },
  ],
  ['gpt-5.1-codex', { name: 'GPT-5.1 coding', family: 'gpt-coding' }],
  ['gpt-5.1-codex-max', { name: 'GPT-5.1 coding max', family: 'gpt-coding' }],
  [
    'gpt-5.1-codex-mini',
    { name: 'GPT-5.1 coding mini', family: 'gpt-coding' },
  ],
  [
    'gpt-4o',
    {
      name: 'GPT-4o',
      family: 'gpt',
      attachment: true,
      reasoning: false,
      knowledge: '2023-10',
      release_date: '2024-05-01',
      last_updated: '2024-05-01',
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 128000, output: 16384 },
    },
  ],
  [
    'gpt-4.1',
    {
      name: 'GPT-4.1',
      family: 'gpt',
      reasoning: false,
      knowledge: '2024-06',
      release_date: '2024-06-01',
      last_updated: '2024-06-01',
      limit: { context: 128000 },
    },
  ],
  [
    'claude-opus-4.6',
    {
      name: 'AgenC Opus 4.6',
      family: 'claude-opus',
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 144000 },
    },
  ],
  [
    'claude-opus-4.5',
    {
      name: 'AgenC Opus 4.5',
      family: 'claude-opus',
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 160000 },
    },
  ],
  [
    'claude-sonnet-4.6',
    {
      name: 'AgenC Sonnet 4.6',
      family: 'claude-sonnet',
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 200000 },
    },
  ],
  [
    'claude-sonnet-4.5',
    {
      name: 'AgenC Sonnet 4.5',
      family: 'claude-sonnet',
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 144000 },
    },
  ],
  [
    'claude-haiku-4.5',
    {
      name: 'AgenC Haiku 4.5',
      family: 'claude-haiku',
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 144000 },
    },
  ],
  [
    'gemini-3.1-pro-preview',
    {
      name: 'Gemini 3.1 Pro Preview',
      family: 'gemini-pro',
      attachment: true,
      modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
      limit: { context: 128000 },
    },
  ],
  [
    'gemini-3-flash-preview',
    {
      name: 'Gemini 3 Flash',
      family: 'gemini-flash',
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 128000 },
    },
  ],
  [
    'gemini-2.5-pro',
    {
      name: 'Gemini 2.5 Pro',
      family: 'gemini-pro',
      attachment: true,
      reasoning: false,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 128000 },
    },
  ],
  [
    'grok-code-fast-1',
    {
      name: 'Grok Code Fast 1',
      family: 'grok',
      limit: { context: 128000 },
    },
  ],
] as const satisfies readonly (readonly [string, CopilotModelDefinition])[]

function cloneModalities(
  modalities: CopilotModel['modalities'],
): CopilotModel['modalities'] {
  return {
    input: [...modalities.input],
    output: [...modalities.output],
  }
}

function buildCopilotModel(
  id: string,
  definition: CopilotModelDefinition,
): CopilotModel {
  return {
    id,
    name: definition.name,
    family: definition.family,
    attachment: definition.attachment ?? COPILOT_MODEL_DEFAULTS.attachment,
    reasoning: definition.reasoning ?? COPILOT_MODEL_DEFAULTS.reasoning,
    tool_call: definition.tool_call ?? COPILOT_MODEL_DEFAULTS.tool_call,
    temperature: definition.temperature ?? COPILOT_MODEL_DEFAULTS.temperature,
    knowledge: definition.knowledge ?? COPILOT_MODEL_DEFAULTS.knowledge,
    release_date:
      definition.release_date ?? COPILOT_MODEL_DEFAULTS.release_date,
    last_updated: definition.last_updated ?? COPILOT_MODEL_DEFAULTS.last_updated,
    modalities: cloneModalities(
      definition.modalities ?? COPILOT_MODEL_DEFAULTS.modalities,
    ),
    open_weights:
      definition.open_weights ?? COPILOT_MODEL_DEFAULTS.open_weights,
    cost: {
      ...COPILOT_MODEL_DEFAULTS.cost,
      ...definition.cost,
    },
    limit: {
      ...COPILOT_MODEL_DEFAULTS.limit,
      ...definition.limit,
    },
  }
}

function buildCopilotModels(): Record<string, CopilotModel> {
  const models: Record<string, CopilotModel> = {}

  for (const [id, definition] of COPILOT_MODEL_DEFINITIONS) {
    if (models[id]) {
      throw new Error(`Duplicate Copilot model id: ${id}`)
    }

    models[id] = buildCopilotModel(id, definition)
  }

  return models
}

export const COPILOT_MODELS: Record<string, CopilotModel> = buildCopilotModels()

export function getCopilotModelIds(): string[] {
  return Object.keys(COPILOT_MODELS)
}

export function getCopilotModel(id: string): CopilotModel | undefined {
  return COPILOT_MODELS[id]
}

export function getAllCopilotModels(): CopilotModel[] {
  return Object.values(COPILOT_MODELS)
}
