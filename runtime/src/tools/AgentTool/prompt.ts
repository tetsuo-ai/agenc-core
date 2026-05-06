import { FILE_READ_TOOL_NAME } from '../system/file-read.js'
import { GLOB_TOOL_NAME } from '../system/glob.js'
import { AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const SEND_MESSAGE_TOOL_NAME = 'SendMessage'
const authModulePath = '../../utils/auth.js'
const forkSubagentModulePath =
  './forkSubagent.js'
const teammateModulePath = '../../agenc/upstream/utils/teammate.js'
const teammateContextModulePath =
  '../../utils/teammateContext.js'

function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

function isEnvDefinedFalsy(envVar: string | boolean | undefined): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  const entrypoint = process.env.AGENC_ENTRYPOINT
  return (
    entrypoint !== 'sdk-ts' &&
    entrypoint !== 'sdk-py' &&
    entrypoint !== 'sdk-cli' &&
    entrypoint !== 'local-agent'
  )
}

async function getSubscriptionTypeSafe(): Promise<string | null> {
  try {
    const auth = (await import(authModulePath)) as {
      getSubscriptionType?: () => string | null
    }
    return auth.getSubscriptionType?.() ?? null
  } catch {
    return null
  }
}

async function isForkSubagentEnabledSafe(): Promise<boolean> {
  try {
    const forkSubagent = (await import(forkSubagentModulePath)) as {
      isForkSubagentEnabled?: () => boolean
    }
    return forkSubagent.isForkSubagentEnabled?.() ?? false
  } catch {
    return false
  }
}

async function isTeammateSafe(): Promise<boolean> {
  try {
    const teammate = (await import(teammateModulePath)) as {
      isTeammate?: () => boolean
    }
    return teammate.isTeammate?.() ?? false
  } catch {
    return false
  }
}

async function isInProcessTeammateSafe(): Promise<boolean> {
  try {
    const teammateContext = (await import(teammateContextModulePath)) as {
      isInProcessTeammate?: () => boolean
    }
    return teammateContext.isInProcessTeammate?.() ?? false
  } catch {
    return false
  }
}

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    return tools.join(', ')
  } else if (hasDenylist) {
    return `All tools except ${disallowedTools.join(', ')}`
  }
  return 'All tools'
}

export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.AGENC_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.AGENC_AGENT_LIST_IN_MESSAGES)) {
    return false
  }
  return true
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  const [forkEnabled, isTeammateSession, isInProcessTeammateSession] =
    await Promise.all([
      isForkSubagentEnabledSafe(),
      isTeammateSafe(),
      isInProcessTeammateSafe(),
    ])

  const whenToForkSection = forkEnabled
    ? `

## When to fork

Fork yourself (omit \`subagent_type\`) when the intermediate tool output is not worth keeping in your context. The criterion is qualitative: "will I need this output again", not task size.
- **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this because it inherits context and shares your cache.
- **Implementation**: prefer to fork implementation work that requires more than a couple of edits. Do research before jumping to implementation.

Forks are cheap because they share your prompt cache. Do not set \`model\` on a fork because a different model cannot reuse the parent's cache. Pass a short \`name\` (one or two words, lowercase) so the user can see the fork in the teams panel and steer it mid-run.

**Do not peek.** The tool result includes an \`output_file\` path. Do not read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.

**Do not race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format, not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running. Give status, not a guess.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a directive: what to do, not what the situation is. Be specific about scope: what is in, what is out, what another agent is handling. Do not re-explain background.
`
    : ''

  const writingThePromptSection = `

## Writing the prompt

${forkEnabled ? 'When spawning a fresh agent (with a `subagent_type`), it starts with zero context. ' : ''}Brief the agent like a smart colleague who just walked into the room. It has not seen this conversation, does not know what you have tried, and does not understand why this task matters.
- Explain what you are trying to accomplish and why.
- Describe what you have already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question. Prescribed steps become dead weight when the premise is wrong.

${forkEnabled ? 'For fresh agents, terse' : 'Terse'} command-style prompts produce shallow, generic work.

**Never delegate understanding.** Do not write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, and what specifically to change.
`

  const forkExamples = `Example usage:

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>Forking this because it is a survey question. I want the punch list, not the git output in my context.</thinking>
${AGENT_TOOL_NAME}({
  name: "ship-audit",
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the feature gate is wired up, whether CI-relevant files changed. Report a punch list: done vs. missing. Under 200 words."
})
assistant: Ship-readiness audit running.
<commentary>
Turn ends here. The coordinator knows nothing about the findings yet. What follows is a separate turn. The notification arrives from outside, as a user-role message. It is not something the coordinator writes.
</commentary>
[later turn: notification arrives as user message]
assistant: Audit's back. Three blockers: no tests for the new prompt path, feature gate wired but not in build_flags.yaml, and one uncommitted file.
</example>

<example>
user: "so is the gate wired up or not"
<commentary>
User asks mid-wait. The audit fork was launched to answer exactly this, and it has not returned. The coordinator does not have this answer. Give status, not a fabricated result.
</commentary>
assistant: Still waiting on the audit. That is one of the things it is checking. Should land shortly.
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent. It will not see my analysis, so it can give an independent read.</thinking>
<commentary>
A subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The briefing explains what to assess and why.
</commentary>
${AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes; I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
`

  const currentExamples = `Example usage:

<example_agent_descriptions>
"agenc-code-guide": use this agent when the user asks how AgenC works or how to use its features
"statusline-setup": use this agent to configure the user's AgenC status line setting
</example_agent_descriptions>

<example>
user: "How do I configure AgenC hooks?"
<commentary>
This is an AgenC usage question, so use the agenc-code-guide agent
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the agenc-code-guide agent
</example>

<example>
user: "Set up my AgenC status line"
<commentary>
This matches the statusline-setup agent, so use it to configure the setting
</commentary>
assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the statusline-setup agent"
</example>
`

  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

${
  forkEnabled
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself. A fork inherits your full conversation context.`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`
}`

  if (isCoordinator) {
    return shared
  }

  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use ${contentSearchHint} instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`

  const concurrencyNote =
    !listViaAttachment && (await getSubscriptionTypeSafe()) !== 'pro'
      ? `
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses`
      : ''

  return `${shared}
${whenNotToUseSection}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do${concurrencyNote}
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.${
    !isEnvTruthy(process.env.AGENC_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammateSession &&
    !forkEnabled
      ? `
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes. Do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed, such as research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.`
      : ''
  }
- To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved. ${forkEnabled ? 'Each fresh Agent invocation with a subagent_type starts without context. Provide a complete task description.' : 'Each Agent invocation starts fresh. Provide a complete task description.'}
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkEnabled ? '' : ", since it is not aware of the user's intent"}
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.${
    process.env.USER_TYPE === 'ant'
      ? `\n- You can set \`isolation: "remote"\` to run the agent in a remote environment. This is always a background task; you will be notified when it completes. Use for long-running tasks that need a fresh sandbox.`
      : ''
  }${
    isInProcessTeammateSession
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammateSession
        ? `
- The name, team_name, and mode parameters are not available in this context. Teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${whenToForkSection}${writingThePromptSection}

${forkEnabled ? forkExamples : currentExamples}`
}
