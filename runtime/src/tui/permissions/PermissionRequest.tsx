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

import {
  useKeybinding,
  useSetKeybindingContext,
} from '../keybindings/KeybindingContext.js'

import { PermissionRequestBash } from './PermissionRequestBash.js'
import { PermissionRequestFile } from './PermissionRequestFile.js'
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
  readonly abortSignal?: AbortSignal
  readonly verbose?: boolean
}

export type PermissionSurface =
  | 'shell'
  | 'file'
  | 'web'
  | 'skill'
  | 'ask-user-question'
  | 'exit-plan'

const TOOL_PERMISSION_SURFACES: ReadonlyMap<string, PermissionSurface> =
  new Map<string, PermissionSurface>([
    ['Bash', 'shell'],
    ['system.bash', 'shell'],
    ['PowerShell', 'shell'],
    ['exec_command', 'shell'],
    ['local_shell', 'shell'],
    ['Edit', 'file'],
    ['edit_file', 'file'],
    ['Write', 'file'],
    ['write_file', 'file'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    ['Skill', 'skill'],
    ['AskUserQuestion', 'ask-user-question'],
    ['ExitPlanMode', 'exit-plan'],
  ])

export function permissionSurfaceForTool(
  toolName: string,
): PermissionSurface | null {
  return TOOL_PERMISSION_SURFACES.get(toolName) ?? null
}

export function isSupportedPermissionSurface(toolName: string): boolean {
  return permissionSurfaceForTool(toolName) !== null
}

function bodyForTool(
  toolName: string,
): React.ComponentType<PermissionRequestProps> | null {
  switch (permissionSurfaceForTool(toolName)) {
    case 'shell':
      return PermissionRequestBash
    case 'file':
      return PermissionRequestFile
    case 'web':
      return PermissionRequestWebFetch
    case 'skill':
      return PermissionRequestSkill
    case 'ask-user-question':
    case 'exit-plan':
    default:
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
  const { subject, onResolve, onCancel, abortSignal } = props
  const setActiveContext = useSetKeybindingContext()
  const handleAbort = useCallback(() => {
    onResolve({ behavior: 'abort' })
    onCancel?.()
  }, [onCancel, onResolve])

  // app:interrupt aborts the request — matches AgenC's `modal:cancel` /
  // approval-overlay convention so the dialog cannot orphan a queued
  // permission request when the operator hits Ctrl-C.
  useKeybinding('app:interrupt', handleAbort, 'global')

  useEffect(() => {
    setActiveContext('modal')
    return () => {
      setActiveContext('chat')
    }
  }, [setActiveContext])

  useEffect(() => {
    if (!abortSignal) return
    if (abortSignal.aborted) {
      queueMicrotask(() => onResolve({ behavior: 'abort' }))
      return
    }
    const handler = (): void => {
      onResolve({ behavior: 'abort' })
    }
    abortSignal.addEventListener('abort', handler)
    return () => {
      abortSignal.removeEventListener('abort', handler)
    }
  }, [abortSignal, onResolve])

  const Body = bodyForTool(subject.toolName)
  if (!Body) {
    return null
  }
  return <Body {...props} />
}

export default PermissionRequest
