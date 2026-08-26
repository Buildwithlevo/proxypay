import { pool, queryRead } from "../config/database";
import { DisputeModel, Dispute, DisputeStatus } from "../models/dispute";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuleType =
  | "duplicate_transaction"
  | "amount_mismatch"
  | "timeout_resolution"
  | "provider_failure"
  | "stale_dispute";

export type ResolutionAction = "resolve" | "reject" | "escalate";

export interface ResolutionRule {
  id: string;
  name: string;
  type: RuleType;
  enabled: boolean;
  priority: number;
  action: ResolutionAction;
  autoResolveStatus: DisputeStatus;
  thresholds: Record<string, number>;
}

export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  action: ResolutionAction;
  resolution: string | null;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface ResolutionResult {
  disputeId: string;
  evaluated: RuleEvaluationResult[];
  resolved: boolean;
  action: ResolutionAction | null;
  resolution: string | null;
  autoResolvedBy: string | null;
}

export interface DisputeResolutionConfig {
  enabled: boolean;
  rules: ResolutionRule[];
  defaultTimeoutMinutes: number;
  duplicateWindowMinutes: number;
  amountMismatchThresholdPercent: number;
  staleDisputeHours: number;
}

// ---------------------------------------------------------------------------
// Default rules
// ---------------------------------------------------------------------------

const DEFAULT_RULES: ResolutionRule[] = [
  {
    id: "duplicate-transaction",
    name: "Duplicate Transaction Detection",
    type: "duplicate_transaction",
    enabled: true,
    priority: 1,
    action: "resolve",
    autoResolveStatus: "resolved",
    thresholds: {
      windowMinutes: 5,
      amountTolerancePercent: 0,
    },
  },
  {
    id: "amount-mismatch-small",
    name: "Small Amount Mismatch Auto-Resolve",
    type: "amount_mismatch",
    enabled: true,
    priority: 2,
    action: "resolve",
    autoResolveStatus: "resolved",
    thresholds: {
      maxMismatchPercent: 1,
      minTransactionAge: 24,
    },
  },
  {
    id: "amount-mismatch-large",
    name: "Large Amount Mismatch Escalation",
    type: "amount_mismatch",
    enabled: true,
    priority: 3,
    action: "escalate",
    autoResolveStatus: "investigating",
    thresholds: {
      minMismatchPercent: 5,
    },
  },
  {
    id: "timeout-resolution",
    name: "Provider Timeout Auto-Resolve",
    type: "timeout_resolution",
    enabled: true,
    priority: 4,
    action: "resolve",
    autoResolveStatus: "resolved",
    thresholds: {
      maxProviderResponseMs: 30000,
    },
  },
  {
    id: "provider-failure",
    name: "Known Provider Failure",
    type: "provider_failure",
    enabled: true,
    priority: 5,
    action: "resolve",
    autoResolveStatus: "resolved",
    thresholds: {},
  },
  {
    id: "stale-dispute",
    name: "Stale Dispute Auto-Close",
    type: "stale_dispute",
    enabled: true,
    priority: 6,
    action: "reject",
    autoResolveStatus: "rejected",
    thresholds: {
      maxAgeHours: 720, // 30 days
    },
  },
];

// ---------------------------------------------------------------------------
// DisputeResolutionEngine
// ---------------------------------------------------------------------------

export class DisputeResolutionEngine {
  private disputeModel = new DisputeModel();
  private transactionModel = new TransactionModel();
  private config: DisputeResolutionConfig;

