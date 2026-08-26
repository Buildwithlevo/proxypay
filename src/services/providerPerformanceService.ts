import { pool } from "../config/database";
import { providerSettingsService } from "./providerSettingsService";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderName = "mtn" | "airtel" | "orange";

export interface PerformanceWeights {
  latencyWeight: number;
  successRateWeight: number;
  recencyWeight: number;
  stickyBonus: number;
}

export interface ProviderPerformanceMetrics {
  provider: ProviderName;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  totalCalls: number;
  recentCalls: number;
  lastFailureAt: string | null;
  latencyScore: number;
  successRateScore: number;
  compositeScore: number;
}

export interface PerformanceRanking {
  rankings: ProviderPerformanceMetrics[];
  weights: PerformanceWeights;
  generatedAt: string;
}

export interface StickySession {
  merchantId: string;
  provider: ProviderName;
  lockedAt: Date;
  expiresAt: Date;
}

export interface ScoringConfig {
  weights: PerformanceWeights;
  stickySessionTtlMs: number;
  latencyWindowMs: number;
  minCallsForScoring: number;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS: PerformanceWeights = {
  latencyWeight: 0.4,
  successRateWeight: 0.4,
  recencyWeight: 0.1,
  stickyBonus: 0.1,
};

const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: { ...DEFAULT_WEIGHTS },
  stickySessionTtlMs: 30 * 60 * 1000, // 30 minutes
  latencyWindowMs: 60 * 60 * 1000, // 1 hour
  minCallsForScoring: 5,
};

// ---------------------------------------------------------------------------
// ProviderPerformanceService
// ---------------------------------------------------------------------------

export class ProviderPerformanceService {
  private stickySessions: Map<string, StickySession> = new Map();
  private cachedRankings: PerformanceRanking | null = null;
  private rankingsCacheTtlMs = 60_000;
  private rankingsCacheExpiresAt = 0;
  private config: ScoringConfig = { ...DEFAULT_SCORING_CONFIG };

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  updateScoringConfig(partial: Partial<ScoringConfig>): void {
    if (partial.weights) {
      this.config.weights = { ...this.config.weights, ...partial.weights };
    }
    if (partial.stickySessionTtlMs !== undefined) {
      this.config.stickySessionTtlMs = partial.stickySessionTtlMs;
    }
    if (partial.latencyWindowMs !== undefined) {
      this.config.latencyWindowMs = partial.latencyWindowMs;
    }
    if (partial.minCallsForScoring !== undefined) {
      this.config.minCallsForScoring = partial.minCallsForScoring;
    }
    this.invalidateCache();
  }

  getScoringConfig(): ScoringConfig {
    return { ...this.config, weights: { ...this.config.weights } };
  }

  // -------------------------------------------------------------------------
  // Latency-aware provider selection
  // -------------------------------------------------------------------------

  async selectBestProvider(
    excludeProviders: ProviderName[] = [],
  ): Promise<ProviderName> {
    const rankings = await this.getPerformanceRankings();
    const available = rankings.rankings.filter(
      (r) => !excludeProviders.includes(r.provider),
    );

    if (available.length === 0) {
      return "mtn";
    }

    return available[0].provider;
  }

  async selectBestProviderForMerchant(
    merchantId: string,
    excludeProviders: ProviderName[] = [],
  ): Promise<ProviderName> {
    const sticky = this.stickySessions.get(merchantId);
    if (sticky && sticky.expiresAt > new Date()) {
      if (!excludeProviders.includes(sticky.provider)) {
        return sticky.provider;
      }
    }

    const best = await this.selectBestProvider(excludeProviders);
    this.setStickySession(merchantId, best);
    return best;
  }

  // -------------------------------------------------------------------------
  // Sticky sessions
  // -------------------------------------------------------------------------

  setStickySession(merchantId: string, provider: ProviderName): void {
    const now = new Date();
    this.stickySessions.set(merchantId, {
      merchantId,
      provider,
      lockedAt: now,
      expiresAt: new Date(now.getTime() + this.config.stickySessionTtlMs),
    });
  }

  getStickySession(merchantId: string): StickySession | null {
    const session = this.stickySessions.get(merchantId);
    if (!session) return null;
    if (session.expiresAt <= new Date()) {
      this.stickySessions.delete(merchantId);
      return null;
    }
    return session;
  }

