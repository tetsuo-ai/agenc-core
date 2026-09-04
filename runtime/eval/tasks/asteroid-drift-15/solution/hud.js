const KEY_BEST = 'asteroid-drift-best'
const KEY_SCORES = 'asteroid-drift-scores'

export function loadBest() {
  return Number(localStorage.getItem(KEY_BEST) || 0)
}

export function saveBest(score) {
  localStorage.setItem(KEY_BEST, String(score))
}

export function loadScores() {
  try {
    return JSON.parse(localStorage.getItem(KEY_SCORES) || '[]')
  } catch {
    return []
  }
}

export function saveScores(table) {
  localStorage.setItem(KEY_SCORES, JSON.stringify(table))
}

export function drawHud(ctx, state, width) {
  ctx.fillStyle = '#fff'
  ctx.font = '16px monospace'
  ctx.fillText(`score ${state.score}  best ${state.best}  level ${state.level}`, 12, 24)
  if (state.muted) ctx.fillText('muted (M)', width - 110, 24)
  if (state.banner) ctx.fillText(state.banner, width / 2 - 40, 60)
}

export function drawCenter(ctx, lines, width, height) {
  ctx.fillStyle = '#fff'
  ctx.font = '24px monospace'
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2 - line.length * 6.5, height / 2 + index * 32)
  })
}

export function drawScores(ctx, table, width, height) {
  ctx.font = '18px monospace'
  table.forEach((entry, index) => {
    ctx.fillText(`${index + 1}. ${entry.initials}  ${entry.score}`, width / 2 - 70, height / 2 + 80 + index * 24)
  })
}
