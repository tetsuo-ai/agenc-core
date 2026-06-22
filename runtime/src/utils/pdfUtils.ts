import { getMainLoopModel } from './model/model.js'
export { parsePDFPageRange, type PDFPageRange } from './pdfPageRange.js'

// Document extensions that are handled specially
export const DOCUMENT_EXTENSIONS = new Set(['pdf'])

/**
 * Check if PDF reading is supported with the current model.
 * PDF document blocks work on all providers (1P, Vertex, Bedrock, Foundry).
 * Haiku 3 is the only remaining model that predates PDF support; users on
 * it fall back to the page-extraction path (poppler-utils). Substring match
 * covers all provider ID formats (Bedrock prefixes, Vertex @-dates).
 */
export function isPDFSupported(): boolean {
  return !getMainLoopModel().toLowerCase().includes('claude-3-haiku')
}

/**
 * Check if a file extension is a PDF document.
 * @param ext File extension (with or without leading dot)
 */
export function isPDFExtension(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.slice(1) : ext
  return DOCUMENT_EXTENSIONS.has(normalized.toLowerCase())
}
