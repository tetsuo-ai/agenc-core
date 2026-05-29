/**
 * Logs file operation analytics.
 *
 * Analytics has been removed; this is now a no-op retained for call-site
 * compatibility (FileWriteTool).
 */
export function logFileOperation(_params: {
  operation: 'read' | 'write' | 'edit'
  tool: 'FileReadTool' | 'FileWriteTool' | 'FileEditTool'
  filePath: string
  content?: string
  type?: 'create' | 'update'
}): void {}