  clearStickySession(merchantId: string): void {
    this.stickySessions.delete(merchantId);
  }

  clearAllStickySessions(): void {
    this.stickySessions.clear();
  }

  // -------------------------------------------------------------------------
  // Performance rankings
  // -------------------------------------------------------------------------

  async getPerformanceRankings(): Promise<PerformanceRanking> {
    if (this.cachedRankings && Date.now() < this.rankingsCacheExpiresAt) {
      return this.cachedRankings;
    }

    const rankings = await this.computePerformanceRankings();
    this.cachedRankings = rankings;
    this.rankingsCacheExpiresAt = Date.now() + this.rankingsCacheTtlMs;
    return rankings;
  }

  async computePerformanceRankings(): Promise<PerformanceRanking> {
    const providers: ProviderName[] = ["mtn", "airtel", "orange"];
    const windowStart = new Date(
      Date.now() - this.config.latencyWindowMs,
    ).toISOString();

    const metrics: ProviderPerformanceMetrics[] = [];

    for (const provider of providers) {
      const m = await this.computeProviderMetrics(provider, windowStart);
      metrics.push(m);
    }

    const weights = this.config.weights;

    for (const m of metrics) {
      m.latencyScore = this.normalizeLatencyScore(m.avgLatencyMs);
      m.successRateScore = m.successRate;
      m.compositeScore =
        m.latencyScore * weights.latencyWeight +
        m.successRateScore * weights.successRateWeight +
        m.successRateScore * weights.recencyWeight;
    }

    metrics.sort((a, b) => b.compositeScore - a.compositeScore);

    return {
      rankings: metrics,
      weights,
      generatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Record outcomes
  // -------------------------------------------------------------------------

  async recordProviderCall(
    provider: ProviderName,
    success: boolean,
    latencyMs: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO provider_api_calls (provider, success, duration_ms, called_at)
       VALUES ($1, $2, $3, NOW())`,
      [provider, success, latencyMs],
    );

    this.invalidateCache();
  }

  // -------------------------------------------------------------------------
  // Admin: reset sticky for merchant
  // -------------------------------------------------------------------------

  async resetMerchantStickySession(merchantId: string): Promise<void> {
    this.clearStickySession(merchantId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async computeProviderMetrics(
    provider: ProviderName,
    windowStart: string,
  ): Promise<ProviderPerformanceMetrics> {
    const { rows } = await pool.query<{
      total: string;
      successes: string;
      avg_latency: string | null;
      p95_latency: string | null;
      recent_calls: string;
      last_failure: string | null;
    }>(
      `SELECT
        COUNT(*)::text                                    AS total,
        COUNT(*) FILTER (WHERE success)::text             AS successes,
        AVG(duration_ms)::text                            AS avg_latency,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95_latency,
        COUNT(*) FILTER (WHERE called_at >= $2)::text     AS recent_calls,
        MAX(CASE WHEN NOT success THEN called_at END)::text AS last_failure
       FROM provider_api_calls
       WHERE provider = $1`,
      [provider, windowStart],
    );

    const row = rows[0];
    const totalCalls = Number(row.total) || 0;
    const successes = Number(row.successes) || 0;
    const avgLatency = row.avg_latency ? Number(row.avg_latency) : 0;
    const p95Latency = row.p95_latency ? Number(row.p95_latency) : 0;
    const recentCalls = Number(row.recent_calls) || 0;
    const successRate = totalCalls > 0 ? successes / totalCalls : 0;

    return {
      provider,
      avgLatencyMs: Math.round(avgLatency),
      p95LatencyMs: Math.round(p95Latency),
      successRate: Math.round(successRate * 1000) / 1000,
      totalCalls,
      recentCalls,
      lastFailureAt: row.last_failure,
      latencyScore: 0,
      successRateScore: 0,
      compositeScore: 0,
    };
  }

  private normalizeLatencyScore(avgLatencyMs: number): number {
    if (avgLatencyMs === 0) return 1;
    if (avgLatencyMs >= 10000) return 0;
    return Math.max(0, 1 - avgLatencyMs / 10000);
  }

  private invalidateCache(): void {
    this.cachedRankings = null;
    this.rankingsCacheExpiresAt = 0;
  }
}

export const providerPerformanceService = new ProviderPerformanceService();