  constructor(config?: Partial<DisputeResolutionConfig>) {
    this.config = {
      enabled: true,
      rules: DEFAULT_RULES.map((r) => ({ ...r, thresholds: { ...r.thresholds } })),
      defaultTimeoutMinutes: 30,
      duplicateWindowMinutes: 5,
      amountMismatchThresholdPercent: 1,
      staleDisputeHours: 720,
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  getConfig(): DisputeResolutionConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  updateConfig(partial: Partial<DisputeResolutionConfig>): void {
    if (partial.enabled !== undefined) this.config.enabled = partial.enabled;
    if (partial.rules) this.config.rules = partial.rules;
    if (partial.defaultTimeoutMinutes !== undefined)
      this.config.defaultTimeoutMinutes = partial.defaultTimeoutMinutes;
    if (partial.duplicateWindowMinutes !== undefined)
      this.config.duplicateWindowMinutes = partial.duplicateWindowMinutes;
    if (partial.amountMismatchThresholdPercent !== undefined)
      this.config.amountMismatchThresholdPercent =
        partial.amountMismatchThresholdPercent;
    if (partial.staleDisputeHours !== undefined)
      this.config.staleDisputeHours = partial.staleDisputeHours;
  }

  toggleRule(ruleId: string, enabled: boolean): void {
    const rule = this.config.rules.find((r) => r.id === ruleId);
    if (rule) rule.enabled = enabled;
  }

  getRules(): ResolutionRule[] {
    return [...this.config.rules];
  }

  // -------------------------------------------------------------------------
  // Main evaluation
  // -------------------------------------------------------------------------

  async evaluateDispute(disputeId: string): Promise<ResolutionResult> {
    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    if (!this.config.enabled) {
      return {
        disputeId,
        evaluated: [],
        resolved: false,
        action: null,
        resolution: null,
        autoResolvedBy: null,
      };
    }

    const transaction = await this.transactionModel.findById(
      dispute.transactionId,
    );

    const enabledRules = this.config.rules
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority);

    const evaluations: RuleEvaluationResult[] = [];

    for (const rule of enabledRules) {
      const result = await this.evaluateRule(rule, dispute, transaction);
      evaluations.push(result);

      if (result.matched && result.action !== "escalate") {
        return {
          disputeId,
          evaluated: evaluations,
          resolved: true,
          action: result.action,
          resolution: result.resolution,
          autoResolvedBy: rule.id,
        };
      }
    }

    const escalateResult = evaluations.find(
      (e) => e.matched && e.action === "escalate",
    );

    if (escalateResult) {
      return {
        disputeId,
        evaluated: evaluations,
        resolved: false,
        action: "escalate",
        resolution: null,
        autoResolvedBy: escalateResult.ruleId,
      };
    }

    return {
      disputeId,
      evaluated: evaluations,
      resolved: false,
      action: null,
      resolution: null,
      autoResolvedBy: null,
    };
  }

  // -------------------------------------------------------------------------
  // Auto-resolve
  // -------------------------------------------------------------------------

  async autoResolve(disputeId: string): Promise<ResolutionResult> {
    const result = await this.evaluateDispute(disputeId);

    if (!result.resolved) {
      return result;
    }

    if (result.action === "resolve") {
      const dispute = await this.disputeModel.findById(disputeId);
      if (dispute && dispute.status !== "resolved") {
        await this.disputeModel.update(disputeId, {
          status: "resolved",
          resolution: result.resolution ?? "Auto-resolved by rule engine",
        });

        if (dispute.status === "open") {
          await this.transactionModel.updateStatus(
            dispute.transactionId,
            TransactionStatus.Completed,
          );
        }
      }
    } else if (result.action === "reject") {
      const dispute = await this.disputeModel.findById(disputeId);
      if (dispute && dispute.status !== "rejected") {
        await this.disputeModel.update(disputeId, {
          status: "rejected",
          resolution: result.resolution ?? "Auto-rejected by rule engine",
        });
      }
    }

    logger.info(
      {
        disputeId,
        action: result.action,
        ruleId: result.autoResolvedBy,
      },
      "Dispute auto-resolved by rule engine",
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Batch processing
  // -------------------------------------------------------------------------

  async processOpenDisputes(): Promise<{
    processed: number;
    resolved: number;
    rejected: number;
    escalated: number;
  }> {
    const disputes = await this.disputeModel.findSlaWarningCandidates();
    let resolved = 0;
    let rejected = 0;
    let escalated = 0;

    for (const dispute of disputes) {
      try {
        const result = await this.autoResolve(dispute.id);
        if (result.resolved) {
          if (result.action === "resolve") resolved++;
          else if (result.action === "reject") rejected++;
        } else if (result.action === "escalate") {
          escalated++;
        }
      } catch (error) {
        logger.error(
          { error, disputeId: dispute.id },
          "Failed to auto-resolve dispute",
        );
      }
    }

    return {
      processed: disputes.length,
      resolved,
      rejected,
      escalated,
    };
  }

  // -------------------------------------------------------------------------
  // Rule evaluation
  // -------------------------------------------------------------------------

  private async evaluateRule(
    rule: ResolutionRule,
    dispute: Dispute,
    transaction: any,
  ): Promise<RuleEvaluationResult> {
    switch (rule.type) {
      case "duplicate_transaction":
        return this.evaluateDuplicateTransaction(rule, dispute, transaction);
      case "amount_mismatch":
        return this.evaluateAmountMismatch(rule, dispute, transaction);
      case "timeout_resolution":
        return this.evaluateTimeout(rule, dispute, transaction);
      case "provider_failure":
        return this.evaluateProviderFailure(rule, dispute, transaction);
      case "stale_dispute":
        return this.evaluateStaleDispute(rule, dispute, transaction);
      default:
        return this.noMatch(rule);
    }
  }

  private async evaluateDuplicateTransaction(
    rule: ResolutionRule,
    dispute: Dispute,
    transaction: any,
  ): Promise<RuleEvaluationResult> {
    if (!transaction) {
      return this.noMatch(rule);
    }

    const windowMinutes = rule.thresholds.windowMinutes ?? 5;
    const windowStart = new Date(
      Date.now() - windowMinutes * 60 * 1000,
    ).toISOString();

    const { rows } = await queryRead<{ duplicate_count: number }>(
      `SELECT COUNT(*)::int AS duplicate_count
       FROM transactions
       WHERE phone_number = $1
         AND amount = $2
         AND provider = $3
         AND id != $4
         AND created_at >= $5
         AND created_at <= $6`,
      [
        transaction.phoneNumber,
        transaction.amount,
        transaction.provider,
        transaction.id,
        windowStart,
        new Date().toISOString(),
      ],
    );

    const duplicateCount = rows[0]?.duplicate_count ?? 0;

    if (duplicateCount > 0) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        matched: true,
        action: rule.action,
        resolution: `Duplicate transaction detected within ${windowMinutes} minute window (${duplicateCount} duplicates found). Transaction amount: ${transaction.amount} ${transaction.provider}.`,
        confidence: Math.min(0.9, 0.5 + duplicateCount * 0.1),
        metadata: { duplicateCount, windowMinutes },
      };
    }

    return this.noMatch(rule);
  }

  private async evaluateAmountMismatch(
    rule: ResolutionRule,
    dispute: Dispute,
    transaction: any,
  ): Promise<RuleEvaluationResult> {
    if (!transaction) return this.noMatch(rule);

    const reasonLower = dispute.reason.toLowerCase();
    const amountKeywords = ["amount", "charged", "received", "wrong amount", "incorrect amount"];
    const hasAmountKeyword = amountKeywords.some((kw) => reasonLower.includes(kw));

    if (!hasAmountKeyword) return this.noMatch(rule);

    const transactionAmount = parseFloat(transaction.amount);
    const disputeAmountMatch = dispute.reason.match(/(\d+[\.,]?\d*)/);
    if (!disputeAmountMatch) return this.noMatch(rule);

    const claimedAmount = parseFloat(
      disputeAmountMatch[1].replace(",", "."),
    );
    if (isNaN(claimedAmount) || transactionAmount === 0) return this.noMatch(rule);

    const diffPercent =
      (Math.abs(transactionAmount - claimedAmount) / transactionAmount) * 100;

    const maxMismatch = rule.thresholds.maxMismatchPercent ?? 100;
    const minMismatch = rule.thresholds.minMismatchPercent ?? 0;

    if (diffPercent <= maxMismatch && diffPercent >= minMismatch) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        matched: true,
        action: rule.action,
        resolution: `Amount mismatch of ${diffPercent.toFixed(2)}% detected. Transaction amount: ${transactionAmount}, claimed: ${claimedAmount}.`,
        confidence: Math.max(0.5, 1 - diffPercent / 100),
        metadata: { diffPercent, transactionAmount, claimedAmount },
      };
    }

