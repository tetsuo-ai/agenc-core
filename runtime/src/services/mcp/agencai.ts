import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export function hasAgenCAiMcpEverConnected(name: string): boolean {
  return getGlobalConfig().agencAiMcpEverConnected?.includes(name) ?? false
}

export function markAgenCAiMcpConnected(name: string): void {
  saveGlobalConfig(current => {
    const connected = current.agencAiMcpEverConnected ?? []
    if (connected.includes(name)) return current
    return {
      ...current,
      agencAiMcpEverConnected: [...connected, name],
    }
  })
}
