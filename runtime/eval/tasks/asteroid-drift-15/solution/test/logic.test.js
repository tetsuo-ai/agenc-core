import { test } from 'node:test'
import assert from 'node:assert/strict'
import { circlesCollide, scoreForElapsed, levelForScore, spawnIntervalForLevel, insertHighScore } from '../logic.js'

test('circles collide when centers are closer than the radii sum', () => {
  assert.equal(circlesCollide({ x: 0, y: 0, radius: 10 }, { x: 15, y: 0, radius: 10 }), true)
  assert.equal(circlesCollide({ x: 0, y: 0, radius: 10 }, { x: 25, y: 0, radius: 10 }), false)
})

test('score is whole seconds survived', () => {
  assert.equal(scoreForElapsed(0), 0)
  assert.equal(scoreForElapsed(12999), 12)
})

test('level rises every 20 points and spawns faster', () => {
  assert.equal(levelForScore(0), 1)
  assert.equal(levelForScore(20), 2)
  assert.equal(levelForScore(59), 3)
  assert.ok(spawnIntervalForLevel(3) < spawnIntervalForLevel(1))
  assert.equal(spawnIntervalForLevel(50), 250)
})

test('high score table keeps the top five by score', () => {
  const table = [{ initials: 'AAA', score: 10 }, { initials: 'BBB', score: 30 }]
  const next = insertHighScore(table, { initials: 'CCC', score: 20 })
  assert.deepEqual(next.map((entry) => entry.initials), ['BBB', 'CCC', 'AAA'])
  const full = insertHighScore(Array.from({ length: 5 }, (_, index) => ({ initials: 'X', score: 100 - index })), { initials: 'Y', score: 1 })
  assert.equal(full.length, 5)
})
