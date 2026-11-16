import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// App imports the full interactive runtime. Inspect the actual catch boundaries
// so these regressions cover both notifications and transient result text.
const app = readFileSync(new URL('../../src/tui/components/App.tsx', import.meta.url), 'utf8');
it('uses a human catalog error while retaining the mismatch in diagnostics', () => {
  const catalog = app.slice(app.indexOf('const pluginStorageRoot =\n'), app.indexOf('const getBridgeAppState'));
  expect(catalog).toContain('Session configuration is incomplete. Reopen the session.');
  expect(catalog).toContain('Could not load agents for this workspace.');
  expect(catalog).toContain('logError(error)');
  expect(catalog).not.toContain('text: error instanceof Error');
});
it('projects both prompt submission errors before displaying them', () => {
  expect(app).not.toContain('`Submission failed: ${message}`');
  expect(app).not.toContain('`Submission failed: ${message_0}`');
  expect(app).toContain('const message = promptSubmissionErrorText(error, submitted)');
  expect(app).toContain('const message_0 = promptSubmissionErrorText(err_1)');
});

import { promptSubmissionErrorText } from '../../src/tui/prompt-submission-error-text.js';
it.each([
  [new Error('AgenC daemon agent not running: agent-secret'), 'Could not send your message. Reopen the session to reconnect.'],
  [new Error('RPC timeout {"session_id":"opaque"}'), 'Could not send your message: the connection timed out. Try again.'],
  [new Error('{"workspace_id":"opaque","protocol":true}'), 'Could not send your message. Try again or reopen the session.'],
  [{ raw: 'internal' }, 'Could not send your message. Try again or reopen the session.'],
])('projects an exception without its protocol fields', (error, text) => {
  expect(promptSubmissionErrorText(error)).toBe(text);
});
it('does not invite resending a message whose cleanup failed', () => {
  expect(promptSubmissionErrorText(new Error('{"cleanup":"internal"}'), true)).toBe('Your message was sent, but cleanup failed. Reopen the session.');
});

it('keeps a readable reason that tells the person how to repair the failure', () => {
  const failure = 'Cannot start daemon session: protected directory chain permits untrusted mutation: /private/home. Fix the cause, run agenc daemon start in another shell, then press Enter to retry.';
  expect(promptSubmissionErrorText(new Error(failure))).toBe(`Could not send your message: ${failure}`);
  expect(promptSubmissionErrorText(new Error('commit failure'), true)).toBe('Your message was sent, but cleanup failed: commit failure');
  expect(promptSubmissionErrorText(new Error('lookup failed for call_abcdef123456'))).toBe('Could not send your message. Try again or reopen the session.');
});
