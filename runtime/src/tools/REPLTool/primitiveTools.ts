import type { Tool } from '../Tool.js'
import {
  CanonicalBashTool,
  CanonicalFileEditTool,
  CanonicalFileReadTool,
  CanonicalFileWriteTool,
  CanonicalGlobTool,
  CanonicalGrepTool,
  CanonicalNotebookEditTool,
} from '../canonicalToolSurface.js'

let _primitiveTools: readonly Tool[] | undefined

/**
 * Primitive tools hidden from direct model use when REPL mode is on
 * (REPL_ONLY_TOOLS) but still accessible inside the REPL VM context.
 * Exported so display-side code (collapseReadSearch, renderers) can
 * classify/render virtual messages for these tools even when they're
 * absent from the filtered execution tools list.
 *
 * Lazy getter — the import chain collapseReadSearch.ts → primitiveTools.ts
 * → FileReadTool.tsx → ... loops back through the tool registry, so a
 * top-level const hits "Cannot access before initialization". Deferring
 * to call time avoids the TDZ.
 *
 * Referenced directly rather than via getAllBaseTools() because that
 * excludes Glob/Grep when hasEmbeddedSearchTools() is true.
 */
export function getReplPrimitiveTools(): readonly Tool[] {
  return (_primitiveTools ??= [
    CanonicalFileReadTool,
    CanonicalFileWriteTool,
    CanonicalFileEditTool,
    CanonicalGlobTool,
    CanonicalGrepTool,
    CanonicalBashTool,
    CanonicalNotebookEditTool,
  ])
}
