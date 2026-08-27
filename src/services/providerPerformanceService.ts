/**
 * Provider Performance Optimization
 *
 * Latency-aware provider selection with success rate scoring, sticky sessions,
 * and admin-configurable weights. Uses an exponential moving average (EMA) for
 * smoothing latency observations so recent performance has more influence.
 */

import { pool } from "../config/database";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProviderName = "mtn" | "airtel" | "orange";

export interface ProviderScore {
  provider: ProviderName;
  /** Composite score 0-100. Higher = better. */
  score: number;
  /** EMA of latency in ms. */
  avgLatencyMs: number;
  /** Success rate 0-1. */
  successRate: number;
  /** Total calls in the scoring window. */
  totalCalls: number;
  /** Whether this provider is sticky (preferred for the current session). */
  sticky: boolean;
}

export interface ScoringWeights {
  /** Weight for latency score component (default 40). */
  latencyWeight: number;
  /** Weight for success rate component (default 60). */
  successWeight: number;
  /** EMA smoothing factor 0-1 (default 0.3). */
  emaAlpha: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  latencyWeight: 40,
  successWeight: 60,
  emaAlpha: 0.3,
};

// ─── In-Memory Score Cache ────────────────────────────────────────────────────

const SCORE_CACHE_KEY = "provider:performance:scores";
const SCORE_CACHE_TTL_MS = 60_000; // 1 minute

interface ScoreCacheEntry {
  scores: ProviderScore[];
  expiresAt: number;
}

let localCache: ScoreCacheEntry | null = null;

// ─── EMA Latency Tracking ────────────────────────────────────────────────────

const emaLatencies = new Map<ProviderName, number>();
const callCounts = new Map<ProviderName, number>();
const successCounts = new Map<ProviderName, number>();

export function recordProviderCall(
  provider: ProviderName,
  latencyMs: number,
  success: boolean,
  alpha: number = DEFAULT_WEIGHTS.emaAlpha,
): void {
  // Update EMA latency
  const prev = emaLatencies.get(provider) ?? latencyMs;
  emaLatencies.set(provider, prev * (1 - alpha) + latencyMs * alpha);

  // Update counts
  callCounts.set(provider, (callCounts.get(provider) ?? 0) + 1);
  if (success) {
    successCounts.set(provider, (successCounts.get(provider) ?? 0) + 1);
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const MAX_LATENCY_MS = 10_000; // assumed max for normalization

function computeScores(weights: ScoringWeights = DEFAULT_WEIGHTS): ProviderScore[] {
  const providers: ProviderName[] = ["mtn", "airtel", "orange"];

  return providers.map((provider) => {
    const latency = emaLatencies.get(provider) ?? 0;
    const total = callCounts.get(provider) ?? 0;
    const successes = successCounts.get(provider) ?? 0;
    const successRate = total > 0 ? successes / total : 1;

    // Latency score: 100 when 0ms, 0 when >= MAX_LATENCY_MS
    const latencyScore = Math.max(
      0,
      Math.min(100, 100 * (1 - latency / MAX_LATENCY_MS)),
    );

    const successScore = successRate * 100;

    const score =
      (latencyScore * weights.latencyWeight + successScore * weights.successWeight) /
      (weights.latencyWeight + weights.successWeight);

    return {
      provider,
      score: Math.round(score * 100) / 100,
      avgLatencyMs: Math.round(latency * 100) / 100,
      successRate: Math.round(successRate * 10000) / 10000,
      totalCalls: total,
      sticky: false,
    };
  });
}

// ─── Sticky Sessions ──────────────────────────────────────────────────────────

const stickySessions = new Map<string, ProviderName>(); // sessionKey → provider

export function setStickySession(
  sessionKey: string,
  provider: ProviderName,
): void {
  stickySessions.set(sessionKey, provider);
}

export function clearStickySession(sessionKey: string): void {
  stickySessions.delete(sessionKey);
}

export function getStickyProvider(sessionKey: string): ProviderName | null {
  return stickySessions.get(sessionKey) ?? null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Select the best provider for a given session.
 * Considers latency, success rate, and sticky preference.
 */
export async function selectBestProvider(
  sessionKey?: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): Promise<ProviderScore> {
  // Check sticky session first
  if (sessionKey) {
    const sticky = getStickyProvider(sessionKey);
    if (sticky) {
      const scores = computeScores(weights);
      const stickyScore = scores.find((s) => s.provider === sticky);
      if (stickyScore) {
        stickyScore.sticky = true;
        return stickyScore;
      }
    }
  }

  const scores = computeScores(weights);

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];

  // Set sticky session
  if (sessionKey && best) {
    setStickySession(sessionKey, best.provider);
  }

  return best;
}

/**
 * Get current performance rankings for all providers.
 * Uses Redis cache with 1-minute TTL, falls back to local calculation.
 */
export async function getProviderRankings(
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): Promise<ProviderScore[]> {
  // Check local cache
  if (localCache && Date.now() < localCache.expiresAt) {
    return localCache.scores;
  }

  // Try Redis cache
  try {
    const { redisClient } = await import("../config/redis");
    const raw = await redisClient.get(SCORE_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as ProviderScore[];
      localCache = { scores: cached, expiresAt: Date.now() + SCORE_CACHE_TTL_MS };
      return cached;
    }
  } catch {
    // Redis unavailable
  }

  const scores = computeScores(weights);

  // Sort by score descending for rankings
  scores.sort((a, b) => b.score - a.score);

  // Cache in Redis
  try {
    const { redisClient } = await import("../config/redis");
    await redisClient.setEx(
      SCORE_CACHE_KEY,
      Math.ceil(SCORE_CACHE_TTL_MS / 1000),
      JSON.stringify(scores),
    );
  } catch {
    // Redis write failure — continue with local cache
  }

  localCache = { scores, expiresAt: Date.now() + SCORE_CACHE_TTL_MS };
  return scores;
}

/**
 * Persist scoring weights to the database (admin configuration).
 */
export async function updateScoringWeights(
  latencyWeight: number,
  successWeight: number,
  emaAlpha: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_scoring_config (key, value)
     VALUES ('latency_weight', $1),
            ('success_weight', $2),
            ('ema_alpha', $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(latencyWeight), String(successWeight), String(emaAlpha)],
  );

  // Invalidate caches
  localCache = null;
  try {
    const { redisClient } = await import("../config/redis");
    await redisClient.del(SCORE_CACHE_KEY);
  } catch {
    // swallow
  }
}

/**
 * Load scoring weights from the database.
 */
export async function loadScoringWeights(): Promise<ScoringWeights> {
  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM provider_scoring_config
       WHERE key IN ('latency_weight', 'success_weight', 'ema_alpha')`,
    );

    const map = new Map(rows.map((r) => [r.key, r.value]));

    return {
      latencyWeight: parseFloat(map.get("latency_weight") ?? String(DEFAULT_WEIGHTS.latencyWeight)),
      successWeight: parseFloat(map.get("success_weight") ?? String(DEFAULT_WEIGHTS.successWeight)),
      emaAlpha: parseFloat(map.get("ema_alpha") ?? String(DEFAULT_WEIGHTS.emaAlpha)),
    };
  } catch {
    return DEFAULT_WEIGHTS;
  }
}
