import { getRuntimeState, updateRuntimeState } from '../../utils/config.js'

export function hasAgenCAiMcpEverConnected(name: string): boolean {
  return getRuntimeState().agencAiMcpEverConnected?.includes(name) ?? false
}

export function markAgenCAiMcpConnected(name: string): void {
  updateRuntimeState(current => {
    const connected = current.agencAiMcpEverConnected ?? []
    if (connected.includes(name)) return current
    return {
      ...current,
      agencAiMcpEverConnected: [...connected, name],
    }
  })
}
