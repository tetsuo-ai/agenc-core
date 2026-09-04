export function spawnAsteroid(width, speedScale) {
  const radius = 10 + Math.random() * 18
  return { x: radius + Math.random() * (width - radius * 2), y: -radius, radius, vy: (90 + Math.random() * 120) * speedScale }
}

export function stepAsteroids(asteroids, dt, height, timeScale) {
  for (const asteroid of asteroids) {
    asteroid.y += asteroid.vy * dt * timeScale
  }
  return asteroids.filter((asteroid) => asteroid.y - asteroid.radius < height)
}
