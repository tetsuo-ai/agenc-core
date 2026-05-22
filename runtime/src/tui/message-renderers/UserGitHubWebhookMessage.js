import React from 'react'

export function UserGitHubWebhookMessage({ addMargin, param }) {
  const body = normalizeWebhookBody(param?.text)
  return React.createElement(
    React.Fragment,
    null,
    addMargin ? React.createElement('ink-text', null, '\n') : null,
    React.createElement('ink-text', null, 'GitHub webhook: '),
    React.createElement('ink-text', null, body || 'activity received'),
  )
}

function normalizeWebhookBody(text) {
  return String(text ?? '')
    .replace(/<\/?github-webhook-activity[^>]*>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
