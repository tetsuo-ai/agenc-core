import { createPlayer, movePlayer, playerHit } from './player.js'
import { spawnAsteroid, stepAsteroids } from './asteroids.js'
import { drawHud, drawCenter, drawScores, loadBest, saveBest, loadScores, saveScores } from './hud.js'
import { explode, stepParticles, shakeOffset } from './effects.js'
import { beep, loadMuted, saveMuted } from './audio.js'
import { spawnPowerup, stepPowerups, applyPowerup } from './powerups.js'
import { circlesCollide, scoreForElapsed, levelForScore, spawnIntervalForLevel, insertHighScore } from './logic.js'

const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')
const input = { left: false, right: false }
let state = null
let last = performance.now()

function resize() {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
}

function reset() {
  state = {
    mode: 'start',
    player: createPlayer(canvas.width, canvas.height),
    asteroids: [],
    particles: [],
    powerups: [],
    elapsedMs: 0,
    score: 0,
    best: loadBest(),
    level: 1,
    banner: '',
    bannerUntil: 0,
    shake: 0,
    slowUntil: 0,
    muted: loadMuted(),
    sinceSpawn: 0,
    sincePowerup: 0,
    initials: '',
    scores: loadScores(),
  }
}

function gameOver() {
  explode(state.particles, state.player.x, state.player.y)
  state.shake = 1
  beep(110, 400, state.muted)
  if (state.score > state.best) {
    state.best = state.score
    saveBest(state.best)
  }
  state.mode = 'enter-initials'
}

function update(dt) {
  if (state.mode !== 'playing') return
  const timeScale = state.elapsedMs < state.slowUntil ? 0.4 : 1
  state.elapsedMs += dt * 1000
  state.score = scoreForElapsed(state.elapsedMs)
  const level = levelForScore(state.score)
  if (level !== state.level) {
    state.level = level
    state.banner = `Level ${level}`
    state.bannerUntil = state.elapsedMs + 1500
    beep(660, 120, state.muted)
  }
  if (state.elapsedMs > state.bannerUntil) state.banner = ''
  movePlayer(state.player, input, dt, canvas.width)
  state.sinceSpawn += dt * 1000
  const speedScale = 1 + state.elapsedMs / 60000
  if (state.sinceSpawn > spawnIntervalForLevel(state.level)) {
    state.sinceSpawn = 0
    state.asteroids.push(spawnAsteroid(canvas.width, speedScale))
  }
  state.sincePowerup += dt * 1000
  if (state.sincePowerup > 10000) {
    state.sincePowerup = 0
    state.powerups.push(spawnPowerup(canvas.width))
  }
  state.asteroids = stepAsteroids(state.asteroids, dt, canvas.height, timeScale)
  state.powerups = stepPowerups(state.powerups, dt, canvas.height)
  state.particles = stepParticles(state.particles, dt)
  state.shake = Math.max(0, state.shake - dt * 2)
  for (const powerup of state.powerups) {
    if (circlesCollide(state.player, powerup)) {
      applyPowerup(state, powerup)
      powerup.y = canvas.height + 100
      beep(880, 100, state.muted)
    }
  }
  for (const asteroid of state.asteroids) {
    if (playerHit(state.player, asteroid)) {
      if (state.player.shield) {
        state.player.shield = false
        asteroid.y = canvas.height + 100
        state.shake = 0.4
        continue
      }
      gameOver()
      return
    }
  }
}

function draw() {
  const offset = shakeOffset(state.shake)
  ctx.save()
  ctx.translate(offset.x, offset.y)
  ctx.fillStyle = '#000'
  ctx.fillRect(-20, -20, canvas.width + 40, canvas.height + 40)
  ctx.fillStyle = state.player.shield ? '#6cf' : '#fff'
  ctx.beginPath()
  ctx.arc(state.player.x, state.player.y, state.player.radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#999'
  for (const asteroid of state.asteroids) {
    ctx.beginPath()
    ctx.arc(asteroid.x, asteroid.y, asteroid.radius, 0, Math.PI * 2)
    ctx.fill()
  }
  for (const powerup of state.powerups) {
    ctx.fillStyle = powerup.kind === 'shield' ? '#6cf' : '#fc6'
    ctx.fillRect(powerup.x - 8, powerup.y - 8, 16, 16)
  }
  ctx.fillStyle = '#f80'
  for (const particle of state.particles) {
    ctx.fillRect(particle.x, particle.y, 3, 3)
  }
  drawHud(ctx, state, canvas.width)
  if (state.mode === 'start') drawCenter(ctx, ['Asteroid Drift', 'press space or tap to start'], canvas.width, canvas.height)
  if (state.mode === 'paused') drawCenter(ctx, ['Paused', 'press P to resume'], canvas.width, canvas.height)
  if (state.mode === 'enter-initials') drawCenter(ctx, ['Game Over', `enter initials: ${state.initials}_`], canvas.width, canvas.height)
  if (state.mode === 'gameover') {
    drawCenter(ctx, ['Game Over', 'top scores', 'press space to restart'], canvas.width, canvas.height)
    drawScores(ctx, state.scores, canvas.width, canvas.height)
  }
  ctx.restore()
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  update(dt)
  draw()
  requestAnimationFrame(frame)
}

function commitInitials() {
  state.scores = insertHighScore(state.scores, { initials: state.initials || 'AAA', score: state.score })
  saveScores(state.scores)
  state.mode = 'gameover'
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'ArrowLeft' || event.code === 'KeyA') input.left = true
  if (event.code === 'ArrowRight' || event.code === 'KeyD') input.right = true
  if (event.code === 'KeyM') {
    state.muted = !state.muted
    saveMuted(state.muted)
  }
  if (event.code === 'KeyP' && state.mode === 'playing') state.mode = 'paused'
  else if (event.code === 'KeyP' && state.mode === 'paused') state.mode = 'playing'
  if (event.code === 'Space' && (state.mode === 'start' || state.mode === 'gameover')) {
    reset()
    state.mode = 'playing'
  }
  if (state.mode === 'enter-initials') {
    if (/^Key[A-Z]$/.test(event.code) && state.initials.length < 3) state.initials += event.code.slice(3)
    if (event.code === 'Backspace') state.initials = state.initials.slice(0, -1)
    if (event.code === 'Enter') commitInitials()
  }
})

window.addEventListener('keyup', (event) => {
  if (event.code === 'ArrowLeft' || event.code === 'KeyA') input.left = false
  if (event.code === 'ArrowRight' || event.code === 'KeyD') input.right = false
})

window.addEventListener('blur', () => {
  input.left = false
  input.right = false
})

canvas.addEventListener('pointerdown', (event) => {
  if (state.mode === 'start' || state.mode === 'gameover') {
    reset()
    state.mode = 'playing'
    return
  }
  if (state.mode === 'enter-initials') {
    commitInitials()
    return
  }
  state.player.x = event.clientX
})

canvas.addEventListener('pointermove', (event) => {
  if (state.mode === 'playing' && event.buttons > 0) state.player.x = event.clientX
})

window.addEventListener('resize', resize)
resize()
reset()
requestAnimationFrame(frame)
