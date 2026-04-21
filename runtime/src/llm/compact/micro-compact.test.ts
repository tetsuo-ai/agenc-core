import { describe, expect, test } from 'vitest'

import type { Message } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'

// We test the exported collectCompactableToolIds behavior indirectly via
// the public microcompactMessages + time-based path. But first we need to
// verify the core predicate: MCP tools (prefixed 'mcp__') should be
// compactable alongside the built-in tool set.

// Import internals we can test
import { evaluateTimeBasedTrigger } from './micro-compact.js'

/**
 * Helper: build a minimal assistant message with a tool_use block.
 */
function assistantWithToolUse(toolName: string, toolId: string): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use' as const,
        id: toolId,
        name: toolName,
        input: {},
      },
    ],
  })
}

/**
 * Helper: build a user message with a tool_result block.
 */
function userWithToolResult(toolId: string, output: string): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: toolId,
        content: output,
      },
    ],
  })
}

function localToolMessage(size: number, toolName: string): Message {
  return {
    role: 'tool',
    content: 'x'.repeat(size),
    toolCallId: `tool-${toolName}-${size}`,
    toolName,
  } as Message
}

describe('microCompact MCP tool compaction', () => {
  // We can't easily unit-test the private isCompactableTool directly,
  // but we can test the full time-based microcompact path which exercises
  // collectCompactableToolIds → isCompactableTool under the hood.
  // The time-based path is the simplest to trigger: it content-clears
  // old tool results when the gap since last assistant message exceeds
  // the threshold.

  // However, evaluateTimeBasedTrigger depends on config (GrowthBook).
  // So instead, let's test the observable behavior by importing the
  // microcompactMessages function and checking that MCP tool_use blocks
  // are collected.

  // Since collectCompactableToolIds is not exported, we test the predicate
  // behavior by verifying that the module loads without error and that
  // built-in and MCP tools are treated consistently.

  test('module exports load correctly', async () => {
    const mod = await import('./micro-compact.js')
    expect(typeof mod.microcompactMessages).toBe('function')
    expect(typeof mod.estimateMessageTokens).toBe('function')
    expect(typeof mod.evaluateTimeBasedTrigger).toBe('function')
  })

  test('estimateMessageTokens counts MCP tool_use blocks', async () => {
    const { estimateMessageTokens } = await import('./micro-compact.js')

    const builtinMessages: Message[] = [
      assistantWithToolUse('Read', 'tool-builtin-1'),
      userWithToolResult('tool-builtin-1', 'file contents here'),
    ]

    const mcpMessages: Message[] = [
      assistantWithToolUse('mcp__github__get_file_contents', 'tool-mcp-1'),
      userWithToolResult('tool-mcp-1', 'file contents here'),
    ]

    const builtinTokens = estimateMessageTokens(builtinMessages)
    const mcpTokens = estimateMessageTokens(mcpMessages)

    // Both should produce non-zero estimates
    expect(builtinTokens).toBeGreaterThan(0)
    expect(mcpTokens).toBeGreaterThan(0)

    // The tool_result content is identical, so token estimates should be
    // similar (tool_use name differs slightly, so not exactly equal)
    expect(Math.abs(builtinTokens - mcpTokens)).toBeLessThan(50)
  })

  test('microcompactMessages processes MCP tools without error', async () => {
    const { microcompactMessages } = await import('./micro-compact.js')

    const messages: Message[] = [
      assistantWithToolUse('mcp__slack__send_message', 'tool-mcp-2'),
      userWithToolResult('tool-mcp-2', 'Message sent successfully'),
      assistantWithToolUse('mcp__github__create_pull_request', 'tool-mcp-3'),
      userWithToolResult('tool-mcp-3', JSON.stringify({ number: 42, url: 'https://github.com/org/repo/pull/42' })),
    ]

    // Should not throw — MCP tools should be handled gracefully
    const result = await microcompactMessages(messages)
    expect(result).toBeDefined()
    expect(result.messages).toBeDefined()
    expect(result.messages.length).toBe(messages.length)
  })

  test('microcompactMessages processes mixed built-in and MCP tools', async () => {
    const { microcompactMessages } = await import('./micro-compact.js')

    const messages: Message[] = [
      assistantWithToolUse('Read', 'tool-read-1'),
      userWithToolResult('tool-read-1', 'some file content'),
      assistantWithToolUse('mcp__playwright__screenshot', 'tool-mcp-4'),
      userWithToolResult('tool-mcp-4', 'base64-encoded-screenshot-data'.repeat(100)),
      assistantWithToolUse('Bash', 'tool-bash-1'),
      userWithToolResult('tool-bash-1', 'command output'),
    ]

    const result = await microcompactMessages(messages)
    expect(result).toBeDefined()
    expect(result.messages.length).toBe(messages.length)
  })

  test('microcompactMessages clears older role-based tool results on the live path', async () => {
    const { microcompactMessages } = await import('./micro-compact.js')
    const toolUseContext = {
      modelInfo: { slug: 'claude-3-5-sonnet-20241022' },
    } as any

    const messages: Message[] = [
      { role: 'user', content: 'seed' } as Message,
      localToolMessage(200, 'A'),
      { role: 'assistant', content: 'ack' } as Message,
      localToolMessage(200, 'B'),
      { role: 'assistant', content: 'ack' } as Message,
      localToolMessage(200, 'C'),
      { role: 'assistant', content: 'ack' } as Message,
      localToolMessage(200, 'D'),
      { role: 'assistant', content: 'ack' } as Message,
      localToolMessage(200, 'E'),
      { role: 'assistant', content: 'ack' } as Message,
      localToolMessage(200, 'F'),
      { role: 'assistant', content: 'ack' } as Message,
      localToolMessage(200, 'G'),
    ]

    const result = await microcompactMessages(
      messages,
      toolUseContext,
      'repl_main_thread',
    )
    const toolMessages = result.messages.filter((message) => message.role === 'tool')

    expect(toolMessages).toHaveLength(7)
    expect(toolMessages[0]?.content).toContain('[Old tool result content cleared]')
    expect(toolMessages[1]?.content).toContain('[Old tool result content cleared]')
    for (const toolMessage of toolMessages.slice(2)) {
      expect(toolMessage?.content).toBe('x'.repeat(200))
    }
  })
})
