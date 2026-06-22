import { describe, expect, it } from 'vitest'

import { LSPTool } from '../../../src/tools/LSPTool/LSPTool.js'
import {
  LSP_TOOL_OPERATIONS,
  lspToolInputSchema,
} from '../../../src/tools/LSPTool/schemas.js'

const baseInput = {
  filePath: 'src/example.ts',
  line: 1,
  character: 1,
} as const

describe('LSP tool schemas', () => {
  it('accepts every declared operation through both tool input schemas', () => {
    for (const operation of LSP_TOOL_OPERATIONS) {
      const input = { ...baseInput, operation }

      expect(lspToolInputSchema().safeParse(input).success).toBe(true)
      expect(LSPTool.inputSchema.safeParse(input).success).toBe(true)
    }
  })

  it('keeps line and character as positive 1-based editor positions', () => {
    const invalid = {
      ...baseInput,
      operation: 'goToDefinition',
      line: 0,
      character: 0,
    }

    expect(lspToolInputSchema().safeParse(invalid).success).toBe(false)
    expect(LSPTool.inputSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects operations outside the shared LSP operation list', () => {
    const invalid = {
      ...baseInput,
      operation: 'getDiagnostics',
    }

    expect(lspToolInputSchema().safeParse(invalid).success).toBe(false)
    expect(LSPTool.inputSchema.safeParse(invalid).success).toBe(false)
  })
})
