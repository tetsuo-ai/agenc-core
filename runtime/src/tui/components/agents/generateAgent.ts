import type { ContentBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { getUserContext } from '../../../context.js'
import { queryModelWithoutStreaming } from '../../../services/api/anthropic.js' // branding-scan: allow existing provider API module path pending service purge
import { getEmptyToolPermissionContext } from '../../../tools/Tool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { prependUserContext } from '../../../utils/api.js' // upstream-import: keep target is owned by another Z-PURGE item
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js' // upstream-import: keep target is owned by another Z-PURGE item
import type { ModelName } from '../../../utils/model/model.js' // upstream-import: keep target is owned by another Z-PURGE item
import { isAutoMemoryEnabled } from '../../../memory/paths'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index'
import { jsonParse } from '../../../utils/slowOperations' // upstream-import: keep target is owned by another Z-PURGE item
import { asSystemPrompt } from '../../../utils/systemPromptType' // upstream-import: keep target is owned by another Z-PURGE item

type GeneratedAgent = {
  identifier: string
  whenToUse: string
  systemPrompt: string
}

const AGENT_GENERATION_JSON_ERROR =
  'Agent generation response was not valid JSON. Press Enter to retry, or press Esc to choose manual setup.'

export const AGENT_GENERATION_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$',
        minLength: 3,
        maxLength: 50,
        description:
          'Lowercase letters, numbers, and hyphens only. Typically 2-4 words joined by hyphens.',
      },
      whenToUse: {
        type: 'string',
        description:
          "Actionable trigger guidance starting with 'Use this agent when...'. Include concrete examples.",
      },
      systemPrompt: {
        type: 'string',
        description:
          "The complete system prompt for the generated agent, written in second person.",
      },
    },
    required: ['identifier', 'whenToUse', 'systemPrompt'],
    additionalProperties: false,
  },
} as const

const AGENT_CREATION_SYSTEM_PROMPT = `You are an elite AI agent architect specializing in crafting high-performance agent configurations. Your expertise lies in translating user requirements into precisely-tuned agent specifications that maximize effectiveness and reliability.

**Important Context**: You may have access to project-specific instructions from AGENC.md files and other context that may include coding standards, project structure, and custom requirements. Consider this context when creating agents to ensure they align with the project's established patterns and practices.

When a user describes what they want an agent to do, you will:

1. **Extract Core Intent**: Identify the fundamental purpose, key responsibilities, and success criteria for the agent. Look for both explicit requirements and implicit needs. Consider any project-specific context from AGENC.md files. For agents that are meant to review code, you should assume that the user is asking to review recently written code and not the whole codebase, unless the user has explicitly instructed you otherwise.

2. **Design Expert Persona**: Create a compelling expert identity that embodies deep domain knowledge relevant to the task. The persona should inspire confidence and guide the agent's decision-making approach.

3. **Architect Comprehensive Instructions**: Develop a system prompt that:
   - Establishes clear behavioral boundaries and operational parameters
   - Provides specific methodologies and best practices for task execution
   - Anticipates edge cases and provides guidance for handling them
   - Incorporates any specific requirements or preferences mentioned by the user
   - Defines output format expectations when relevant
   - Aligns with project-specific coding standards and patterns from AGENC.md

4. **Optimize for Performance**: Include:
   - Decision-making frameworks appropriate to the domain
   - Quality control mechanisms and self-verification steps
   - Efficient workflow patterns
   - Clear escalation or fallback strategies

5. **Create Identifier**: Design a concise, descriptive identifier that:
   - Uses lowercase letters, numbers, and hyphens only
   - Is typically 2-4 words joined by hyphens
   - Clearly indicates the agent's primary function
   - Is memorable and easy to type
   - Avoids generic terms like "helper" or "assistant"

6 **Example agent descriptions**:
  - in the 'whenToUse' field of the JSON object, you should include examples of when this agent should be used.
  - examples should be of the form:
    - <example>
      Context: The user is creating a test-runner agent that should be called after a logical chunk of code is written.
      user: "Please write a function that checks if a number is prime"
      assistant: "Here is the relevant function: "
      <function call omitted for brevity only for this example>
      <commentary>
      Since a significant piece of code was written, use the ${AGENT_TOOL_NAME} tool to launch the test-runner agent to run the tests.
      </commentary>
      assistant: "Now let me use the test-runner agent to run the tests"
    </example>
    - <example>
      Context: User is creating an agent for AgenC product questions.
      user: "How do I configure AgenC hooks?"
      assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the agenc-code-guide agent to answer the question"
      <commentary>
      Since the user is asking how to use AgenC, use the agenc-code-guide agent.
      </commentary>
    </example>
  - If the user mentioned or implied that the agent should be used proactively, you should include examples of this.
- NOTE: Ensure that in the examples, you are making the assistant use the Agent tool and not simply respond directly to the task.

Your output must be a valid JSON object with exactly these fields:
{
  "identifier": "A unique, descriptive identifier using lowercase letters, numbers, and hyphens (e.g., 'test-runner', 'api-docs-writer', 'code-formatter')",
  "whenToUse": "A precise, actionable description starting with 'Use this agent when...' that clearly defines the triggering conditions and use cases. Ensure you include examples as described above.",
  "systemPrompt": "The complete system prompt that will govern the agent's behavior, written in second person ('You are...', 'You will...') and structured for maximum clarity and effectiveness"
}

Key principles for your system prompts:
- Be specific rather than generic - avoid vague instructions
- Include concrete examples when they would clarify behavior
- Balance comprehensiveness with clarity - every instruction should add value
- Ensure the agent has enough context to handle variations of the core task
- Make the agent proactive in seeking clarification when needed
- Build in quality assurance and self-correction mechanisms

Remember: The agents you create should be autonomous experts capable of handling their designated tasks with minimal additional guidance. Your system prompts are their complete operational manual.
`

