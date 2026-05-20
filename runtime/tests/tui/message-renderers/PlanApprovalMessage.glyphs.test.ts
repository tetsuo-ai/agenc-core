import React from 'react';
import { describe, expect, it } from 'vitest';

import {
  formatTeammateMessageContent,
  getPlanApprovalResponseTitle,
  tryRenderPlanApprovalMessage,
} from './PlanApprovalMessage.js';

describe('PlanApprovalMessage glyph fallbacks', () => {
  it('uses shared status glyphs for approval response titles', () => {
    expect(getPlanApprovalResponseTitle(true, 'agent-a')).toBe('✓ Plan Approved by agent-a');
    expect(getPlanApprovalResponseTitle(false, 'agent-b')).toBe('✗ Plan Rejected by agent-b');
  });

  it('uses ascii status labels when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' };

    expect(getPlanApprovalResponseTitle(true, 'agent-a', env)).toBe('OK Plan Approved by agent-a');
    expect(getPlanApprovalResponseTitle(false, 'agent-b', env)).toBe('ERR Plan Rejected by agent-b');
  });

  it('detects plan approval request and response payloads', () => {
    const request = JSON.stringify({
      type: 'plan_approval_request',
      from: 'planner',
      timestamp: '2026-05-20T00:00:00.000Z',
      planFilePath: '/tmp/plan.md',
      planContent: '# Plan',
      requestId: 'req-1',
    });
    const approved = JSON.stringify({
      type: 'plan_approval_response',
      requestId: 'req-1',
      approved: true,
      timestamp: '2026-05-20T00:00:01.000Z',
    });
    const rejected = JSON.stringify({
      type: 'plan_approval_response',
      requestId: 'req-1',
      approved: false,
      feedback: 'tighten tests',
      timestamp: '2026-05-20T00:00:02.000Z',
    });

    expect(React.isValidElement(tryRenderPlanApprovalMessage(request, 'lead'))).toBe(true);
    expect(React.isValidElement(tryRenderPlanApprovalMessage(approved, 'lead'))).toBe(true);
    expect(React.isValidElement(tryRenderPlanApprovalMessage('plain', 'lead'))).toBe(false);
    expect(formatTeammateMessageContent(request)).toBe('[Plan Approval Request from planner]');
    expect(formatTeammateMessageContent(approved)).toBe('[Plan Approved] You can now proceed with implementation');
    expect(formatTeammateMessageContent(rejected)).toBe('[Plan Rejected] tighten tests');
  });

  it('summarizes idle and terminated teammate messages and leaves plain text alone', () => {
    expect(
      formatTeammateMessageContent(
        JSON.stringify({
          type: 'idle_notification',
          from: 'agent-a',
          timestamp: '2026-05-20T00:00:00.000Z',
          completedTaskId: 'task-1',
          completedStatus: 'failed',
          summary: 'needs input',
        }),
      ),
    ).toBe('Agent idle · Task task-1 failed · Last DM: needs input');
    expect(
      formatTeammateMessageContent(
        JSON.stringify({
          type: 'teammate_terminated',
          message: 'worker stopped',
        }),
      ),
    ).toBe('worker stopped');
    expect(formatTeammateMessageContent('{')).toBe('{');
    expect(formatTeammateMessageContent('hello')).toBe('hello');
  });
});
