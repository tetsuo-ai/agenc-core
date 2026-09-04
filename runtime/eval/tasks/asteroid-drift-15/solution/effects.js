import { random } from './random.js'

export function explode(particles, x, y) {
  for (let index = 0; index < 40; index += 1) {
    const angle = random() * Math.PI * 2
    const speed = 60 + random() * 180
    particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0.8 })
  }
}

export function stepParticles(particles, dt) {
  for (const particle of particles) {
    particle.x += particle.vx * dt
    particle.y += particle.vy * dt
    particle.life -= dt
  }
  return particles.filter((particle) => particle.life > 0)
}

export function shakeOffset(shake) {
  if (shake <= 0) return { x: 0, y: 0 }
  return { x: (random() - 0.5) * shake * 12, y: (random() - 0.5) * shake * 12 }
}
