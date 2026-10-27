import { expect, test } from 'vitest'
import { INITIAL_STATE, parseMultipleKeypresses } from '../../../src/tui/ink/parse-keypress.js'

test.each(['first\nsecond\nthird', 'first\r\nsecond\r\nthird'])(
  'keeps an unbracketed multiline text burst as one paste: %j', content => {
    const [items] = parseMultipleKeypresses(INITIAL_STATE, content)
    expect(items).toEqual([expect.objectContaining({
      kind: 'key', isPasted: true, sequence: content,
    })])
  },
)

test('a deliberate line-feed key remains a submit key', () => {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, '\n')
  expect(items).toEqual([expect.objectContaining({ isPasted: false, name: 'enter' })])
})

test('a cancellation control inside a burst is never hidden in a paste', () => {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, 'first\n\x03second')
  expect(items).toContainEqual(expect.objectContaining({ ctrl: true, name: 'c', isPasted: false }))
})
