/**
 * Acceptance tests for the P1 findings of the 0.19.36 display audit
 * (round4/jobs/uiaudit37/AUDIT.md, findings 01 to 06). Each started as a
 * probe that demonstrated the bug on 0.19.36; here it asserts the fix.
 */
import { describe, expect, test } from 'vitest';
import { adaptTranscriptEvents } from '../../src/tui/session-transcript.js';
import { createTuiTool } from '../../src/tui/tool-rendering.js';
import { getToolResultFallbackContent } from '../../src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.js';
import { sessionTranscriptV2FromRollout } from '../../src/app-server/background-agent-runner/journal-reconstruction.js';
import { daemonTranscriptSnapshotEvents } from '../../src/tui/daemon-transcript-snapshot.js';
import { terminalTitle } from '../../src/tui/terminal-title.js';

function pair(name: string, result: unknown, isError = false, extra: Record<string, unknown> = {}): any {
  return adaptTranscriptEvents([
    { id: 'start', msg: { type: 'tool_call_started', payload: { callId: 'call_audit', toolName: name, args: '{}' } } },
    { id: 'end', msg: { type: 'tool_call_completed', payload: { callId: 'call_audit', toolName: name, result, isError, ...extra } } },
  ] as never).messages.at(-1);
}

function text(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node.type === 'function' && node.props?.children === undefined) return text(node.type(node.props));
  return text(node.props?.children);
}

describe('P1 display boundary', () => {
  test('01 an answered question shows the question and answer (compact, expanded, old sessions)', () => {
    const raw = 'User has answered your questions: "Pick a color"="Blue". You can now continue with the user\'s answers in mind.';
    const msg = pair('AskUserQuestion', raw);
    const tool = createTuiTool('AskUserQuestion');
    // The row value is accepted by the typed renderer, so no raw fallback.
    expect(tool.outputSchema.safeParse(msg.toolUseResult).success).toBe(true);
    const fallback = getToolResultFallbackContent(msg.message.content, 'call_audit');
    expect(fallback).toBe('Pick a color  Blue');
    for (const verbose of [false, true]) {
      const shown = text(tool.renderToolResultMessage(msg.toolUseResult, [], { verbose }));
      expect(shown).toContain('Pick a color');
      expect(shown).toContain('Blue');
      expect(shown).not.toContain('User has answered');
      expect(shown).not.toContain('You can now continue');
    }
    // A stored row that still holds the model-facing string (old session).
    const legacy = text(tool.renderToolResultMessage(raw));
    expect(legacy).toContain('Pick a color');
    expect(legacy).not.toContain('You can now continue');
  });

  test('02 skip and the two planning-interview actions have their own short lines', () => {
    const cases: [string, string][] = [
      ['User skipped these questions. Proceed with your best judgment — do not ask the same questions again unless something new makes the answer truly blocking.', 'Questions skipped'],
      ['User wants to chat about these questions before answering. Continue conversationally, address their concern, and use AskUserQuestion again only if concrete choices are still needed.', 'Chose to discuss the questions first'],
      ['User skipped the planning interview and wants you to plan immediately. Continue plan mode using the existing request and context, write or revise the plan file, then call ExitPlanMode when ready.', 'Planning interview skipped'],
    ];
    const tool = createTuiTool('AskUserQuestion');
    for (const [raw, shown] of cases) {
      const msg = pair('AskUserQuestion', raw);
      expect(getToolResultFallbackContent(msg.message.content, 'call_audit')).toBe(shown);
      expect(text(tool.renderToolResultMessage(msg.toolUseResult))).toBe(shown);
    }
  });

  test('03 a failed EnterPlanMode keeps its error; an already-active one says so', () => {
    const failed = pair('EnterPlanMode', 'permission mode registry is not available', true);
    expect(failed.message.content[0].is_error).toBe(true);
    expect(JSON.stringify(failed.message.content[0].content)).toContain('permission mode registry is not available');
    expect(JSON.stringify(failed.message.content[0].content)).not.toContain('Entered plan mode');
    const entered = pair('EnterPlanMode', 'Entered plan mode.\n\nIn plan mode, you should:\n1. Thoroughly explore');
    expect(entered.message.content[0].content).toBe('Entered plan mode');
    const already = pair('EnterPlanMode', 'Already in plan mode.\n\nIn plan mode, you should:\n1. Thoroughly explore');
    expect(already.message.content[0].content).toBe('Plan mode is already active');
  });

  test('04 a phase-only tool result keeps its error flag and gets the user-facing text', () => {
    const read = { id: 'call_phase', name: 'FileRead', arguments: '{}' };
    const failed = adaptTranscriptEvents([
      { type: 'tool_call', toolCall: read },
      { type: 'tool_result', toolCall: read, result: { content: 'File does not exist', isError: true } },
    ] as never).messages.at(-1) as any;
    expect(failed.message.content[0].is_error).toBe(true);
    expect(failed.message.content[0].content).toBe('File does not exist');

    const plan = { id: 'call_plan', name: 'ExitPlanMode', arguments: '{}' };
    const approved = adaptTranscriptEvents([
      { type: 'tool_call', toolCall: plan },
      { type: 'tool_result', toolCall: plan, result: { content: 'User has approved exiting plan mode. You can now proceed.', isError: false } },
    ] as never).messages.at(-1) as any;
    expect(approved.message.content[0].is_error).toBe(false);
    expect(approved.message.content[0].content).toBe('Left plan mode');
  });

  test('05 the terminal title names the model in use after a switch', () => {
    expect(terminalTitle({
      session: { sessionConfiguration: { provider: { slug: 'deepseek' }, collaborationMode: { model: 'deepseek-v4-pro' } } },
      startupModel: 'deepseek-flash',
      startupProvider: 'deepseek',
      liveModel: 'deepseek-v4-pro',
    })).toBe('AgenC deepseek/deepseek-v4-pro');
  });

  test('06 a legacy history-only transcript shows the human prompt, not the reminder wrapper', () => {
    const queued = '<system-reminder>\nThe user sent a new message while you were working:\nalso add a test\n\nIMPORTANT: After completing your current task, you MUST address the user\'s message above. Do not ignore it.\n</system-reminder>';
    const snapshot = sessionTranscriptV2FromRollout([
      { type: 'response_item', payload: { role: 'user', content: queued } },
      { type: 'response_item', payload: { role: 'user', content: '<system-reminder>queued prompt context</system-reminder>' } },
      { type: 'response_item', payload: { role: 'assistant', content: 'ok' } },
    ] as never, 's', 'r');
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      'also add a test',
      'Runtime note for the model (hidden)',
      'ok',
    ]);
    const rows = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(snapshot, 's') as never).messages as any[];
    expect(JSON.stringify(rows.map((row) => row.message?.content))).not.toContain('system-reminder');
  });

  test('06 control: a canonical queued prompt keeps showing its display text', () => {
    const rows = adaptTranscriptEvents([
      { id: 'u', msg: { type: 'user_message', payload: { message: '<system-reminder>wrapped</system-reminder>', displayText: 'actual prompt' } } },
    ] as never).messages as any[];
    expect(rows[0].message.content).toBe('actual prompt');
  });
});
