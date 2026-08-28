import { pool } from '../config/database';
import logger from '../utils/logger';
import { FraudResult, FraudTransactionInput } from './fraud';

export interface FraudEvaluationLog {
  id: string;
  transactionId: string;
  userId: string | null;
  amount: number;
  phoneNumber: string;
  provider: string;
  type: string;
  status: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  deviceFingerprint: string | null;
  isFraud: boolean;
  score: number;
  riskLevel: string;
  recommendedAction: string;
  reasons: string[];
  heuristicsTriggered: string[];
  heuristicDetails: Record<string, unknown>;
  durationMs: number;
  transactionHistoryCount: number;
  createdAt: Date;
}

export interface FraudEvaluationFilter {
  userId?: string;
  isFraud?: boolean;
  riskLevel?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export const fraudLoggingService = {
  /**
   * Log a complete fraud evaluation result with full context to the database
   */
  logEvaluation: async (
    result: FraudResult,
    transactionInput: FraudTransactionInput,
    heuristicDetails: Record<string, unknown>,
    durationMs: number,
    transactionHistoryCount: number,
  ): Promise<string> => {
    const { v4: uuidv4 } = await import('uuid');
    const id = uuidv4();

    try {
      const query = `
        INSERT INTO fraud_evaluation_logs (
          id, transaction_id, user_id, amount, phone_number,
          provider, type, status, ip_address, user_agent,
          device_fingerprint, is_fraud, score, risk_level,
          recommended_action, reasons, heuristics_triggered,
          heuristic_details, duration_ms, transaction_history_count
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        RETURNING id
      `;

      await pool.query(query, [
        id,
        transactionInput.id,
        transactionInput.userId || null,
        transactionInput.amount,
        transactionInput.phoneNumber,
        transactionInput.provider,
        transactionInput.type,
        transactionInput.status || null,
        transactionInput.ipAddress || null,
        transactionInput.userAgent || null,
        transactionInput.deviceFingerprint || null,
        result.isFraud,
        result.score,
        result.riskLevel,
        result.recommendedAction,
        JSON.stringify(result.reasons),
        JSON.stringify(result.heuristicsTriggered),
        JSON.stringify(heuristicDetails),
        durationMs,
        transactionHistoryCount,
      ]);

      logger.debug({ evaluationLogId: id, transactionId: transactionInput.id }, 'Fraud evaluation logged to database');
      return id;
    } catch (error) {
      logger.error({ err: error, transactionId: transactionInput.id }, 'Failed to log fraud evaluation to database');
      return id;
    }
  },

  /**
   * Create a fraud alert record for flagged transactions
   */
  createAlert: async (
    evaluationLogId: string,
    result: FraudResult,
    transactionInput: FraudTransactionInput,
  ): Promise<string | null> => {
    const { v4: uuidv4 } = await import('uuid');
    const alertId = uuidv4();

    try {
      const query = `
        INSERT INTO fraud_alerts (
          id, evaluation_log_id, transaction_id, user_id,
          score, risk_level, recommended_action, reasons,
          heuristics_triggered, status, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_review', CURRENT_TIMESTAMP)
        RETURNING id
      `;

      await pool.query(query, [
        alertId,
        evaluationLogId,
        transactionInput.id,
        transactionInput.userId || null,
        result.score,
        result.riskLevel,
        result.recommendedAction,
        JSON.stringify(result.reasons),
        JSON.stringify(result.heuristicsTriggered),
      ]);

      logger.info({ alertId, transactionId: transactionInput.id, score: result.score }, 'Fraud alert created');
      return alertId;
    } catch (error) {
      logger.error({ err: error, transactionId: transactionInput.id }, 'Failed to create fraud alert');
      return null;
    }
  },

  /**
   * Retrieve fraud evaluation history for a user
   */
  getHistory: async (
    userId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<FraudEvaluationLog[]> => {
    try {
      const query = `
        SELECT
          id,
          transaction_id AS "transactionId",
          user_id AS "userId",
          amount,
          phone_number AS "phoneNumber",
          provider,
          type,
          status,
          ip_address AS "ipAddress",
          user_agent AS "userAgent",
          device_fingerprint AS "deviceFingerprint",
          is_fraud AS "isFraud",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          heuristic_details AS "heuristicDetails",
          duration_ms AS "durationMs",
          transaction_history_count AS "transactionHistoryCount",
          created_at AS "createdAt"
        FROM fraud_evaluation_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `;
      const result = await pool.query(query, [userId, limit, offset]);
      return result.rows.map((row) => ({
        ...row,
        reasons: typeof row.reasons === 'string' ? JSON.parse(row.reasons) : row.reasons,
        heuristicsTriggered: typeof row.heuristicsTriggered === 'string' ? JSON.parse(row.heuristicsTriggered) : row.heuristicsTriggered,
        heuristicDetails: typeof row.heuristicDetails === 'string' ? JSON.parse(row.heuristicDetails) : row.heuristicDetails,
      }));
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to fetch fraud evaluation history');
      return [];
    }
  },

  /**
   * Retrieve all alerts with optional filtering
   */
  getAlerts: async (filter: FraudEvaluationFilter = {}): Promise<any[]> => {
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (filter.userId) {
        conditions.push(`fa.user_id = $${paramIndex++}`);
        params.push(filter.userId);
      }
      if (filter.isFraud !== undefined) {
        conditions.push(`fa.score >= 50`);
      }
      if (filter.riskLevel) {
        conditions.push(`fa.risk_level = $${paramIndex++}`);
        params.push(filter.riskLevel);
      }
      if (filter.startDate) {
        conditions.push(`fa.created_at >= $${paramIndex++}`);
        params.push(filter.startDate);
      }
      if (filter.endDate) {
        conditions.push(`fa.created_at <= $${paramIndex++}`);
        params.push(filter.endDate);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = filter.limit ?? 50;
      const offset = filter.offset ?? 0;

      const query = `
        SELECT
          fa.id,
          fa.transaction_id AS "transactionId",
          fa.user_id AS "userId",
          fa.score,
          fa.risk_level AS "riskLevel",
          fa.recommended_action AS "recommendedAction",
          fa.reasons,
          fa.heuristics_triggered AS "heuristicsTriggered",
          fa.status,
          fa.feedback,
          fa.feedback_by AS "feedbackBy",
          fa.feedback_notes AS "feedbackNotes",
          fa.feedback_at AS "feedbackAt",
          fa.created_at AS "createdAt"
        FROM fraud_alerts fa
        ${whereClause}
        ORDER BY fa.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;
      const result = await pool.query(query, [...params, limit, offset]);
      return result.rows.map((row) => ({
        ...row,
        reasons: typeof row.reasons === 'string' ? JSON.parse(row.reasons) : row.reasons,
        heuristicsTriggered: typeof row.heuristicsTriggered === 'string' ? JSON.parse(row.heuristicsTriggered) : row.heuristicsTriggered,
      }));
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch fraud alerts');
      return [];
    }
  },

  /**
   * Update alert feedback (false positive / confirmed fraud)
   */
  updateAlertFeedback: async (
    alertId: string,
    feedback: 'false_positive' | 'confirmed_fraud',
    feedbackBy: string,
    notes?: string,
  ): Promise<boolean> => {
    try {
      const query = `
        UPDATE fraud_alerts
        SET
          status = CASE
            WHEN $1 = 'false_positive' THEN 'dismissed'
            WHEN $1 = 'confirmed_fraud' THEN 'confirmed'
            ELSE status
          END,
          feedback = $1,
          feedback_by = $2,
          feedback_notes = $3,
          feedback_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING id
      `;
      const result = await pool.query(query, [feedback, feedbackBy, notes || null, alertId]);

      if (result.rows.length === 0) {
        logger.warn({ alertId }, 'Fraud alert not found for feedback update');
        return false;
      }

      logger.info({ alertId, feedback, feedbackBy }, 'Fraud alert feedback recorded');
      return true;
    } catch (error) {
      logger.error({ err: error, alertId }, 'Failed to update fraud alert feedback');
      return false;
    }
  },
};
