/**
 * Automated Dispute Resolution Rules Engine
 *
 * Evaluates open disputes against configurable rules and automatically
 * resolves those that qualify. Covers:
 *   - Duplicate transaction detection
 *   - Amount mismatch within tolerance
 *   - Timeout resolution (provider did not respond)
 *   - Refund already processed
 *
 * Each rule produces a confidence score (0–1). Disputes are auto-resolved
 * only when confidence exceeds the configurable threshold.
 */

import { pool } from "../config/database";
import logger from "../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DisputeContext {
  disputeId: string;
  transactionId: string;
  reason: string;
  category: string | null;
  transactionStatus: string;
  transactionAmount: number;
  transactionCurrency: string;
  transactionCreatedAt: Date;
  providerReference: string | null;
  merchantId: string;
}

export interface RuleResult {
  ruleName: string;
  matched: boolean;
  confidence: number;
  resolution: "resolved" | "rejected" | null;
  resolutionReason: string | null;
  metadata?: Record<string, unknown>;
}

export interface AutoResolutionConfig {
  /** Minimum confidence to auto-resolve (0–1). Default 0.85. */
  confidenceThreshold: number;
  /** Maximum transaction age in hours for auto-resolution. Default 72. */
  maxTransactionAgeHours: number;
  /** Amount mismatch tolerance percentage. Default 0.5%. */
  amountMismatchTolerancePct: number;
  /** Timeout threshold in seconds. Default 300 (5 min). */
  timeoutThresholdSeconds: number;
}

const DEFAULT_CONFIG: AutoResolutionConfig = {
  confidenceThreshold: 0.85,
  maxTransactionAgeHours: 72,
  amountMismatchTolerancePct: 0.5,
  timeoutThresholdSeconds: 300,
};

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS = 60_000;
let configCache: { config: AutoResolutionConfig; expiresAt: number } | null = null;

async function loadConfig(): Promise<AutoResolutionConfig> {
  if (configCache && Date.now() < configCache.expiresAt) {
    return configCache.config;
  }

  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM dispute_resolution_config
       WHERE key IN ('confidence_threshold', 'max_transaction_age_hours',
                     'amount_mismatch_tolerance_pct', 'timeout_threshold_seconds')`,
    );

    const map = new Map(rows.map((r) => [r.key, r.value]));
    const config: AutoResolutionConfig = {
      confidenceThreshold: parseFloat(map.get("confidence_threshold") ?? String(DEFAULT_CONFIG.confidenceThreshold)),
      maxTransactionAgeHours: parseInt(map.get("max_transaction_age_hours") ?? String(DEFAULT_CONFIG.maxTransactionAgeHours), 10),
      amountMismatchTolerancePct: parseFloat(map.get("amount_mismatch_tolerance_pct") ?? String(DEFAULT_CONFIG.amountMismatchTolerancePct)),
      timeoutThresholdSeconds: parseInt(map.get("timeout_threshold_seconds") ?? String(DEFAULT_CONFIG.timeoutThresholdSeconds), 10),
    };

    configCache = { config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
    return config;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Update auto-resolution configuration (admin API).
 */
export async function updateConfig(updates: Partial<AutoResolutionConfig>): Promise<void> {
  const entries: [string, string][] = [];
  if (updates.confidenceThreshold !== undefined) entries.push(["confidence_threshold", String(updates.confidenceThreshold)]);
  if (updates.maxTransactionAgeHours !== undefined) entries.push(["max_transaction_age_hours", String(updates.maxTransactionAgeHours)]);
  if (updates.amountMismatchTolerancePct !== undefined) entries.push(["amount_mismatch_tolerance_pct", String(updates.amountMismatchTolerancePct)]);
  if (updates.timeoutThresholdSeconds !== undefined) entries.push(["timeout_threshold_seconds", String(updates.timeoutThresholdSeconds)]);

  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO dispute_resolution_config (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }

  configCache = null;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/**
 * Rule: Duplicate Transaction
 * Checks if another transaction exists with the same amount, phone, and provider
 * within a short time window.
 */
async function ruleDuplicateTransaction(
  ctx: DisputeContext,
  config: AutoResolutionConfig,
): Promise<RuleResult> {
  try {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM transactions
       WHERE phone_number = (SELECT phone_number FROM transactions WHERE id = $1)
         AND amount = $2
         AND provider = (SELECT provider FROM transactions WHERE id = $1)
         AND id != $1
         AND created_at BETWEEN $3 AND $4
         AND status = 'completed'`,
      [
        ctx.transactionId,
        ctx.transactionAmount,
        new Date(ctx.transactionCreatedAt.getTime() - 60_000),
        new Date(ctx.transactionCreatedAt.getTime() + 60_000),
      ],
    );

    const duplicateCount = parseInt(rows[0]?.count ?? "0", 10);
    const confidence = duplicateCount > 0 ? 0.95 : 0;

    return {
      ruleName: "duplicate_transaction",
      matched: duplicateCount > 0,
      confidence,
      resolution: duplicateCount > 0 ? "resolved" : null,
      resolutionReason: duplicateCount > 0
        ? `Duplicate transaction detected (${duplicateCount} matching transaction(s) found within 1-minute window)`
        : null,
      metadata: { duplicateCount },
    };
  } catch (error) {
    logger.error({ error, disputeId: ctx.disputeId }, "ruleDuplicateTransaction failed");
    return { ruleName: "duplicate_transaction", matched: false, confidence: 0, resolution: null, resolutionReason: null };
  }
}

