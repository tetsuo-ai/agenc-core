import type { SettingSource } from '../../../utils/settings/constants.js' // upstream-import: keep target is owned by another Z-PURGE item
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

export const AGENT_PATHS = {
  FOLDER_NAME: '.agenc',
  AGENTS_DIR: 'agents',
} as const

// Base types for common patterns
type WithPreviousMode = { previousMode: ModeState }
type WithAgent = { agent: AgentDefinition }

// Simplified state type using intersection types
export type ModeState =
  | { mode: 'main-menu' }
  | { mode: 'list-agents'; source: SettingSource | 'all' | 'built-in' }
  | ({ mode: 'agent-menu' } & WithAgent & WithPreviousMode)
  | ({ mode: 'view-agent' } & WithAgent & WithPreviousMode)
  | { mode: 'create-agent' }
  | ({ mode: 'edit-agent' } & WithAgent & WithPreviousMode)
  | ({ mode: 'delete-confirm' } & WithAgent & WithPreviousMode)

export type AgentValidationResult = {
  isValid: boolean
  warnings: string[]
  errors: string[]
}
