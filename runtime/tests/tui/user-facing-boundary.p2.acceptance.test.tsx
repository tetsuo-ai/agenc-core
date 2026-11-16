/**
 * Acceptance tests for findings 07 to 21, 26, 27 and 29 of the 0.19.36
 * display audit (round4/jobs/uiaudit37/AUDIT.md). Each started as a probe
 * that demonstrated the bug; here it asserts the fix on the same paths:
 * compact row, expanded view, missing or invalid stored output (old
 * sessions), unmatched and out-of-order results.
 */
import { describe, expect, test } from 'vitest';
import { adaptTranscriptEvents, formatStructuredToolResult, makeToolResultMessage } from '../../src/tui/session-transcript.js';
import { BashOutputView, createTuiTool, FileReadView } from '../../src/tui/tool-rendering.js';
import { getToolResultFallbackContent } from '../../src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.js';
import { formatOrphanToolResultContent } from '../../src/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.js';
import { sessionTranscriptV2FromRollout } from '../../src/app-server/background-agent-runner/journal-reconstruction.js';
import { summarizeToolError } from '../../src/tui/tool-error-text.js';
import { backgroundStartedNote, RESIDUAL_PROCESSES_NOTE, timeoutBackgroundedNote } from '../../src/tools/system/exec-result-format.js';
import { codeModeRuntimeResponseToToolResult } from '../../src/tools/code-mode/tools.js';
import { PERMISSION_DENIED_DISPLAY_TEXT } from '../../src/tui/tool-result-denial.js';
import { AUTO_REJECT_MESSAGE, DONT_ASK_REJECT_MESSAGE, SUBAGENT_REJECT_MESSAGE } from '../../src/utils/messages.js';
import {
  SANDBOX_BIND_DENIED_NO_ESCALATION,
  SANDBOX_GIT_WRITE_DENIED_ESCALATION_AVAILABLE,
} from '../../src/tools/system/exec-sandbox-denial.js';

function text(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node.type === 'function' && node.props?.children === undefined) return text(node.type(node.props));
  return text(node.props?.children);
}

function generic(toolName: string, raw: string, verbose: boolean): string {
  return text(createTuiTool(toolName).renderToolResultMessage(raw, [], { verbose }));
}

const fallback = (raw: unknown, toolName?: string): string | null =>
  getToolResultFallbackContent([{ type: 'tool_result', tool_use_id: 'a', content: raw }], 'a', toolName);