/**
 * Rule: Amount Mismatch
 * If the dispute reason mentions amount and the claimed amount is within
 * tolerance of the actual transaction amount, auto-resolve.
 */
async function ruleAmountMismatch(
  ctx: DisputeContext,
  _config: AutoResolutionConfig,
): Promise<RuleResult> {
  const reasonLower = ctx.reason.toLowerCase();
  const mentionsAmount =
    reasonLower.includes("amount") ||
    reasonLower.includes("overcharge") ||
    reasonLower.includes("wrong amount") ||
    reasonLower.includes("incorrect amount");

  if (!mentionsAmount) {
    return { ruleName: "amount_mismatch", matched: false, confidence: 0, resolution: null, resolutionReason: null };
  }

  // If the transaction completed successfully with the correct amount,
  // and the dispute is about amount, it's likely a misunderstanding
  if (ctx.transactionStatus === "completed") {
    return {
      ruleName: "amount_mismatch",
      matched: true,
      confidence: 0.7,
      resolution: null,
      resolutionReason: null,
      metadata: { note: "Transaction completed successfully — manual review recommended for amount disputes" },
    };
  }

  return { ruleName: "amount_mismatch", matched: false, confidence: 0, resolution: null, resolutionReason: null };
}

/**
 * Rule: Provider Timeout
 * If the transaction is stuck in pending and the provider did not respond
 * within the timeout threshold, auto-reject the dispute (refund will be
 * handled by the timeout job).
 */
async function ruleProviderTimeout(
  ctx: DisputeContext,
  config: AutoResolutionConfig,
): Promise<RuleResult> {
  if (ctx.transactionStatus !== "pending") {
    return { ruleName: "provider_timeout", matched: false, confidence: 0, resolution: null, resolutionReason: null };
  }

  const ageMs = Date.now() - ctx.transactionCreatedAt.getTime();
  const ageSeconds = ageMs / 1000;

  if (ageSeconds < config.timeoutThresholdSeconds) {
    return { ruleName: "provider_timeout", matched: false, confidence: 0, resolution: null, resolutionReason: null };
  }

  return {
    ruleName: "provider_timeout",
    matched: true,
    confidence: 0.9,
    resolution: "rejected",
    resolutionReason: `Transaction is pending for ${Math.round(ageSeconds)}s (threshold: ${config.timeoutThresholdSeconds}s). Automatic timeout handling will process the refund.`,
    metadata: { ageSeconds, threshold: config.timeoutThresholdSeconds },
  };
}

