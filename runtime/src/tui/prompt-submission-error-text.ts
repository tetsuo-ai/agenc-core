/**
 * The notification for a prompt that could not be sent. A readable reason
 * stays: some failures tell the person how to repair them ("run agenc
 * daemon start in another shell, then press Enter to retry"). A reason that
 * is protocol rather than prose (JSON, tags, a stack trace, internal ids)
 * stays in diagnostics and the notification says what happened instead.
 */
function readableReason(message: string): string | undefined {
  const text = message.trim();
  if (text.length === 0 || text.length > 400) return undefined;
  if (/^[[{]/u.test(text)) return undefined;
  if (/<\/?[a-z][a-z0-9_-]*>/iu.test(text)) return undefined;
  if (/\n\s+at\s/u.test(text)) return undefined;
  if (/\b(?:call|toolu|run)_[A-Za-z0-9]{6,}\b/u.test(text)) return undefined;
  // A session id means nothing in a notice, but the sentence around it can
  // carry the only way out ("... continue in a new session."): drop the id,
  // keep the sentence.
  return text
    .replace(/\bsession [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "this session")
    .replace(/\s*\(?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b\)?/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function promptSubmissionErrorText(error: unknown, sent = false): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const reason = readableReason(message);
  if (sent) {
    return reason === undefined
      ? 'Your message was sent, but cleanup failed. Reopen the session.'
      : `Your message was sent, but cleanup failed: ${reason}`;
  }
  // A known transport failure reads the same whatever ids it carries; a
  // failure that explains its own repair is shown as it is.
  if (/daemon.*(?:not running|closed|disconnect)|connection.*(?:closed|lost|refused)/iu.test(message)) {
    return 'Could not send your message. Reopen the session to reconnect.';
  }
  if (/timed? ?out|timeout/iu.test(message)) {
    return 'Could not send your message: the connection timed out. Try again.';
  }
  if (reason !== undefined) return `Could not send your message: ${reason}`;
  return 'Could not send your message. Try again or reopen the session.';
}
