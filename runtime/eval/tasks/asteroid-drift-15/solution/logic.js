// Pure game logic: no DOM, no timers, so node:test can cover it.
export function circlesCollide(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const distance = Math.hypot(dx, dy)
  return distance < a.radius + b.radius
}

export function scoreForElapsed(elapsedMs) {
  return Math.floor(elapsedMs / 1000)
}

export function levelForScore(score) {
  return Math.floor(score / 20) + 1
}

export function spawnIntervalForLevel(level) {
  return Math.max(250, 1000 - (level - 1) * 120)
}

export function insertHighScore(table, entry, limit = 5) {
  const next = [...table, entry].sort((left, right) => right.score - left.score)
  return next.slice(0, limit)
}
