export type FpsMetrics = {
  averageFps: number
  low1PctFps: number
  sampleCount: number
}

// Ring-buffer capacity: ~2048 frames is ~34s at 60fps — plenty of history
// for a render-health signal, and it caps the getMetrics() sort so a long
// session can't grow an unbounded array.
const MAX_FRAME_SAMPLES = 2048

// getMetrics() is called from render bodies (App shell). Sorting the window
// is O(n log n), so cache the result and recompute at most once per second;
// render-path calls then stay O(1).
const METRICS_CACHE_MS = 1000

export class FpsTracker {
  private frameDurations: number[] = []
  private writeIndex = 0
  private cachedMetrics: FpsMetrics | undefined
  private metricsComputedAtMs = Number.NEGATIVE_INFINITY

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return
    }
    if (this.frameDurations.length < MAX_FRAME_SAMPLES) {
      this.frameDurations.push(durationMs)
    } else {
      this.frameDurations[this.writeIndex] = durationMs
    }
    this.writeIndex = (this.writeIndex + 1) % MAX_FRAME_SAMPLES
  }

  getMetrics(): FpsMetrics | undefined {
    if (this.frameDurations.length === 0) {
      return undefined
    }

    const nowMs = Date.now()
    if (
      this.cachedMetrics !== undefined &&
      nowMs - this.metricsComputedAtMs < METRICS_CACHE_MS
    ) {
      return this.cachedMetrics
    }

    const metrics = this.computeMetrics()
    if (metrics !== undefined) {
      this.cachedMetrics = metrics
      this.metricsComputedAtMs = nowMs
    }
    return metrics
  }

  private computeMetrics(): FpsMetrics | undefined {
    const totalTimeMs = this.frameDurations.reduce((sum, ms) => sum + ms, 0)
    if (totalTimeMs <= 0) {
      return undefined
    }

    const totalFrames = this.frameDurations.length
    const averageFps = totalFrames / (totalTimeMs / 1000)

    const sorted = this.frameDurations.slice().sort((a, b) => b - a)
    const lowFrameCount = Math.max(1, Math.ceil(sorted.length * 0.01))
    const lowFrameTimeMs =
      sorted.slice(0, lowFrameCount).reduce((sum, ms) => sum + ms, 0) /
      lowFrameCount
    const low1PctFps = lowFrameTimeMs > 0 ? 1000 / lowFrameTimeMs : 0
    const roundedAverageFps = Math.round(averageFps * 100) / 100
    const roundedLow1PctFps = Math.min(
      roundedAverageFps,
      Math.round(low1PctFps * 100) / 100,
    )

    return {
      averageFps: roundedAverageFps,
      low1PctFps: roundedLow1PctFps,
      sampleCount: totalFrames,
    }
  }
}
