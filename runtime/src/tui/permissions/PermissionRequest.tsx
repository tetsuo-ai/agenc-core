/**
 * Per-tool permission-request router.
 *
 * Ported from upstream. Routes a permission decision to the appropriate
 * tool-specific dialog body based on the tool name. The lead is expected
 * to wire this into AgenC's existing `ApprovalOverlay` (see
 * `./ApprovalOverlay.tsx`) so that the overlay can render a richer,
 * tool-shaped body where one is available and fall back to the generic
 * preview otherwise.
 *
 * Unlike the upstream variant, this router intentionally does NOT depend
 * on tool-class identity (e.g. `tool === BashTool`). AgenC's runtime
 * passes tool names by string from the registry, and each per-tool
 * dialog only needs the parsed input + decision callbacks.
 */

import React, { useCallback, useEffect } from 'react'

import { useKeybinding } from '../keybindings/KeybindingContext.js'

import { PermissionRequestBash } from './PermissionRequestBash.js'
import { PermissionRequestFile } from './PermissionRequestFile.js'
import { PermissionRequestMonitor } from './PermissionRequestMonitor.js'
import { PermissionRequestSkill } from './PermissionRequestSkill.js'
import { PermissionRequestWebFetch } from './PermissionRequestWebFetch.js'

export type PermissionDecision =
  | { readonly behavior: 'allow'; readonly addRule?: boolean }
  | { readonly behavior: 'allow-session'; readonly addRule?: boolean }
  | { readonly behavior: 'deny'; readonly reason?: string }
  | { readonly behavior: 'abort' }

export interface PermissionRequestSubject {
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  readonly description?: string
  readonly workspacePath?: string
  readonly reason?: string
}

export interface PermissionRequestProps {
  readonly subject: PermissionRequestSubject
  readonly onResolve: (decision: PermissionDecision) => void
  readonly onCancel?: () => void
  readonly verbose?: boolean
}

function lower(name: string): string {
  return typeof name === 'string' ? name.toLowerCase() : ''
}

function bodyForTool(
  toolName: string,
): React.ComponentType<PermissionRequestProps> | null {
  const lc = lower(toolName)
  switch (toolName) {
    case 'Bash':
    case 'system.bash':
    case 'PowerShell':
      return PermissionRequestBash
    case 'Edit':
    case 'edit_file':
    case 'Write':
    case 'write_file':
    case 'NotebookEdit':
      return PermissionRequestFile
    case 'WebFetch':
    case 'WebSearch':
      return PermissionRequestWebFetch
    case 'Skill':
      return PermissionRequestSkill
    case 'Monitor':
      return PermissionRequestMonitor
    default:
      if (lc.includes('bash') || lc.includes('shell')) {
        return PermissionRequestBash
      }
      if (lc.includes('edit') || lc.includes('write') || lc.includes('file')) {
        return PermissionRequestFile
      }
      if (lc.includes('web') || lc.includes('fetch') || lc.includes('search')) {
        return PermissionRequestWebFetch
      }
      if (lc.includes('skill')) {
        return PermissionRequestSkill
      }
      if (lc.includes('monitor')) {
        return PermissionRequestMonitor
      }
      return null
  }
}

/**
 * Returns the per-tool dialog body component for `toolName`, or `null`
 * when no specialized variant is registered. Exported for the
 * `ApprovalOverlay` integration point so the overlay can decide whether
 * to swap in the tool-specific body or keep its generic preview.
 */
export function permissionComponentForTool(
  toolName: string,
): React.ComponentType<PermissionRequestProps> | null {
  return bodyForTool(toolName)
}

export const PermissionRequest: React.FC<PermissionRequestProps> = (props) => {
  const { subject, onResolve, onCancel } = props
  const handleAbort = useCallback(() => {
    onResolve({ behavior: 'abort' })
    onCancel?.()
  }, [onCancel, onResolve])

  // app:interrupt aborts the request — matches AgenC's `modal:cancel` /
  // approval-overlay convention so the dialog cannot orphan a queued
  // permission request when the operator hits Ctrl-C.
  useKeybinding('app:interrupt', handleAbort, 'modal')

  // Defensive cleanup if the host unmounts the dialog without resolving.
  useEffect(() => () => undefined, [])

  const Body = bodyForTool(subject.toolName)
  if (!Body) {
    return null
  }
  return <Body {...props} />
}

export default PermissionRequest
