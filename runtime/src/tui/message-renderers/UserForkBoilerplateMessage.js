import React from 'react'

const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
const FORK_DIRECTIVE_PREFIX = 'Your directive: '

export function UserForkBoilerplateMessage({ addMargin, param }) {
  const body = extractTag(param?.text, FORK_BOILERPLATE_TAG)
  const directive = normalizeText(
    body?.startsWith(FORK_DIRECTIVE_PREFIX)
      ? body.slice(FORK_DIRECTIVE_PREFIX.length)
      : body,
  )
  if (!directive) return null

  return React.createElement(
    React.Fragment,
    null,
    addMargin ? React.createElement('ink-text', null, '\n') : null,
    React.createElement('ink-text', null, 'fork directive: '),
    React.createElement('ink-text', null, directive),
  )
}

function normalizeText(value) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function extractTag(text, tagName) {
  return new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'iu')
    .exec(String(text ?? ''))?.[1] ?? null
}
