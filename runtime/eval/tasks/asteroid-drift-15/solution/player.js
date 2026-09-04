import { circlesCollide } from './logic.js'

export function createPlayer(width, height) {
  return { x: width / 2, y: height - 60, radius: 14, speed: 320, shield: false }
}

export function movePlayer(player, input, dt, width) {
  if (input.left) player.x -= player.speed * dt
  if (input.right) player.x += player.speed * dt
  player.x = Math.min(width - player.radius, Math.max(player.radius, player.x))
}

export function playerHit(player, asteroid) {
  return circlesCollide(player, asteroid)
}
