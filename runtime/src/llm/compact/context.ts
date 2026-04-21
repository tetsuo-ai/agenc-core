import type { Tool } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { EffortValue } from '../../utils/effort.js'

export interface CompactRuntimeAppState {
  toolPermissionContext: {
    additionalWorkingDirectories: ReadonlyMap<string, unknown>
    mode?: string
  }
  agentDefinitions: {
    activeAgents: unknown[]
  }
  tasks: Record<string, unknown>
  effortValue?: EffortValue
}

export interface CompactRuntimeOptions {
  tools: Tool[]
  mainLoopModel: string
  mcpClients: readonly unknown[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  verbose?: boolean
  querySource?: string
  agentDefinitions: {
    activeAgents: unknown[]
  }
  isNonInteractiveSession?: boolean
  cwd?: string
}

export interface CompactRuntimeContext {
  abortController: AbortController
  agentId?: AgentId
  options: CompactRuntimeOptions
  getAppState: () => CompactRuntimeAppState
  readFileState: Map<string, unknown>
  loadedNestedMemoryPaths?: Set<string>
  setStreamMode?: (mode: 'requesting' | 'responding' | null) => void
  setResponseLength?: (updater: (length: number) => number) => void
  onCompactProgress?: (event: unknown) => void
  setSDKStatus?: (status: 'compacting' | null) => void
  addNotification?: (notification: unknown) => void
  queryTracking?: {
    chainId?: string
    depth?: number
  }
  rolloutStore?: {
    getCompactionIndexSnapshot?: () => unknown
    getToolResultBytesIndexSnapshot?: () => ReadonlyMap<string, number>
    getToolCallTurnIdSnapshot?: () => ReadonlyMap<string, string>
    store?: {
      reAppendSessionMetadata?: () => void
    }
  }
  session?: {
    rolloutStore?: CompactRuntimeContext['rolloutStore']
  }
  cwd?: string
}