    return this.noMatch(rule);
  }

  private async evaluateTimeout(
    rule: ResolutionRule,
    dispute: Dispute,
    transaction: any,
  ): Promise<RuleEvaluationResult> {
    if (!transaction) return this.noMatch(rule);

    if (transaction.status !== TransactionStatus.Failed) return this.noMatch(rule);

    const reasonLower = dispute.reason.toLowerCase();
    const timeoutKeywords = ["timeout", "timed out", "no response", "pending"];
    const hasTimeoutKeyword = timeoutKeywords.some((kw) =>
      reasonLower.includes(kw),
    );

    if (!hasTimeoutKeyword) return this.noMatch(rule);

    const transactionAge =
      Date.now() - new Date(transaction.createdAt).getTime();
    const maxAge = (rule.thresholds.maxProviderResponseMs ?? 30000) * 10;

    if (transactionAge > maxAge) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        matched: true,
        action: rule.action,
        resolution: `Transaction failed with timeout after ${Math.round(transactionAge / 60000)} minutes. Provider did not respond.`,
        confidence: 0.8,
        metadata: { transactionAge, maxAge },
      };
    }

    return this.noMatch(rule);
  }

  private async evaluateProviderFailure(
    rule: ResolutionRule,
    dispute: Dispute,
    transaction: any,
  ): Promise<RuleEvaluationResult> {
    if (!transaction) return this.noMatch(rule);

    if (transaction.status !== TransactionStatus.Failed) return this.noMatch(rule);

    const knownProviderErrors = [
      "provider_unavailable",
      "provider_maintenance",
      "provider_timeout",
      "network_error",
      "internal_error",
    ];

    const errorField = transaction.errorCode ?? transaction.lastError ?? "";
    const isKnownError = knownProviderErrors.some((e) =>
      errorField.toLowerCase().includes(e),
    );

    if (isKnownError) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        matched: true,
        action: rule.action,
        resolution: `Transaction failed due to known provider error: ${errorField}. No customer fault detected.`,
        confidence: 0.9,
        metadata: { errorCode: errorField },
      };
    }

    return this.noMatch(rule);
  }

  private evaluateStaleDispute(
    rule: ResolutionRule,
    dispute: Dispute,
    _transaction: any,
  ): Promise<RuleEvaluationResult> {
    const maxAgeHours = rule.thresholds.maxAgeHours ?? 720;
    const disputeAge =
      Date.now() - new Date(dispute.createdAt).getTime();
    const ageHours = disputeAge / (1000 * 60 * 60);

    if (ageHours > maxAgeHours && dispute.status === "open") {
      return Promise.resolve({
        ruleId: rule.id,
        ruleName: rule.name,
        matched: true,
        action: rule.action,
        resolution: `Dispute has been open for ${Math.round(ageHours)} hours without activity, exceeding threshold of ${maxAgeHours} hours.`,
        confidence: 0.7,
        metadata: { ageHours, maxAgeHours },
      });
    }

    return Promise.resolve(this.noMatch(rule));
  }

  private noMatch(rule: ResolutionRule): RuleEvaluationResult {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: false,
      action: rule.action,
      resolution: null,
      confidence: 0,
      metadata: {},
    };
  }
}

export const disputeResolutionEngine = new DisputeResolutionEngine();
