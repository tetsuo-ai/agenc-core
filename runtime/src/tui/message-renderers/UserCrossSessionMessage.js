import React from 'react'

const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message'

export function UserCrossSessionMessage({ addMargin, param }) {
  const text = param?.text
  const body = normalizeText(extractTag(text, CROSS_SESSION_MESSAGE_TAG))
  if (!body) return null

  const from = attr(text, 'from') ?? 'peer'
  return React.createElement(
    React.Fragment,
    null,
    addMargin ? React.createElement('ink-text', null, '\n') : null,
    React.createElement('ink-text', null, `message from ${from}: `),
    React.createElement('ink-text', null, body),
  )
}

function attr(text, name) {
  return new RegExp(`${name}="([^"]*)"`, 'u').exec(String(text ?? ''))?.[1]
}

function normalizeText(value) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function extractTag(text, tagName) {
  return new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'iu')
    .exec(String(text ?? ''))?.[1] ?? null
}
