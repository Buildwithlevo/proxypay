import { pool } from "../config/database";

export type FraudAlertStatus = 'flagged' | 'reviewed' | 'false_positive' | 'confirmed';
export type FraudRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FraudRecommendedAction = 'allow' | 'review' | 'block';

export interface FraudAlert {
  id: string;
  transactionId: string;
  userId?: string;
  score: number;
  riskLevel: FraudRiskLevel;
  recommendedAction: FraudRecommendedAction;
  reasons: string[];
  heuristicsTriggered: string[];
  heuristicDetails: Record<string, unknown>;
  userContext: Record<string, unknown>;
  status: FraudAlertStatus;
  reviewedBy?: string;
  reviewNotes?: string;
  reviewedAt?: string;
  isFalsePositive: boolean;
  falsePositiveReason?: string;
  durationMs?: number;
  transactionAmount?: number;
  transactionType?: string;
  provider?: string;
  phoneNumber?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FraudAlertFilter {
  status?: FraudAlertStatus;
  userId?: string;
  riskLevel?: FraudRiskLevel;
  isFalsePositive?: boolean;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
  before?: string;
  after?: string;
}

export interface FraudAlertListResult {
  alerts: FraudAlert[];
  total: number;
  flaggedCount: number;
  hasMore?: boolean;
}

export interface FraudReviewInput {
  status: FraudAlertStatus;
  reviewNotes?: string;
  isFalsePositive?: boolean;
  falsePositiveReason?: string;
}

export interface FraudReviewHistoryEntry {
  id: string;
  alertId: string;
  previousStatus: string;
  newStatus: string;
  reviewedBy: string;
  reviewNotes?: string;
  createdAt: string;
}

export class FraudAlertModel {
  async create(alert: {
    transactionId: string;
    userId?: string;
    score: number;
    riskLevel: FraudRiskLevel;
    recommendedAction: FraudRecommendedAction;
    reasons: string[];
    heuristicsTriggered: string[];
    heuristicDetails: Record<string, unknown>;
    userContext: Record<string, unknown>;
    durationMs?: number;
    transactionAmount?: number;
    transactionType?: string;
    provider?: string;
    phoneNumber?: string;
  }): Promise<FraudAlert> {
    const query = `
      INSERT INTO fraud_alerts (
        transaction_id, user_id, score, risk_level, recommended_action,
        reasons, heuristics_triggered, heuristic_details, user_context,
        duration_ms, transaction_amount, transaction_type, provider, phone_number
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        score,
        risk_level AS "riskLevel",
        recommended_action AS "recommendedAction",
        reasons,
        heuristics_triggered AS "heuristicsTriggered",
        heuristic_details AS "heuristicDetails",
        user_context AS "userContext",
        status,
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        reviewed_at AS "reviewedAt",
        is_false_positive AS "isFalsePositive",
        false_positive_reason AS "falsePositiveReason",
        duration_ms AS "durationMs",
        transaction_amount AS "transactionAmount",
        transaction_type AS "transactionType",
        provider,
        phone_number AS "phoneNumber",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await pool.query(query, [
      alert.transactionId,
      alert.userId || null,
      alert.score,
      alert.riskLevel,
      alert.recommendedAction,
      alert.reasons,
      alert.heuristicsTriggered,
      JSON.stringify(alert.heuristicDetails),
      JSON.stringify(alert.userContext),
      alert.durationMs || null,
      alert.transactionAmount || null,
      alert.transactionType || null,
      alert.provider || null,
      alert.phoneNumber || null,
    ]);

    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<FraudAlert | null> {
    const query = `
      SELECT
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        score,
        risk_level AS "riskLevel",
        recommended_action AS "recommendedAction",
        reasons,
        heuristics_triggered AS "heuristicsTriggered",
        heuristic_details AS "heuristicDetails",
        user_context AS "userContext",
        status,
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        reviewed_at AS "reviewedAt",
        is_false_positive AS "isFalsePositive",
        false_positive_reason AS "falsePositiveReason",
        duration_ms AS "durationMs",
        transaction_amount AS "transactionAmount",
        transaction_type AS "transactionType",
        provider,
        phone_number AS "phoneNumber",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fraud_alerts
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async findByTransactionId(transactionId: string): Promise<FraudAlert[]> {
    const query = `
      SELECT
        id,
        transaction_id AS "transactionId",
        user_id AS "userId",
        score,
        risk_level AS "riskLevel",
        recommended_action AS "recommendedAction",
        reasons,
        heuristics_triggered AS "heuristicsTriggered",
        heuristic_details AS "heuristicDetails",
        user_context AS "userContext",
        status,
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        reviewed_at AS "reviewedAt",
        is_false_positive AS "isFalsePositive",
        false_positive_reason AS "falsePositiveReason",
        duration_ms AS "durationMs",
        transaction_amount AS "transactionAmount",
        transaction_type AS "transactionType",
        provider,
        phone_number AS "phoneNumber",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fraud_alerts
      WHERE transaction_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [transactionId]);
    return result.rows.map((row) => this.mapRow(row));
  }

  async list(filter: FraudAlertFilter = {}): Promise<FraudAlertListResult> {
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

    if (filter.isFalsePositive !== undefined) {
      conditions.push(`is_false_positive = $${paramIndex++}`);
      params.push(filter.isFalsePositive);
    }

    if (filter.startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filter.startDate);
    }

    if (filter.endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filter.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as count FROM fraud_alerts ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const flaggedQuery = `
      SELECT COUNT(*) as count
      FROM fraud_alerts
      ${whereClause ? whereClause + " AND" : "WHERE"} status = 'flagged'
    `;
    const flaggedResult = await pool.query(flaggedQuery, params);
    const flaggedCount = parseInt(flaggedResult.rows[0].count, 10);

    let cursorTime: Date | null = null;
    let cursorId: string | null = null;
    let isReversed = false;

    if (filter.after) {
      const decoded = Buffer.from(filter.after, "base64").toString("utf8");
      const [timeStr, idStr] = decoded.split("|");
      if (timeStr && idStr) {
        const parsedTime = new Date(timeStr);
        if (!isNaN(parsedTime.getTime())) {
          cursorTime = parsedTime;
          cursorId = idStr;
        }
      }
    } else if (filter.before) {
      const decoded = Buffer.from(filter.before, "base64").toString("utf8");
      const [timeStr, idStr] = decoded.split("|");
      if (timeStr && idStr) {
        const parsedTime = new Date(timeStr);
        if (!isNaN(parsedTime.getTime())) {
          cursorTime = parsedTime;
          cursorId = idStr;
          isReversed = true;
        }
      }
    }

    const alertsConditions = [...conditions];
    const alertsParams = [...params];
    let alertsParamIndex = paramIndex;

    if (cursorTime && cursorId) {
      if (isReversed) {
        alertsConditions.push(
          `(created_at > $${alertsParamIndex} OR (created_at = $${alertsParamIndex} AND id > $${alertsParamIndex + 1}))`
        );
      } else {
        alertsConditions.push(
          `(created_at < $${alertsParamIndex} OR (created_at = $${alertsParamIndex} AND id < $${alertsParamIndex + 1}))`
        );
      }
      alertsParams.push(cursorTime);
      alertsParams.push(cursorId);
      alertsParamIndex += 2;
    }

    const alertsWhereClause =
      alertsConditions.length > 0 ? `WHERE ${alertsConditions.join(" AND ")}` : "";

    const limit = filter.limit ?? 50;
    const isCursorPagination = !!(filter.before || filter.after);
    const sortOrder = isReversed ? "ASC" : "DESC";

    const selectColumns = `
      id,
      transaction_id AS "transactionId",
      user_id AS "userId",
      score,
      risk_level AS "riskLevel",
      recommended_action AS "recommendedAction",
      reasons,
      heuristics_triggered AS "heuristicsTriggered",
      heuristic_details AS "heuristicDetails",
      user_context AS "userContext",
      status,
      reviewed_by AS "reviewedBy",
      review_notes AS "reviewNotes",
      reviewed_at AS "reviewedAt",
      is_false_positive AS "isFalsePositive",
      false_positive_reason AS "falsePositiveReason",
      duration_ms AS "durationMs",
      transaction_amount AS "transactionAmount",
      transaction_type AS "transactionType",
      provider,
      phone_number AS "phoneNumber",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `;

    let alertsQuery = "";
    let alertsResult;

    if (isCursorPagination) {
      alertsQuery = `
        SELECT ${selectColumns}
        FROM fraud_alerts
        ${alertsWhereClause}
        ORDER BY created_at ${sortOrder}, id ${sortOrder}
        LIMIT $${alertsParamIndex++}
      `;
      alertsResult = await pool.query(alertsQuery, [...alertsParams, limit + 1]);
    } else {
      const offset = filter.offset ?? 0;
      alertsQuery = `
        SELECT ${selectColumns}
        FROM fraud_alerts
        ${alertsWhereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${alertsParamIndex++} OFFSET $${alertsParamIndex++}
      `;
      alertsResult = await pool.query(alertsQuery, [...alertsParams, limit, offset]);
    }

    let alerts = alertsResult.rows.map((row) => this.mapRow(row));
    let hasMore = false;

    if (isCursorPagination) {
      if (alerts.length > limit) {
        hasMore = true;
        alerts = alerts.slice(0, limit);
      }
      if (isReversed) {
        alerts.reverse();
      }
    } else {
      const offset = filter.offset ?? 0;
      hasMore = offset + limit < total;
    }

    return { alerts, total, flaggedCount, hasMore };
  }

  async findByUserId(userId: string, limit = 50, offset = 0): Promise<FraudAlertListResult> {
    return this.list({ userId, limit, offset });
  }

  async review(
    alertId: string,
    input: FraudReviewInput,
    reviewerId: string,
  ): Promise<FraudAlert | null> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const currentQuery = `
        SELECT status FROM fraud_alerts WHERE id = $1 FOR UPDATE
      `;
      const currentResult = await client.query(currentQuery, [alertId]);

      if (currentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      const previousStatus = currentResult.rows[0].status;

      const updateQuery = `
        UPDATE fraud_alerts
        SET
          status = $1,
          reviewed_by = $2,
          review_notes = $3,
          reviewed_at = CURRENT_TIMESTAMP,
          is_false_positive = $4,
          false_positive_reason = $5,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
        RETURNING
          id,
          transaction_id AS "transactionId",
          user_id AS "userId",
          score,
          risk_level AS "riskLevel",
          recommended_action AS "recommendedAction",
          reasons,
          heuristics_triggered AS "heuristicsTriggered",
          heuristic_details AS "heuristicDetails",
          user_context AS "userContext",
          status,
          reviewed_by AS "reviewedBy",
          review_notes AS "reviewNotes",
          reviewed_at AS "reviewedAt",
          is_false_positive AS "isFalsePositive",
          false_positive_reason AS "falsePositiveReason",
          duration_ms AS "durationMs",
          transaction_amount AS "transactionAmount",
          transaction_type AS "transactionType",
          provider,
          phone_number AS "phoneNumber",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;

      const updateResult = await client.query(updateQuery, [
        input.status,
        reviewerId,
        input.reviewNotes || null,
        input.isFalsePositive || false,
        input.falsePositiveReason || null,
        alertId,
      ]);

      const historyQuery = `
        INSERT INTO fraud_alert_review_history (
          alert_id, previous_status, new_status, reviewed_by, review_notes
        )
        VALUES ($1, $2, $3, $4, $5)
      `;

      await client.query(historyQuery, [
        alertId,
        previousStatus,
        input.status,
        reviewerId,
        input.reviewNotes || null,
      ]);

      await client.query("COMMIT");

      return this.mapRow(updateResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markFalsePositive(
    alertId: string,
    reason: string,
    reviewerId: string,
  ): Promise<FraudAlert | null> {
    return this.review(alertId, {
      status: 'false_positive',
      isFalsePositive: true,
      falsePositiveReason: reason,
      reviewNotes: `Marked as false positive: ${reason}`,
    }, reviewerId);
  }

  async getReviewHistory(alertId: string): Promise<FraudReviewHistoryEntry[]> {
    const query = `
      SELECT
        id,
        alert_id AS "alertId",
        previous_status AS "previousStatus",
        new_status AS "newStatus",
        reviewed_by AS "reviewedBy",
        review_notes AS "reviewNotes",
        created_at AS "createdAt"
      FROM fraud_alert_review_history
      WHERE alert_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [alertId]);
    return result.rows.map((row) => ({
      id: row.id,
      alertId: row.alertId,
      previousStatus: row.previousStatus,
      newStatus: row.newStatus,
      reviewedBy: row.reviewedBy,
      reviewNotes: row.reviewNotes,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getStatistics(): Promise<{
    totalAlerts: number;
    flaggedAlerts: number;
    falsePositives: number;
    confirmedFraud: number;
    averageScore: number;
    riskLevelBreakdown: Record<FraudRiskLevel, number>;
  }> {
    const query = `
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'flagged') as flagged,
        COUNT(*) FILTER (WHERE is_false_positive = TRUE) as false_positives,
        COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
        COALESCE(AVG(score), 0) as avg_score,
        COUNT(*) FILTER (WHERE risk_level = 'low') as low,
        COUNT(*) FILTER (WHERE risk_level = 'medium') as medium,
        COUNT(*) FILTER (WHERE risk_level = 'high') as high_risk,
        COUNT(*) FILTER (WHERE risk_level = 'critical') as critical
      FROM fraud_alerts
    `;

    const result = await pool.query(query);
    const row = result.rows[0];

    return {
      totalAlerts: parseInt(row.total, 10),
      flaggedAlerts: parseInt(row.flagged, 10),
      falsePositives: parseInt(row.false_positives, 10),
      confirmedFraud: parseInt(row.confirmed, 10),
      averageScore: parseFloat(row.avg_score),
      riskLevelBreakdown: {
        low: parseInt(row.low, 10),
        medium: parseInt(row.medium, 10),
        high: parseInt(row.high_risk, 10),
        critical: parseInt(row.critical, 10),
      },
    };
  }

  private mapRow(row: any): FraudAlert {
    return {
      id: row.id,
      transactionId: row.transactionId,
      userId: row.userId || undefined,
      score: row.score,
      riskLevel: row.riskLevel,
      recommendedAction: row.recommendedAction,
      reasons: row.reasons || [],
      heuristicsTriggered: row.heuristicsTriggered || [],
      heuristicDetails: typeof row.heuristicDetails === 'string'
        ? JSON.parse(row.heuristicDetails)
        : row.heuristicDetails || {},
      userContext: typeof row.userContext === 'string'
        ? JSON.parse(row.userContext)
        : row.userContext || {},
      status: row.status,
      reviewedBy: row.reviewedBy || undefined,
      reviewNotes: row.reviewNotes || undefined,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : undefined,
      isFalsePositive: row.isFalsePositive,
      falsePositiveReason: row.falsePositiveReason || undefined,
      durationMs: row.durationMs || undefined,
      transactionAmount: row.transactionAmount ? parseFloat(row.transactionAmount) : undefined,
      transactionType: row.transactionType || undefined,
      provider: row.provider || undefined,
      phoneNumber: row.phoneNumber || undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
