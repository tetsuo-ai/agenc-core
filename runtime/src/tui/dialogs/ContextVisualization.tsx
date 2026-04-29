/**
 * ContextVisualization
 *
 * Ported from upstream. Renders a per-category breakdown of the active
 * context window: a glyph grid (one square per ~%-point of the budget),
 * a category legend with token/percentage figures, and grouped sections
 * for memory files, MCP tools, custom agents, and skills.
 *
 * The widget is purely presentational. Callers compute `data` from the
 * live runtime (token-budget, memory-files index, MCP registry, etc.)
 * and pass it in. The companion `ContextSuggestions` widget can be
 * rendered alongside via the optional `suggestions` prop.
 */

import React from 'react'

import { Box, Text, type TextProps } from '../ink-public.js'

import {
  ContextSuggestions,
  type ContextSuggestion,
} from './ContextSuggestions.js'

const RESERVED_CATEGORY_NAME = 'Autocompact buffer'
const FREE_SPACE_NAME = 'Free space'

const GLYPH_FILLED_HIGH = '⛁'
const GLYPH_FILLED_LOW = '⛀'
const GLYPH_FREE = '⛶'
const GLYPH_RESERVED = '⛝'
const GLYPH_INDICATOR_RESERVED = '⛝'
const GLYPH_INDICATOR_FILLED = '⛁'

type ContextColor = TextProps['color']

export interface ContextCategory {
  readonly name: string
  readonly tokens: number
  /** Theme color key or raw color literal. Drives the legend swatch. */
  readonly color?: ContextColor
  /**
   * Marks tokens that are not yet loaded into the active window
   * (e.g. on-demand MCP tools). Rendered with `N/A` percentage.
   */
  readonly isDeferred?: boolean
}

export interface ContextGridSquare {
  readonly categoryName: string
  readonly color?: ContextColor
  /** 0..1, where 1 is "this square is fully drawn from the category". */
  readonly squareFullness: number
}

export interface ContextToolEntry {
  readonly name: string
  readonly tokens: number
  readonly isLoaded?: boolean
}

export interface ContextSourceGroup<T> {
  readonly source: string
  readonly items: readonly T[]
}

export interface ContextSkillsBreakdown {
  readonly tokens: number
  readonly groups: readonly ContextSourceGroup<{
    readonly name: string
    readonly tokens: number
  }>[]
}

export interface ContextAgentsBreakdown {
  readonly groups: readonly ContextSourceGroup<{
    readonly agentType: string
    readonly tokens: number
  }>[]
}

export interface ContextMemoryFile {
  readonly displayPath: string
  readonly tokens: number
}

export interface ContextData {
  readonly model: string
  readonly totalTokens: number
  readonly rawMaxTokens: number
  readonly percentage: number
  readonly categories: readonly ContextCategory[]
  readonly gridRows: readonly (readonly ContextGridSquare[])[]
  readonly memoryFiles: readonly ContextMemoryFile[]
  readonly mcpTools: readonly ContextToolEntry[]
  readonly agents?: ContextAgentsBreakdown
  readonly skills?: ContextSkillsBreakdown
}

export interface ContextVisualizationProps {
  readonly data: ContextData
  /** Optional companion suggestions panel. */
  readonly suggestions?: readonly ContextSuggestion[]
  /** Token formatter override. Defaults to a compact `1.2k` form. */
  readonly formatTokens?: (tokens: number) => string
}

function defaultFormatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '0'
  }
  if (tokens < 1_000) {
    return String(Math.round(tokens))
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

function gridSquareGlyph(square: ContextGridSquare): string {
  if (square.categoryName === FREE_SPACE_NAME) return `${GLYPH_FREE} `
  if (square.categoryName === RESERVED_CATEGORY_NAME)
    return `${GLYPH_RESERVED} `
  return square.squareFullness >= 0.7
    ? `${GLYPH_FILLED_HIGH} `
    : `${GLYPH_FILLED_LOW} `
}

function findCategory(
  categories: readonly ContextCategory[],
  name: string,
): ContextCategory | undefined {
  return categories.find((category) => category.name === name)
}

function visibleLegendCategories(
  categories: readonly ContextCategory[],
): readonly ContextCategory[] {
  return categories.filter(
    (category) =>
      category.tokens > 0 &&
      category.name !== FREE_SPACE_NAME &&
      category.name !== RESERVED_CATEGORY_NAME &&
      !category.isDeferred,
  )
}

export function ContextVisualization({
  data,
  suggestions = [],
  formatTokens = defaultFormatTokens,
}: ContextVisualizationProps): React.ReactElement {
  const {
    model,
    totalTokens,
    rawMaxTokens,
    percentage,
    categories,
    gridRows,
    memoryFiles,
    mcpTools,
    agents,
    skills,
  } = data

  const legendCategories = visibleLegendCategories(categories)
  const freeSpace = findCategory(categories, FREE_SPACE_NAME)
  const reserved = findCategory(categories, RESERVED_CATEGORY_NAME)

  const legend = (
    <Box flexDirection="column" gap={0} flexShrink={0}>
      <Text dimColor={true}>
        {`${model} · ${formatTokens(totalTokens)}/${formatTokens(rawMaxTokens)} tokens (${percentage}%)`}
      </Text>
      <Text> </Text>
      <Text dimColor={true} italic={true}>
        Estimated usage by category
      </Text>
      {legendCategories.map((category, index) => {
        const tokenDisplay = formatTokens(category.tokens)
        const percentDisplay = category.isDeferred
          ? 'N/A'
          : `${((category.tokens / rawMaxTokens) * 100).toFixed(1)}%`
        const isReserved = category.name === RESERVED_CATEGORY_NAME
        const symbol = category.isDeferred
          ? ' '
          : isReserved
            ? GLYPH_INDICATOR_RESERVED
            : GLYPH_INDICATOR_FILLED
        return (
          <Box key={`${category.name}-${index}`}>
            <Text color={category.color}>{symbol}</Text>
            <Text> {category.name}: </Text>
            <Text dimColor={true}>
              {`${tokenDisplay} tokens (${percentDisplay})`}
            </Text>
          </Box>
        )
      })}
      {freeSpace && freeSpace.tokens > 0 ? (
        <Box>
          <Text dimColor={true}>{GLYPH_FREE}</Text>
          <Text> Free space: </Text>
          <Text dimColor={true}>
            {`${formatTokens(freeSpace.tokens)} (${(
              (freeSpace.tokens / rawMaxTokens) *
              100
            ).toFixed(1)}%)`}
          </Text>
        </Box>
      ) : null}
      {reserved && reserved.tokens > 0 ? (
        <Box>
          <Text color={reserved.color}>{GLYPH_INDICATOR_RESERVED}</Text>
          <Text dimColor={true}> {reserved.name}: </Text>
          <Text dimColor={true}>
            {`${formatTokens(reserved.tokens)} tokens (${(
              (reserved.tokens / rawMaxTokens) *
              100
            ).toFixed(1)}%)`}
          </Text>
        </Box>
      ) : null}
    </Box>
  )

  const grid = (
    <Box flexDirection="column" flexShrink={0}>
      {gridRows.map((row, rowIndex) => (
        <Box key={`row-${rowIndex}`} flexDirection="row" marginLeft={-1}>
          {row.map((square, colIndex) => (
            <Text
              key={`sq-${rowIndex}-${colIndex}`}
              color={
                square.categoryName === FREE_SPACE_NAME ? undefined : square.color
              }
              dimColor={square.categoryName === FREE_SPACE_NAME}
            >
              {gridSquareGlyph(square)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )

  const mcpSection =
    mcpTools.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold={true}>MCP tools</Text>
          <Text dimColor={true}> · /mcp</Text>
        </Box>
        {mcpTools.map((tool, index) => (
          <Box key={`mcp-${index}-${tool.name}`}>
            <Text>{`└ ${tool.name}: `}</Text>
            <Text dimColor={true}>
              {tool.isLoaded === false
                ? '(loaded on demand)'
                : `${formatTokens(tool.tokens)} tokens`}
            </Text>
          </Box>
        ))}
      </Box>
    ) : null

  const memorySection =
    memoryFiles.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold={true}>Memory files</Text>
          <Text dimColor={true}> · /memory</Text>
        </Box>
        {memoryFiles.map((file, index) => (
          <Box key={`mem-${index}-${file.displayPath}`}>
            <Text>{`└ ${file.displayPath}: `}</Text>
            <Text dimColor={true}>{`${formatTokens(file.tokens)} tokens`}</Text>
          </Box>
        ))}
      </Box>
    ) : null

  const agentsSection =
    agents && agents.groups.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold={true}>Custom agents</Text>
          <Text dimColor={true}> · /agents</Text>
        </Box>
        {agents.groups.map((group) => (
          <Box
            key={`agent-group-${group.source}`}
            flexDirection="column"
            marginTop={1}
          >
            <Text dimColor={true}>{group.source}</Text>
            {group.items.map((agent, index) => (
              <Box key={`agent-${group.source}-${index}-${agent.agentType}`}>
                <Text>{`└ ${agent.agentType}: `}</Text>
                <Text dimColor={true}>
                  {`${formatTokens(agent.tokens)} tokens`}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    ) : null

  const skillsSection =
    skills && skills.tokens > 0 && skills.groups.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold={true}>Skills</Text>
          <Text dimColor={true}> · /skills</Text>
        </Box>
        {skills.groups.map((group) => (
          <Box
            key={`skill-group-${group.source}`}
            flexDirection="column"
            marginTop={1}
          >
            <Text dimColor={true}>{group.source}</Text>
            {group.items.map((skill, index) => (
              <Box key={`skill-${group.source}-${index}-${skill.name}`}>
                <Text>{`└ ${skill.name}: `}</Text>
                <Text dimColor={true}>
                  {`${formatTokens(skill.tokens)} tokens`}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    ) : null

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold={true}>Context Usage</Text>
      <Box flexDirection="row" gap={2}>
        {grid}
        {legend}
      </Box>
      <Box flexDirection="column" marginLeft={-1}>
        {mcpSection}
        {memorySection}
        {agentsSection}
        {skillsSection}
      </Box>
      <ContextSuggestions
        suggestions={suggestions}
        formatTokens={formatTokens}
      />
    </Box>
  )
}

export default ContextVisualization