describe('P2 and P3 display boundary', () => {
  test('07 an out-of-order or unmatched result gets the user-facing text', () => {
    const raw = 'User has approved exiting plan mode. You can now proceed.';
    const rows = adaptTranscriptEvents([
      { id: 'end', msg: { type: 'tool_call_completed', payload: { callId: 'call_audit', result: raw, isError: false } } },
    ] as never).messages as any[];
    expect(rows[0].content).toContain('Left plan mode');
    expect(rows[0].content).not.toContain('You can now proceed');
    expect(rows[0].content).not.toContain('call_audit');
    expect(formatOrphanToolResultContent(raw as never)).toBe('Left plan mode');
    expect(formatOrphanToolResultContent(
      'User has answered your questions: "Color"="Blue". You can now continue with the user\'s answers in mind.' as never,
    )).toBe('Color  Blue');
  });

  test('08 ExitPlanMode never shows approval instructions (compact, expanded, stored)', () => {
    const raw = 'User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: /p.md\n\n## Approved Plan:\n# Plan';
    for (const verbose of [false, true]) expect(generic('ExitPlanMode', raw, verbose)).toBe('Plan approved');
    expect(fallback(raw, 'ExitPlanMode')).toBe('Plan approved');
    expect(fallback(raw)).toBe('Plan approved');
  });

  test('09 a read past the end of the file says so instead of "empty file"', () => {
    const past = '<system-reminder>Warning: the file exists but is shorter than the provided offset (99). The file has 2 lines.</system-reminder>';
    const blocks = formatStructuredToolResult('FileRead', 'tool_call_completed', {
      result: past, metadata: { numLines: 0, totalLines: 2, startLine: 99 },
    });
    expect(text(FileReadView({ content: blocks[0]!.text }))).toBe('No lines at offset 99. File has 2 lines.');
    const empty = formatStructuredToolResult('FileRead', 'tool_call_completed', {
      result: '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
      metadata: { numLines: 0 },
    });
    expect(text(FileReadView({ content: empty[0]!.text }))).toBe('empty file');
    const pdf = formatStructuredToolResult('FileRead', 'tool_call_completed', {
      result: '<system-reminder>Warning: the PDF exists but no extractable text was found.</system-reminder>',
      metadata: { numLines: 0 },
    });
    expect(text(FileReadView({ content: pdf[0]!.text }))).toBe('No extractable text');
  });

  test('10 expanded shell results say what happened, without tool instructions', () => {
    const cases: [string, string, string][] = [
      [backgroundStartedNote(7), 'Command is running in the background.', 'write_stdin'],
      [timeoutBackgroundedNote(5000, 3), 'The time limit passed. The command is still running in the background.', 'kill_process'],
      [RESIDUAL_PROCESSES_NOTE, 'Stopped processes the command left running.', 'require_escalated'],
    ];
    for (const [note, shown, hidden] of cases) {
      const raw = `hello\n[exec yielded=true wall_time=1s tokens=1 session_id=7]\n${note}`;
      const expanded = text(BashOutputView({ content: raw, verbose: true }));
      expect(expanded).toContain(shown);
      expect(expanded).not.toContain(hidden);
      expect(expanded).not.toContain('[note:');
      expect(text(BashOutputView({ content: raw, verbose: false }))).not.toContain(hidden);
    }
  });

  test('11 missing or invalid stored output: no raw protocol, no media bytes', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'AUDIT_FIXTURE' } };
    expect(formatOrphanToolResultContent([image] as never)).toBe('Image received.');
    expect(fallback([image])).toBe('Image received.');
    expect(fallback([{ type: 'text', text: 'kept text' }, { type: 'resource', resource: { uri: 'file:///x' } }]))
      .toBe('kept text\nFile received.');
    expect(fallback('<system-reminder>model-only instruction</system-reminder>')).toBe('');
    expect(getToolResultFallbackContent(
      makeToolResultMessage('a', '<system-reminder>model-only instruction</system-reminder>').message.content, 'a',
    )).toBe('');
  });

  test('12 file-read reminder tags never render, with or without metadata', () => {
    const raw = '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>';
    expect(generic('FileRead', raw, true)).not.toContain('system-reminder');
    expect(generic('FileRead', raw, false)).not.toContain('system-reminder');
    expect(fallback(raw, 'FileRead')).toBe('Empty file');
    // A file whose text mentions the tag is content and stays whole.
    const body = 'line one\n<system-reminder>quoted in a document</system-reminder>\nline three';
    expect(fallback(body)).toBe(body);
    // Real output that only resembles runtime text is left alone.
    const yaml = 'agentId: 42\nname: demo\nUse this value in production.';
    expect(fallback(yaml)).toBe(yaml);
    const source = 'const tag = "<command-name>x</command-name>";';
    expect(fallback(source)).toBe(source);
    // An external (MCP) tool's output is never rewritten.
    const external = '<system-reminder>from the server</system-reminder>';
    expect(fallback(external, 'mcp.files.read')).toBe(external);
  });

  test('13 a legacy Agent result hides the internal id and the next-step instructions', () => {
    const raw = 'Async agent launched successfully.\nagentId: a1b2c3 (internal ID - do not mention to user. Use SendMessage with to: \'a1b2c3\' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent\'s work.';
    const shown = fallback(raw)!;
    expect(shown).toBe('Async agent launched successfully.');
    expect(shown).not.toContain('a1b2c3');
  });

  test('14 a legacy WebSearch result drops the citation instruction', () => {
    const raw = 'Web search results for query: "x"\n\nLinks: [{"title":"T","url":"https://e.test"}]\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.';
    const shown = fallback(raw)!;
    expect(shown).toContain('https://e.test');
    expect(shown).not.toContain('REMINDER');
  });

  test('15 legacy EnterPlanMode and Skill text is recognized without the tool name', () => {
    expect(fallback('Entered plan mode.\n\nIn plan mode, you should:\n1. Thoroughly explore the codebase')).toBe('Entered plan mode');
    const skill = `<command-name>iot-builder</command-name>\n${'Follow these instructions. '.repeat(30)}`;
    expect(fallback(skill)).toBe(`Loaded skill iot-builder (${skill.length} chars of instructions, hidden from chat)`);
    expect(formatOrphanToolResultContent('Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.' as never)).toBe('Todo list updated');
  });

  test('16 tool discovery shows a receipt, not schemas and hints', () => {
    const raw = JSON.stringify({ loaded: ['mcp.files.read'], results: [{ name: 'mcp.files.read', loaded: true, useHint: 'Call the selected MCP tool through the tool-call interface' }] });
    expect(generic('system.searchTools', raw, true)).toBe('Loaded mcp.files.read');
    const found = JSON.stringify({ results: [{ name: 'a', description: 'd' }, { name: 'b', description: 'd' }], hint: 'To use one, load it with select' });
    expect(generic('system.searchTools', found, true)).toBe('Found 2 tools');
    expect(fallback(raw, 'system.searchTools')).toBe('Loaded mcp.files.read');
    // JSON receipts are never guessed for a result whose tool is unknown.
    expect(fallback(raw)).toBe(raw);
    expect(fallback(JSON.stringify({ results: [] }))).toBe(JSON.stringify({ results: [] }));
  });

  test('17 process inventory and stop results read as text', () => {
    const list = JSON.stringify({ sessions: [{ session_id: 7, status: 'running', command: 'npm run dev', cwd: '/w', tty: false, started_at: 't' }], live_count: 1, note: 'This inventory does not survive a daemon restart; check the known server URL' });
    const shown = generic('list_processes', list, true);
    expect(shown).toBe('npm run dev: running');
    expect(shown).not.toContain('session_id');
    const kill = JSON.stringify({ results: [{ session_id: 7, terminated: true }], owned_live_sessions: [{ session_id: 8 }], owned_live_sessions_note: 'these are the sessions this conversation started', stopping_sessions_note: 'Do not signal them again; check list_processes shortly.' });
    expect(generic('kill_process', kill, true)).toBe('Stop requested for 1 command. 1 command still running.');
  });

  test('18 code-mode results hide the cell id and the raw footer', () => {
    const result = codeModeRuntimeResponseToToolResult({ type: 'yielded', cellId: 'cell_fixture', durationMs: 1000, contentItems: [] } as never);
    const shown = generic('exec', result.content as string, true);
    expect(shown).toContain('Script running.');
    expect(shown).not.toContain('cell_fixture');
    expect(shown).not.toContain('[code_mode');
  });

  test('19 a fetch without DeepSeek metadata and resource results are not JSON', () => {
    const raw = JSON.stringify({ url: 'https://example.test', content: 'hello', ok: true });
    expect(generic('web_fetch', raw, true)).toBe('Fetched https://example.test');
    expect(generic('ListMcpResourcesTool', JSON.stringify({ resources: [{ uri: 'a' }, { uri: 'b' }] }), true)).toBe('Found 2 resources');
    // An external tool's own JSON output is its output and stays.
    const external = JSON.stringify({ url: 'https://x.test', content: 'c', ok: true });
    expect(generic('mcp.custom.tool', external, true)).toBe(external);
  });

  test('20 refusals keep the fact and drop the instructions to the model', () => {
    const cases: [string, string][] = [
      [AUTO_REJECT_MESSAGE('Write'), 'Action was not allowed.'],
      [DONT_ASK_REJECT_MESSAGE('Write'), "Not allowed in don't ask mode."],
      [SUBAGENT_REJECT_MESSAGE, 'Permission denied.'],
      ['File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.', 'File changed since it was read.'],
      [SANDBOX_GIT_WRITE_DENIED_ESCALATION_AVAILABLE, 'Sandbox blocked a git write to protected .git metadata.'],
      [SANDBOX_BIND_DENIED_NO_ESCALATION, 'Sandbox blocked starting a local server.'],
      ['Worktree has 2 uncommitted files. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true, or use action: "keep" to preserve the worktree.', 'Worktree has 2 uncommitted files. Removing it would discard this work.'],
      ["Permission denied: exec_command was denied by this session's approval resolver. Do not retry the same call; choose a different approach or ask the user how to proceed.", "Permission denied: exec_command was denied by this session's approval resolver."],
    ];
    for (const [raw, shown] of cases) expect(summarizeToolError(raw)).toBe(shown);
    // A tool's own error text is not rewritten.
    expect(summarizeToolError('ENOENT: no such file or directory, open /x')).toBe('ENOENT: no such file or directory, open /x');
    expect(summarizeToolError('TypeError: call_user_func_array failed (tool_registry)')).toBe('TypeError: call_user_func_array failed (tool_registry)');
  });

  test('21 a stream-recovery error names the tool, not its call id', () => {
    const rows = adaptTranscriptEvents([
      { id: 'e', msg: { type: 'error', payload: { message: 'The model stream disconnected; automatic retry stopped because streamed tool Write (call_9f8e7d6c5b) reached completed and may have executed. Type continue and press Enter to resume from the recorded tool results.' } } },
    ] as never).messages as any[];
    const shown = JSON.stringify(rows.map((row) => row.content));
    expect(shown).toContain('streamed tool Write reached completed');
    expect(shown).not.toContain('call_9f8e7d6c5b');
  });

  test('26 the question renderer speaks to the person, not about "User"', () => {
    const tool = createTuiTool('AskUserQuestion');
    const shown = text(tool.renderToolResultMessage({ answers: { Color: 'Blue' } }));
    expect(shown).toContain('Color');
    expect(shown).toContain('Blue');
    expect(shown).not.toContain('User');
    expect(text(tool.renderToolUseRejectedMessage())).toBe('Questions declined');
  });

  test('27 an attachment row has its own caption, not the model receipt', () => {
    const snapshot = sessionTranscriptV2FromRollout([
      { type: 'event_msg', payload: { id: 'e', eventId: 'e', seq: 1, msg: { type: 'tool_call_completed', payload: { callId: 'call_x', result: '', isError: false, displayAttachments: [{ id: 'a', kind: 'file', title: 'report', mimeType: 'text/plain', size: 0 }] } } } },
    ] as never, 's', 'r');
    expect(snapshot.events?.[0]!.payload.result).toBe('Attached file "report"');
    expect(fallback('[Shown to the user: chart "Sales"]')).toBe('Chart: Sales');
  });

  test('29 a denied permission request is not described in the third person', () => {
    expect(PERMISSION_DENIED_DISPLAY_TEXT).toBe('Permission denied.');
    expect(formatOrphanToolResultContent({ error: 'rejected by user' } as never)).toBe('Permission denied.');
  });
});

describe('interrupted tool call', () => {
  test('reads as an interruption, not as "Tool execution failed"', () => {
    expect(summarizeToolError('[Request interrupted by user for tool use]')).toBe('Interrupted.');
  });
});
