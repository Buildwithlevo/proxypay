import { pool } from '../config/database';
import logger from '../utils/logger';

export type FraudAlertStatus = 'pending_review' | 'reviewed' | 'dismissed' | 'confirmed';
export type FraudAlertFeedback = 'false_positive' | 'confirmed_fraud';

export interface FraudAlert {
  id: string;
  evaluationLogId: string;
  transactionId: string;
  userId: string | null;
  score: number;
  riskLevel: string;
  recommendedAction: string;
  reasons: string[];
  heuristicsTriggered: string[];
  status: FraudAlertStatus;
  feedback?: FraudAlertFeedback;
  feedbackBy?: string;
  feedbackNotes?: string;
  feedbackAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export interface FraudAlertFilter {
  status?: FraudAlertStatus;
  userId?: string;
  riskLevel?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export class FraudAlertModel {
  async findById(id: string): Promise<FraudAlert | null> {
    try {
      const query = `
        SELECT
          id,
          evaluation_log_id AS "evaluationLogId",
          transaction_id AS "transactionId",
          user_id AS "userId",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          status,
          feedback,
          feedback_by AS "feedbackBy",
          feedback_notes AS "feedbackNotes",
          feedback_at AS "feedbackAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM fraud_alerts
        WHERE id = $1
      `;
      const result = await pool.query(query, [id]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      logger.error({ err: error, alertId: id }, 'Failed to find fraud alert');
      return null;
    }
  }

  async findByTransactionId(transactionId: string): Promise<FraudAlert[]> {
    try {
      const query = `
        SELECT
          id,
          evaluation_log_id AS "evaluationLogId",
          transaction_id AS "transactionId",
          user_id AS "userId",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          status,
          feedback,
          feedback_by AS "feedbackBy",
          feedback_notes AS "feedbackNotes",
          feedback_at AS "feedbackAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM fraud_alerts
        WHERE transaction_id = $1
        ORDER BY created_at DESC
      `;
      const result = await pool.query(query, [transactionId]);
      return result.rows.map((row) => this.mapRow(row));
    } catch (error) {
      logger.error({ err: error, transactionId }, 'Failed to find fraud alerts by transaction');
      return [];
    }
  }

  async list(filter: FraudAlertFilter = {}): Promise<{ alerts: FraudAlert[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filter.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    }
    if (filter.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(filter.userId);
    }
    if (filter.riskLevel) {
      conditions.push(`risk_level = $${paramIndex++}`);
      params.push(filter.riskLevel);
    }
    if (filter.startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filter.startDate);
    }
    if (filter.endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filter.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    try {
      const countQuery = `SELECT COUNT(*) as count FROM fraud_alerts ${whereClause}`;
      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].count, 10);

      const query = `
        SELECT
          id,
          evaluation_log_id AS "evaluationLogId",
          transaction_id AS "transactionId",
          user_id AS "userId",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          status,
          feedback,
          feedback_by AS "feedbackBy",
          feedback_notes AS "feedbackNotes",
          feedback_at AS "feedbackAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM fraud_alerts
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;
      const result = await pool.query(query, [...params, limit, offset]);
      const alerts = result.rows.map((row) => this.mapRow(row));
      return { alerts, total };
    } catch (error) {
      logger.error({ err: error }, 'Failed to list fraud alerts');
      return { alerts: [], total: 0 };
    }
  }

  async updateStatus(
    id: string,
    status: FraudAlertStatus,
  ): Promise<FraudAlert | null> {
    try {
      const query = `
        UPDATE fraud_alerts
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING
          id,
          evaluation_log_id AS "evaluationLogId",
          transaction_id AS "transactionId",
          user_id AS "userId",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          status,
          feedback,
          feedback_by AS "feedbackBy",
          feedback_notes AS "feedbackNotes",
          feedback_at AS "feedbackAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      const result = await pool.query(query, [status, id]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      logger.error({ err: error, alertId: id }, 'Failed to update fraud alert status');
      return null;
    }
  }

  async recordFeedback(
    id: string,
    feedback: FraudAlertFeedback,
    feedbackBy: string,
    notes?: string,
  ): Promise<FraudAlert | null> {
    try {
      const newStatus: FraudAlertStatus =
        feedback === 'false_positive' ? 'dismissed' : 'confirmed';
      const query = `
        UPDATE fraud_alerts
        SET
          status = $1,
          feedback = $2,
          feedback_by = $3,
          feedback_notes = $4,
          feedback_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
        RETURNING
          id,
          evaluation_log_id AS "evaluationLogId",
          transaction_id AS "transactionId",
          user_id AS "userId",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          status,
          feedback,
          feedback_by AS "feedbackBy",
          feedback_notes AS "feedbackNotes",
          feedback_at AS "feedbackAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      const result = await pool.query(query, [
        newStatus, feedback, feedbackBy, notes || null, id,
      ]);
      if (result.rows.length === 0) return null;
      return this.mapRow(result.rows[0]);
    } catch (error) {
      logger.error({ err: error, alertId: id }, 'Failed to record fraud alert feedback');
      return null;
    }
  }

  private mapRow(row: any): FraudAlert {
    return {
      id: row.id,
      evaluationLogId: row.evaluationLogId,
      transactionId: row.transactionId,
      userId: row.userId,
      score: row.score,
      riskLevel: row.riskLevel,
      recommendedAction: row.recommendedAction,
      reasons: typeof row.reasons === 'string' ? JSON.parse(row.reasons) : row.reasons,
      heuristicsTriggered: typeof row.heuristicsTriggered === 'string'
        ? JSON.parse(row.heuristicsTriggered)
        : row.heuristicsTriggered,
      status: row.status,
      feedback: row.feedback,
      feedbackBy: row.feedbackBy,
      feedbackNotes: row.feedbackNotes,
      feedbackAt: row.feedbackAt ? new Date(row.feedbackAt) : undefined,
      createdAt: new Date(row.createdAt),
      updatedAt: row.updatedAt ? new Date(row.updatedAt) : undefined,
    };
  }
}
