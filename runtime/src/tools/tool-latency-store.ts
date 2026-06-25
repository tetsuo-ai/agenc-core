/**
 * Adaptive per-tool drain-timeout latency store (Goal #4a).
 *
 * Learns each tool's empirical latency distribution ONLINE and exposes a tail
 * estimate used to derive an adaptive drain deadline. Faithful to Continuum
 * (arXiv 2511.02230): per-key empirical CDF, K=100 sample-count ladder,
 * global-pool fallback, fixed cold-start default (handled by the CALLER, which
 * uses today's flat formula when this returns null).
 *
 * The statistic is `max(percentile(ring, P), ewmaMean + KSigma * ewmaStd)`:
 *   - the percentile is P^-1(P) of the per-tool empirical CDF (Continuum);
 *   - the EWMA term is TCP RTO's tail-safe estimator (RFC 6298, k=4);
 *   - the `max` biases toward RAISING (a tool is "fast" only when BOTH small).
 *
 * IN-MEMORY, SESSION-SCOPED. Cold start on a fresh session is acceptable and
 * intended (matches Continuum's online model). No durable persistence here.
 *
 * INVARIANTS (load-bearing — do not weaken):
 *   - `record()` must be called ONLY for clean completions, NEVER for
 *     force-finalized / leaked / errored runs. Recording a killed run would
 *     teach the store "this tool takes ~deadline ms" and RATCHET the deadline
 *     upward on every wedge. The caller enforces the gate; this class assumes
 *     every recorded sample is a real, clean latency.
 *   - This class never produces a deadline; it produces a raw latency estimate.
 *     The SAFE-MINIMUM floor that guarantees a legit run is never killed lives
 *     in the caller (`toolDrainDeadlineMs`).
 *
 * @module
 */

export interface ToolLatencyConfig {
  /** Continuum K — min samples before a per-tool / global stat is trusted. */
  readonly minSamples: number; // default 100
  /** Per-tool ring-buffer capacity (recent-sample window + memory bound). */
  readonly ringCap: number; // default 512
  /** Empirical-CDF quantile, P^-1(percentile). */
  readonly percentile: number; // default 0.99
  /** EWMA mean smoothing (RFC 6298 SRTT, 1/8). */
  readonly ewmaAlpha: number; // default 0.125
  /** EWMA deviation smoothing (RFC 6298 RTTVAR, 1/4). */
  readonly ewmaBeta: number; // default 0.25
  /** Deviation multiplier (RFC 6298 SRTT + 4*RTTVAR). */
  readonly kSigma: number; // default 4
}

export const DEFAULT_TOOL_LATENCY_CONFIG: ToolLatencyConfig = {
  minSamples: 100,
  ringCap: 512,
  percentile: 0.99,
  ewmaAlpha: 0.125,
  ewmaBeta: 0.25,
  kSigma: 4,
};

interface ToolLatencyStat {
  ring: Float64Array; // recent clean durations (ms), capacity = ringCap
  head: number; // next write index
  count: number; // valid entries in ring (<= ringCap)
  total: number; // lifetime clean samples (saturates; for the >= K gate)
  ewmaMean: number; // EWMA mean (ms)
  ewmaDev: number; // EWMA mean-absolute-deviation (ms)
  seeded: boolean; // first-sample seeding flag
}

export class ToolLatencyStore {
  private readonly perTool = new Map<string, ToolLatencyStat>();
  private readonly global: ToolLatencyStat;
  private readonly cfg: ToolLatencyConfig;

  constructor(config: Partial<ToolLatencyConfig> = {}) {
    this.cfg = { ...DEFAULT_TOOL_LATENCY_CONFIG, ...config };
    this.global = this.newStat();
  }

  private newStat(): ToolLatencyStat {
    return {
      ring: new Float64Array(this.cfg.ringCap),
      head: 0,
      count: 0,
      total: 0,
      ewmaMean: 0,
      ewmaDev: 0,
      seeded: false,
    };
  }

  /** Record one CLEAN-completion latency (ms). Never call for killed/leaked runs. */
  record(resolvedToolName: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    let stat = this.perTool.get(resolvedToolName);
    if (stat === undefined) {
      stat = this.newStat();
      this.perTool.set(resolvedToolName, stat);
    }
    this.ingest(stat, durationMs);
    this.ingest(this.global, durationMs); // pooled global distribution (fallback tier)
  }

  private ingest(stat: ToolLatencyStat, r: number): void {
    // ring (for the empirical percentile)
    stat.ring[stat.head] = r;
    stat.head = (stat.head + 1) % stat.ring.length;
    if (stat.count < stat.ring.length) stat.count += 1;
    if (stat.total < Number.MAX_SAFE_INTEGER) stat.total += 1;
    // EWMA (RFC 6298 order: deviation against the PRE-update mean)
    if (!stat.seeded) {
      stat.ewmaMean = r;
      stat.ewmaDev = r / 2;
      stat.seeded = true;
      return;
    }
    const { ewmaAlpha: a, ewmaBeta: b } = this.cfg;
    stat.ewmaDev = (1 - b) * stat.ewmaDev + b * Math.abs(r - stat.ewmaMean);
    stat.ewmaMean = (1 - a) * stat.ewmaMean + a * r;
  }

  /**
   * Raw adaptive latency estimate (ms) for a tool, or null when there is not
   * yet enough data and the CALLER must fall back to its fixed default.
   *
   * Ladder (Continuum K=100):
   *   total[name] >= K           -> per-tool max(percentile, ewma+k*dev)
   *   else global.total >= K     -> global  max(percentile, ewma+k*dev)
   *   else                        -> null (cold start)
   */
  estimateLatencyMs(resolvedToolName: string): number | null {
    const stat = this.perTool.get(resolvedToolName);
    if (stat !== undefined && stat.total >= this.cfg.minSamples) {
      return this.estimate(stat);
    }
    if (this.global.total >= this.cfg.minSamples) {
      return this.estimate(this.global);
    }
    return null; // cold start
  }

  private estimate(stat: ToolLatencyStat): number {
    const pct = this.percentileOf(stat, this.cfg.percentile);
    const ewma = stat.ewmaMean + this.cfg.kSigma * stat.ewmaDev;
    return Math.max(pct, ewma);
  }

  /** Nearest-rank percentile over the live ring window. */
  private percentileOf(stat: ToolLatencyStat, p: number): number {
    const n = stat.count;
    if (n === 0) return 0;
    const scratch = stat.ring.slice(0, n); // copy only the valid window
    scratch.sort();
    const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
    return scratch[idx]!;
  }
}
