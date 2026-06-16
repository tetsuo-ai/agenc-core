import Fuse from 'fuse.js'
import { basename } from 'path'
import stripAnsi from 'strip-ansi'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { generateFileSuggestions } from './fileSuggestions.js'
import type { ServerResource } from '../../services/mcp/types.js'
import { getAgentColor } from 'src/tools/AgentTool/agentColorManager.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { sanitizeSystemReminderContent } from '../../prompts/attachments/system-reminder-sanitizer.js'
import { logError } from '../../utils/log.js' // upstream-import: keep target is owned by another Z-PURGE item
import type { Theme } from '../../utils/theme.js' // upstream-import: keep target is owned by another Z-PURGE item

type FileSuggestionSource = {
  type: 'file'
  displayText: string
  description?: string
  path: string
  filename: string
  score?: number
}

type McpResourceSuggestionSource = {
  type: 'mcp_resource'
  displayText: string
  description: string
  server: string
  uri: string
  name: string
}

type AgentSuggestionSource = {
  type: 'agent'
  displayText: string
  description: string
  agentType: string
  color?: keyof Theme
}

type SuggestionSource =
  | FileSuggestionSource
  | McpResourceSuggestionSource
  | AgentSuggestionSource

/**
 * Creates a unified suggestion item from a source
 */
function createSuggestionFromSource(source: SuggestionSource): SuggestionItem {
  switch (source.type) {
    case 'file':
      return {
        id: `file-${source.path}`,
        displayText: source.displayText,
        description: source.description,
      }
    case 'mcp_resource':
      return {
        id: `mcp-resource-${source.server}__${source.uri}`,
        displayText: source.displayText,
        description: source.description,
      }
    case 'agent':
      return {
        id: `agent-${source.agentType}`,
        displayText: source.displayText,
        description: source.description,
        color: source.color,
      }
  }
}

const MAX_UNIFIED_SUGGESTIONS = 15

function sanitizeSuggestionText(value: string): string {
  return sanitizeSystemReminderContent(stripAnsi(value)).replace(/\s+/gu, ' ').trim()
}

function sanitizeSuggestionIdentifier(value: string): string | null {
  const sanitized = sanitizeSuggestionText(value)
  return sanitized.length > 0 && sanitized === value ? sanitized : null
}

function firstSanitizedText(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value === undefined) continue
    const sanitized = sanitizeSuggestionText(value)
    if (sanitized.length > 0) return sanitized
  }
  return ''
}

// Round-2 M-NEW8: pass the full description through. The footer renderer
// truncates inline for non-selected rows and expands the full text on a
// second line for the selected row, so trimming here would hide the rest
// of an agent's whenToUse / MCP-resource description behind /help.
function normalizeDescription(description: string): string {
  return sanitizeSuggestionText(description)
}

function generateAgentSuggestions(
  agents: AgentDefinition[],
  query: string,
  showOnEmpty = false,
): AgentSuggestionSource[] {
  if (!query && !showOnEmpty) {
    return []
  }

  try {
    const agentSources: AgentSuggestionSource[] = agents.flatMap(agent => {
      const agentType = sanitizeSuggestionIdentifier(agent.agentType)
      if (agentType === null) return []

      return [{
        type: 'agent' as const,
        displayText: `${agentType} (agent)`,
        description: normalizeDescription(agent.whenToUse),
        agentType,
        color: getAgentColor(agentType),
      }]
    })

    if (!query) {
      return agentSources
    }

    const queryLower = query.toLowerCase()
    return agentSources.filter(
      agent =>
        agent.agentType.toLowerCase().includes(queryLower) ||
        agent.displayText.toLowerCase().includes(queryLower),
    )
  } catch (error) {
    logError(error as Error)
    return []
  }
}

export async function generateUnifiedSuggestions(
  query: string,
  mcpResources: Record<string, ServerResource[]>,
  agents: AgentDefinition[],
  showOnEmpty = false,
): Promise<SuggestionItem[]> {
  if (!query && !showOnEmpty) {
    return []
  }

  const [fileSuggestions, agentSources] = await Promise.all([
    generateFileSuggestions(query, showOnEmpty),
    Promise.resolve(generateAgentSuggestions(agents, query, showOnEmpty)),
  ])

  const fileSources: FileSuggestionSource[] = fileSuggestions.map(
    suggestion => ({
      type: 'file' as const,
      displayText: suggestion.displayText,
      description: suggestion.description,
      path: suggestion.displayText, // Use displayText as path for files
      filename: basename(suggestion.displayText),
      score: (suggestion.metadata as { score?: number } | undefined)?.score,
    }),
  )

  const mcpSources: McpResourceSuggestionSource[] = Object.values(mcpResources)
    .flat()
    .flatMap(resource => {
      const server = sanitizeSuggestionIdentifier(resource.server)
      const uri = sanitizeSuggestionIdentifier(resource.uri)
      if (server === null || uri === null) return []

      return [{
        type: 'mcp_resource' as const,
        displayText: `${server}:${uri}`,
        description: firstSanitizedText(
          resource.description,
          resource.name,
          uri,
        ),
        server,
        uri,
        name: firstSanitizedText(resource.name, uri),
      }]
    })

  if (!query) {
    const allSources = [...fileSources, ...mcpSources, ...agentSources]
    return allSources
      .slice(0, MAX_UNIFIED_SUGGESTIONS)
      .map(createSuggestionFromSource)
  }

  const nonFileSources: SuggestionSource[] = [...mcpSources, ...agentSources]

  // Score non-file sources with Fuse.js
  // File sources are already scored by Rust/nucleo
  type ScoredSource = { source: SuggestionSource; score: number }
  const scoredResults: ScoredSource[] = []

  // Add file sources with their nucleo scores (already 0-1, lower is better)
  for (const fileSource of fileSources) {
    scoredResults.push({
      source: fileSource,
      score: fileSource.score ?? 0.5, // Default to middle score if missing
    })
  }

  // Score non-file sources with Fuse.js and add them
  if (nonFileSources.length > 0) {
    const fuse = new Fuse(nonFileSources, {
      includeScore: true,
      threshold: 0.6, // Allow more matches through, we'll sort by score
      keys: [
        { name: 'displayText', weight: 2 },
        { name: 'name', weight: 3 },
        { name: 'server', weight: 1 },
        { name: 'description', weight: 1 },
        { name: 'agentType', weight: 3 },
      ],
    })

    const fuseResults = fuse.search(query, { limit: MAX_UNIFIED_SUGGESTIONS })
    for (const result of fuseResults) {
      scoredResults.push({
        source: result.item,
        score: result.score ?? 0.5,
      })
    }
  }

  // Sort all results by score (lower is better) and return top results
  scoredResults.sort((a, b) => a.score - b.score)

  return scoredResults
    .slice(0, MAX_UNIFIED_SUGGESTIONS)
    .map(r => r.source)
    .map(createSuggestionFromSource)
}
