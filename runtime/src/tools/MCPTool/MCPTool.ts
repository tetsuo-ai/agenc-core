import { Ajv } from 'ajv'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from '../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../types/permissions.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import type { MCPToolResult } from '../../utils/mcpValidation.js'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
// Allow any input object since MCP tools define their own schemas
export const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

// MCP tools can return either a plain string or an array of content blocks
// (text, images, etc.). The outputSchema must reflect both shapes so the model
// knows rich content is possible.
const outputSchema = lazySchema(() =>
  z.union([
    z.string().describe('MCP tool execution result as text'),
    z
      .array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
        }),
      )
      .describe('MCP tool execution result as content blocks'),
  ]),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// The result content that actually flows through the renderer / serializer at
// runtime is the richer MCP content shape (string or Anthropic ContentBlockParam[]),
// not just the narrow Zod-inferred Output. Use it as the ToolDef result type so the
// render/map signatures line up with their implementations in UI.tsx / mcpValidation.ts.
type ResultContent = NonNullable<MCPToolResult>

// Re-export MCPProgress from centralized types to break import cycles
export type { MCPProgress } from '../../types/tools.js'

const ajv = new Ajv({ strict: false })

// Cache compiled validators to avoid recompiling on every validateInput call.
// AJV compilation is expensive — schemas don't change between calls.
// Uses WeakMap to allow garbage collection of schemas from disconnected/refreshed
// MCP tools, preventing memory leaks from accumulating strong references.
const compiledValidatorCache = new WeakMap<object, ReturnType<typeof ajv.compile>>()

function getCompiledValidator(schema: object) {
  let validator = compiledValidatorCache.get(schema)
  if (!validator) {
    validator = ajv.compile(schema)
    compiledValidatorCache.set(schema, validator)
  }
  return validator
}
export const MCPTool = buildTool({
  isMcp: true,
  // Overridden in mcpClient.ts with the real MCP tool name + args
  isOpenWorld() {
    return false
  },
  // Overridden in mcpClient.ts
  name: 'mcp',
  maxResultSizeChars: 100_000,
  // Overridden in mcpClient.ts
  async description() {
    return DESCRIPTION
  },
  // Overridden in mcpClient.ts
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // Overridden in mcpClient.ts
  async call() {
    return {
      data: '',
    }
  },
  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
    }
  },
  async validateInput(input, _context): Promise<ValidationResult> {
    if (this.inputJSONSchema) {
      try {
        const validate = getCompiledValidator(this.inputJSONSchema)
        if (!validate(input)) {
          return {
            result: false,
            message: ajv.errorsText(validate.errors),
            errorCode: 400,
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          result: false,
          message: `Failed to compile JSON schema for validation: ${errMsg}`,
          errorCode: 500,
        }
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  // Overridden in mcpClient.ts
  userFacingName: () => 'mcp',
  renderToolUseProgressMessage,
  renderToolResultMessage,
  isResultTruncated(output: ResultContent): boolean {
    if (typeof output === 'string') {
      return isOutputLineTruncated(output)
    }
    // Array of content blocks — check if any text block exceeds the display limit
    if (Array.isArray(output)) {
      return output.some(
        block =>
          block != null &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          isOutputLineTruncated(block.text),
      )
    }
    return false
  },
  mapToolResultToToolResultBlockParam(content, toolUseID): ToolResultBlockParam {
    // Defensive guard: if content is undefined/null (shouldn't happen after
    // the abort path fix in client.ts), return a clear indicator rather than
    // sending undefined to the API which would cause an error.
    if (content === undefined || content === null) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: '[No content returned from MCP tool]',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      // MCP content blocks are dynamic provider JSON (ContentBlockParam[]),
      // a wider union than the tool_result content type accepts. At runtime
      // MCP only emits text/image blocks, which are valid here — narrow cast.
      content: content as ToolResultBlockParam['content'],
    }
  },
} satisfies ToolDef<InputSchema, ResultContent>)