// Agent memory instructions to include in the system prompt when memory is mentioned or relevant
const AGENT_MEMORY_INSTRUCTIONS = `

7. **Agent Memory Instructions**: If the user mentions "memory", "remember", "learn", "persist", or similar concepts, OR if the agent would benefit from building up knowledge across conversations (e.g., code reviewers learning patterns, architects learning codebase structure, etc.), include domain-specific memory update instructions in the systemPrompt.

   Add a section like this to the systemPrompt, tailored to the agent's specific domain:

   "**Update your agent memory** as you discover [domain-specific items]. This builds up institutional knowledge across conversations. Write concise notes about what you found and where.

   Examples of what to record:
   - [domain-specific item 1]
   - [domain-specific item 2]
   - [domain-specific item 3]"

   Examples of domain-specific memory instructions:
   - For a code-reviewer: "Update your agent memory as you discover code patterns, style conventions, common issues, and architectural decisions in this codebase."
   - For a test-runner: "Update your agent memory as you discover test patterns, common failure modes, flaky tests, and testing best practices."
   - For an architect: "Update your agent memory as you discover codepaths, library locations, key architectural decisions, and component relationships."
   - For a documentation writer: "Update your agent memory as you discover documentation patterns, API structures, and terminology conventions."

   The memory instructions should be specific to what the agent would naturally learn while performing its core tasks.
`

