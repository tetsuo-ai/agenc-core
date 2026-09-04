export function spawnPowerup(width) {
  const kind = Math.random() < 0.5 ? 'shield' : 'slow'
  return { kind, x: 20 + Math.random() * (width - 40), y: -12, radius: 12, vy: 80 }
}

export function stepPowerups(powerups, dt, height) {
  for (const powerup of powerups) {
    powerup.y += powerup.vy * dt
  }
  return powerups.filter((powerup) => powerup.y - powerup.radius < height)
}

export function applyPowerup(state, powerup) {
  if (powerup.kind === 'shield') state.player.shield = true
  if (powerup.kind === 'slow') state.slowUntil = state.elapsedMs + 3000
}
