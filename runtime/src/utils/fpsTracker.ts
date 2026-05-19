export type FpsMetrics = {
  averageFps: number
  low1PctFps: number
  sampleCount: number
}

export class FpsTracker {
  private frameDurations: number[] = []

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return
    }
    this.frameDurations.push(durationMs)
  }

  getMetrics(): FpsMetrics | undefined {
    if (this.frameDurations.length === 0) {
      return undefined
    }

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
