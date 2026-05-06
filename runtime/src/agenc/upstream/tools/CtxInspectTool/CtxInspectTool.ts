import { z } from 'zod/v4'
import {
  getContextCollapseCommits,
  getContextCollapseSnapshot,
  getContextVisualizationData,
  getStats,
  isContextCollapseEnabled,
} from '../../services/contextCollapse/index.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../../../utils/lazySchema.js'
import { jsonStringify } from '../../../../utils/slowOperations.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    include_persistence: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include persisted collapse commit and snapshot records.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
    stats: z.unknown(),
    visualization: z.unknown(),
    snapshot: z.unknown().optional(),
    commits: z.array(z.unknown()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const CtxInspectTool = buildTool({
  name: 'CtxInspect',
  searchHint: 'inspect context collapse state',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isContextCollapseEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'Inspect AgenC context collapse state.'
  },
  async prompt() {
    return [
      'Inspect AgenC context collapse state for debugging compaction and overflow recovery.',
      'Use this only when context-collapse diagnostics are explicitly needed.',
      'Set include_persistence to true to include the commit and snapshot records that resume recovery will restore.',
    ].join('\n')
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  toAutoClassifierInput() {
    return ''
  },
  async call({ include_persistence }) {
    const data: Output = {
      enabled: isContextCollapseEnabled(),
      stats: getStats(),
      visualization: getContextVisualizationData(),
      ...(include_persistence
        ? {
            snapshot: getContextCollapseSnapshot(),
            commits: getContextCollapseCommits(),
          }
        : {}),
    }
    return { data }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
