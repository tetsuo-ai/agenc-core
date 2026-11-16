/** Keep exception payloads in diagnostics, outside the notification/transcript. */
export function promptSubmissionErrorText(error: unknown, sent = false): string {
  if (sent) return 'Your message was sent, but cleanup failed. Reopen the session.';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/daemon.*(?:not running|closed|disconnect)|connection.*(?:closed|lost|refused)/iu.test(message)) {
    return 'Could not send your message. Reopen the session to reconnect.';
  }
  if (/timed? ?out|timeout/iu.test(message)) {
    return 'Could not send your message: the connection timed out. Try again.';
  }
  return 'Could not send your message. Try again or reopen the session.';
}