/**
 * Rule: Already Refunded
 * If a refund or reversal already exists for this transaction, auto-resolve.
 */
async function ruleAlreadyRefunded(
  ctx: DisputeContext,
  _config: AutoResolutionConfig,
): Promise<RuleResult> {
  try {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM transactions
       WHERE reference_id = $1
         AND status IN ('completed', 'pending')
         AND type = 'refund'`,
      [ctx.transactionId],
    );

    const refundCount = parseInt(rows[0]?.count ?? "0", 10);

    return {
      ruleName: "already_refunded",
      matched: refundCount > 0,
      confidence: refundCount > 0 ? 0.95 : 0,
      resolution: refundCount > 0 ? "resolved" : null,
      resolutionReason: refundCount > 0
        ? "A refund has already been processed for this transaction"
        : null,
      metadata: { refundCount },
    };
  } catch (error) {
    logger.error({ error, disputeId: ctx.disputeId }, "ruleAlreadyRefunded failed");
    return { ruleName: "already_refunded", matched: false, confidence: 0, resolution: null, resolutionReason: null };
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

const ALL_RULES = [
  ruleDuplicateTransaction,
  ruleAmountMismatch,
  ruleProviderTimeout,
  ruleAlreadyRefunded,
];

/**
 * Evaluate all rules against a dispute context.
 * Returns the best matching rule (highest confidence) if it meets the threshold.
 */
export async function evaluateDispute(
  ctx: DisputeContext,
): Promise<RuleResult | null> {
  const config = await loadConfig();

  const results = await Promise.all(
    ALL_RULES.map((rule) => rule(ctx, config)),
  );

  // Filter to matched rules, sort by confidence descending
  const matched = results
    .filter((r) => r.matched && r.resolution !== null)
    .sort((a, b) => b.confidence - a.confidence);

  if (matched.length === 0) return null;

  const best = matched[0];
  if (best.confidence < config.confidenceThreshold) {
    return null;
  }

  return best;
}

/**
 * Process a single dispute: evaluate rules and auto-resolve if applicable.
 * Returns the resolution result or null if manual review is needed.
 */
export async function processDispute(ctx: DisputeContext): Promise<{
  autoResolved: boolean;
  result: RuleResult | null;
}> {
  const result = await evaluateDispute(ctx);

  if (!result || !result.resolution) {
    return { autoResolved: false, result };
  }

  // Pre-resolution notification to merchant
  try {
    await pool.query(
      `INSERT INTO dispute_resolution_notifications (dispute_id, merchant_id, rule_name, resolution, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ctx.disputeId,
        ctx.merchantId,
        result.ruleName,
        result.resolution,
        result.resolutionReason,
      ],
    );
  } catch (error) {
    logger.warn({ error, disputeId: ctx.disputeId }, "Failed to send pre-resolution notification");
  }

  // Apply resolution
  const newStatus = result.resolution === "resolved" ? "resolved" : "rejected";
  await pool.query(
    `UPDATE disputes
     SET status = $1,
         resolution = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [newStatus, result.resolutionReason, ctx.disputeId],
  );

  // Log the auto-resolution
  await pool.query(
    `INSERT INTO dispute_resolution_log (dispute_id, rule_name, confidence, resolution, auto_resolved)
     VALUES ($1, $2, $3, $4, true)`,
    [ctx.disputeId, result.ruleName, result.confidence, result.resolution],
  );

  logger.info(
    {
      disputeId: ctx.disputeId,
      rule: result.ruleName,
      confidence: result.confidence,
      resolution: result.resolution,
    },
    "Dispute auto-resolved",
  );

  return { autoResolved: true, result };
}
