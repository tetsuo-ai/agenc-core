import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

export const LSP_TOOL_OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const

export type LSPToolOperation = (typeof LSP_TOOL_OPERATIONS)[number]

const filePathSchema = z
  .string()
  .describe('The absolute or relative path to the file')

const oneBasedLineSchema = z
  .number()
  .int()
  .positive()
  .describe('The line number (1-based, as shown in editors)')

const oneBasedCharacterSchema = z
  .number()
  .int()
  .positive()
  .describe('The character offset (1-based, as shown in editors)')

export const LSP_POSITION_INPUT_FIELDS = {
  filePath: filePathSchema,
  line: oneBasedLineSchema,
  character: oneBasedCharacterSchema,
} as const

function positionOperationSchema<TOperation extends LSPToolOperation>(
  operation: TOperation,
) {
  return z.strictObject({
    operation: z.literal(operation),
    ...LSP_POSITION_INPUT_FIELDS,
  })
}

/**
 * Discriminated union of all LSP operations
 * Uses 'operation' as the discriminator field
 */
export const lspToolInputSchema = lazySchema(() => {
  /**
   * Go to Definition operation
   * Finds the definition location of a symbol at the given position
   */
  const goToDefinitionSchema = positionOperationSchema('goToDefinition')

  /**
   * Find References operation
   * Finds all references to a symbol at the given position
   */
  const findReferencesSchema = positionOperationSchema('findReferences')

  /**
   * Hover operation
   * Gets hover information (documentation, type info) for a symbol at the given position
   */
  const hoverSchema = positionOperationSchema('hover')

  /**
   * Document Symbol operation
   * Gets all symbols (functions, classes, variables) in a document
   */
  const documentSymbolSchema = positionOperationSchema('documentSymbol')

  /**
   * Workspace Symbol operation
   * Searches for symbols across the entire workspace
   */
  const workspaceSymbolSchema = positionOperationSchema('workspaceSymbol')

  /**
   * Go to Implementation operation
   * Finds the implementation locations of an interface or abstract method
   */
  const goToImplementationSchema = positionOperationSchema('goToImplementation')

  /**
   * Prepare Call Hierarchy operation
   * Prepares a call hierarchy item at the given position (first step for call hierarchy)
   */
  const prepareCallHierarchySchema = positionOperationSchema(
    'prepareCallHierarchy',
  )

  /**
   * Incoming Calls operation
   * Finds all functions/methods that call the function at the given position
   */
  const incomingCallsSchema = positionOperationSchema('incomingCalls')

  /**
   * Outgoing Calls operation
   * Finds all functions/methods called by the function at the given position
   */
  const outgoingCallsSchema = positionOperationSchema('outgoingCalls')

  return z.discriminatedUnion('operation', [
    goToDefinitionSchema,
    findReferencesSchema,
    hoverSchema,
    documentSymbolSchema,
    workspaceSymbolSchema,
    goToImplementationSchema,
    prepareCallHierarchySchema,
    incomingCallsSchema,
    outgoingCallsSchema,
  ])
})

/**
 * TypeScript type for LSPTool input
 */
export type LSPToolInput = z.infer<ReturnType<typeof lspToolInputSchema>>
