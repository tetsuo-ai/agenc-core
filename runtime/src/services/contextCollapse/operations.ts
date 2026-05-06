import {
  getContextVisualizationData,
  getStats,
  resetContextCollapse,
} from './index.js'

export async function getContextCollapseOperations() {
  const visualization = getContextVisualizationData()
  return [
    {
      type: 'inspect',
      stats: getStats(),
      visualization,
    },
    {
      type: 'reset',
      description: 'Clear all in-memory context-collapse state',
    },
  ]
}

export async function executeContextCollapseOperation(
  operation?: { type?: string },
) {
  if (operation?.type === 'reset') {
    resetContextCollapse()
    return { ok: true, type: 'reset' }
  }

  return {
    ok: true,
    type: 'inspect',
    stats: getStats(),
    visualization: getContextVisualizationData(),
  }
}