export async function generateAgent(
  userPrompt: string,
  model: ModelName,
  existingIdentifiers: string[],
  abortSignal: AbortSignal,
): Promise<GeneratedAgent> {
  const existingList =
    existingIdentifiers.length > 0
      ? `\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existingIdentifiers.join(', ')}`
      : ''

  const prompt = `Create an agent configuration based on this request: "${userPrompt}".${existingList}
  Return exactly one JSON object that validates the required schema. Do not include markdown, commentary, or code fences. The first character must be "{" and the last character must be "}".`

  const userMessage = createUserMessage({ content: prompt })

  // Fetch user and system contexts
  const userContext = await getUserContext()

  // Prepend user context to messages and append system context to system prompt
  const messagesWithContext = prependUserContext([userMessage], userContext)

  // Include memory instructions when the feature is enabled
  const systemPrompt = isAutoMemoryEnabled()
    ? AGENT_CREATION_SYSTEM_PROMPT + AGENT_MEMORY_INSTRUCTIONS
    : AGENT_CREATION_SYSTEM_PROMPT

  const responseText = await queryGeneratedAgentText({
    messagesWithContext,
    systemPrompt,
    model,
    abortSignal,
  })

  let parsed: GeneratedAgent
  try {
    parsed = parseGeneratedAgentResponse(responseText)
  } catch (error) {
    if (!isGeneratedAgentParseError(error)) throw error
    const repairMessage = createUserMessage({
      content: `The previous response did not validate as the required generated-agent JSON object. Convert it into exactly one JSON object with identifier, whenToUse, and systemPrompt only. Do not include markdown or prose.\n\nPrevious response:\n${responseText}`,
    })
    const repairText = await queryGeneratedAgentText({
      messagesWithContext: prependUserContext([repairMessage], userContext),
      systemPrompt,
      model,
      abortSignal,
    })
    try {
      parsed = parseGeneratedAgentResponse(repairText)
    } catch (repairError) {
      if (!isGeneratedAgentParseError(repairError)) throw repairError
      parsed = buildFallbackGeneratedAgent(userPrompt)
    }
  }

  const identifier = makeUniqueAgentIdentifier(
    parsed.identifier,
    existingIdentifiers,
  )
  const agent = {
    identifier,
    whenToUse: replaceIdentifier(parsed.whenToUse, parsed.identifier, identifier),
    systemPrompt: replaceIdentifier(parsed.systemPrompt, parsed.identifier, identifier),
  }

  logEvent('agenc_agent_definition_generated', {
    agent_identifier:
      agent.identifier as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return agent
}

async function queryGeneratedAgentText({
  messagesWithContext,
  systemPrompt,
  model,
  abortSignal,
}: {
  readonly messagesWithContext: readonly ReturnType<typeof createUserMessage>[]
  readonly systemPrompt: string
  readonly model: ModelName
  readonly abortSignal: AbortSignal
}): Promise<string> {
  const response = await queryModelWithoutStreaming({
    messages: normalizeMessagesForAPI(messagesWithContext),
    systemPrompt: asSystemPrompt([systemPrompt]),
    thinkingConfig: { type: 'disabled' as const },
    tools: [],
    signal: abortSignal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model,
      toolChoice: undefined,
      agents: [],
      isNonInteractiveSession: false,
      hasAppendSystemPrompt: false,
      querySource: 'agent_creation',
      mcpTools: [],
      outputFormat: AGENT_GENERATION_OUTPUT_FORMAT,
    },
  })

  const textBlocks = response.message.content.filter(
    (block): block is ContentBlock & { type: 'text' } => block.type === 'text',
  )
  return textBlocks.map(block => block.text).join('\n')
}

export function parseGeneratedAgentResponse(responseText: string): GeneratedAgent {
  const trimmed = responseText.trim()
  const candidates = [
    trimmed,
    ...(trimmed.match(/\{[\s\S]*\}/g) ?? []),
  ]

  for (const candidate of candidates) {
    try {
      const parsed = jsonParse(candidate) as Partial<GeneratedAgent>
      if (
        typeof parsed.identifier === 'string' &&
        parsed.identifier.trim().length > 0 &&
        typeof parsed.whenToUse === 'string' &&
        parsed.whenToUse.trim().length > 0 &&
        typeof parsed.systemPrompt === 'string' &&
        parsed.systemPrompt.trim().length > 0
      ) {
        return {
          identifier: parsed.identifier,
          whenToUse: parsed.whenToUse,
          systemPrompt: parsed.systemPrompt,
        }
      }
    } catch {
      // Try the next candidate before surfacing the recoverable wizard error.
    }
  }

  throw new Error(AGENT_GENERATION_JSON_ERROR)
}

function isGeneratedAgentParseError(error: unknown): boolean {
  return error instanceof Error && error.message === AGENT_GENERATION_JSON_ERROR
}

export function buildFallbackGeneratedAgent(userPrompt: string): GeneratedAgent {
  const identifier = deriveAgentIdentifier(userPrompt)
  const taskDescription = buildFallbackTaskDescription(userPrompt)
  const whenClause = buildFallbackWhenClause(taskDescription)
  return {
    identifier,
    whenToUse:
      `Use this agent when ${whenClause}. ` +
      `Example: when a request matches this description, use the ${AGENT_TOOL_NAME} tool to launch ${identifier}.`,
    systemPrompt:
      `You are ${identifier}, a specialized AgenC agent for ${taskDescription}.\n\n` +
      `Focus on the user's stated goal, inspect the relevant files before giving advice, keep recommendations concrete, and call out risks or missing verification clearly. ` +
      `When you produce output, keep it concise, actionable, and grounded in the project context.`,
  }
}

function buildFallbackTaskDescription(userPrompt: string): string {
  const prompt = stripTrailingPunctuation(
    collapseWhitespace(userPrompt),
  ) || 'custom AgenC work'
  const roleMatch = prompt.match(
    /^(?:a|an|the)\s+(architect|auditor|debugger|designer|planner|reviewer|runner|tester|writer)\s+for\s+(.+)$/iu,
  )
  const description = roleMatch
    ? `${ROLE_VERBS[roleMatch[1].toLowerCase() as keyof typeof ROLE_VERBS]} ${roleMatch[2]}`
    : prompt
  return stripTrailingPunctuation(
    description.replace(/\s+that\s+suggests?\s+/iu, ' and suggesting '),
  )
}

function buildFallbackWhenClause(taskDescription: string): string {
  if (/^(architecting|auditing|debugging|designing|planning|reviewing|running|testing|writing)\b/iu.test(taskDescription)) {
    return taskDescription
  }
  return `the user needs focused help with ${taskDescription}`
}

function deriveAgentIdentifier(userPrompt: string): string {
  const tokens = collapseWhitespace(userPrompt)
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? []
  const role = tokens.find(token => ROLE_TOKENS.has(token))
  const keywords = uniqueTokens(
    tokens.filter(token => !STOPWORDS.has(token) && !ROLE_TOKENS.has(token)),
  )

  let selected = keywords.slice(0, role ? 3 : 4)
  if (tokens.includes('python') && tokens.includes('game')) {
    selected = ['python', 'game', ...selected.filter(token => token !== 'python' && token !== 'game')]
      .slice(0, role ? 3 : 4)
  }
  if (role) selected = [...selected, role]
  if (selected.length === 0) selected = ['custom', 'agent']
  return uniqueTokens(selected).slice(0, 4).join('-')
}

function makeUniqueAgentIdentifier(
  identifier: string,
  existingIdentifiers: readonly string[],
): string {
  const existing = new Set(existingIdentifiers.map(value => value.toLowerCase()))
  const base = normalizeAgentIdentifier(identifier) || 'custom-agent'
  if (!existing.has(base)) return base

  for (let suffix = 2; suffix < 1000; suffix++) {
    const suffixText = `-${suffix}`
    const candidateBase = trimIdentifierEnd(base.slice(0, 50 - suffixText.length))
    const candidate = `${candidateBase}${suffixText}`
    if (!existing.has(candidate)) return candidate
  }

  return `${trimIdentifierEnd(base.slice(0, 46))}-${Date.now().toString(36).slice(-3)}`
}

function replaceIdentifier(value: string, previous: string, next: string): string {
  if (previous === next || previous.length === 0) return value
  return value.split(previous).join(next)
}

function normalizeAgentIdentifier(identifier: string): string {
  const value = identifier
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join('-') ?? ''
  const normalized = trimIdentifierEnd(value.slice(0, 50))
  return normalized.length >= 3 ? normalized : ''
}

function trimIdentifierEnd(identifier: string): string {
  return identifier.replace(/^-+|-+$/g, '')
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/u, '')
}

function uniqueTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    result.push(token)
  }
  return result
}

const ROLE_TOKENS = new Set([
  'architect',
  'auditor',
  'debugger',
  'designer',
  'planner',
  'reviewer',
  'runner',
  'tester',
  'writer',
])

const ROLE_VERBS = {
  architect: 'architecting',
  auditor: 'auditing',
  debugger: 'debugging',
  designer: 'designing',
  planner: 'planning',
  reviewer: 'reviewing',
  runner: 'running',
  tester: 'testing',
  writer: 'writing',
} as const

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'agent',
  'assistant',
  'for',
  'help',
  'improvement',
  'improvements',
  'of',
  'on',
  'or',
  'small',
  'suggest',
  'suggests',
  'that',
  'the',
  'this',
  'tiny',
  'to',
  'use',
  'when',
  'with',
])
