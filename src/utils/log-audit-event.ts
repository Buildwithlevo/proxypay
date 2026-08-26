import { pool } from "../config/database";
import logger from "./logger";

export type AuditEventCategory =
  | "authentication"
  | "authorization"
  | "data_access"
  | "data_modification"
  | "pii_access"
  | "account_lifecycle"
  | "transaction"
  | "compliance"
  | "system"
  | "admin_action";

export type AuditEventSeverity = "low" | "medium" | "high" | "critical";

export interface AuditEventOptions {
  /** Category of the audit event for filtering and reporting. */
  category?: AuditEventCategory;
  /** Free-text description of what happened. Overrides `reason` if both set. */
  action?: string;
  /** Severity rating for alerting thresholds. */
  severity?: AuditEventSeverity;
  /** Structured key-value metadata attached to the event. */
  metadata?: Record<string, unknown>;
  /** IP address of the originating request. */
  ipAddress?: string;
  /** User-Agent string of the originating request. */
  userAgent?: string;
  /** Specific resource type affected (e.g. "user", "transaction", "fee_strategy"). */
  resourceType?: string;
  /** ID of the specific resource affected. */
  resourceId?: string;
  /** ID of the admin/operator performing the action (when different from userId). */
  performedBy?: string;
  /** Success or failure of the operation. Defaults to true. */
  success?: boolean;
  /** Error message when success is false. */
  errorMessage?: string;
}

/**
 * Persist a structured audit event to the `audit_events` table and emit a
 * structured log line via the centralized Pino logger.
 *
 * The function is fire-and-forget safe: DB or logging failures are caught and
 * logged but never propagate to the caller so that business logic is never
 * interrupted by audit plumbing.
 */
export async function logAuditEvent(
  userId: string,
  reason: string,
  options?: AuditEventOptions,
): Promise<void> {
  const category: AuditEventCategory = options?.category ?? "system";
  const severity: AuditEventSeverity = options?.severity ?? "medium";
  const action = options?.action ?? reason;
  const success = options?.success ?? true;

  // 1. Persist to database
  try {
    await pool.query(
      `INSERT INTO audit_events
         (user_id, action, reason, category, severity, metadata,
          ip_address, user_agent, resource_type, resource_id,
          performed_by, success, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        userId,
        action,
        reason,
        category,
        severity,
        options?.metadata ? JSON.stringify(options.metadata) : null,
        options?.ipAddress ?? null,
        options?.userAgent ?? null,
        options?.resourceType ?? null,
        options?.resourceId ?? null,
        options?.performedBy ?? userId,
        success,
        options?.errorMessage ?? null,
      ],
    );
  } catch (error) {
    // Audit table may not exist yet during migrations — degrade gracefully
    logger.error({ error, userId, action }, "Failed to persist audit event to database");
  }

  // 2. Structured log line (always emitted regardless of DB availability)
  logger.info(
    {
      audit: true,
      userId,
      action,
      reason,
      category,
      severity,
      resourceType: options?.resourceType,
      resourceId: options?.resourceId,
      performedBy: options?.performedBy,
      success,
      metadata: options?.metadata,
    },
    `AUDIT: ${action}`,
  );
}

/**
 * Query audit events with filtering, pagination, and ordering.
 *
 * Returns both the rows and the total count (for pagination) so callers can
 * build offset/limit UIs without a second COUNT query when filters change.
 */
export async function queryAuditEvents(filters: {
  userId?: string;
  category?: AuditEventCategory;
  severity?: AuditEventSeverity;
  resourceType?: string;
  resourceId?: string;
  performedBy?: string;
  success?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
} = {}): Promise<{ events: Record<string, unknown>[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${idx++}`);
    values.push(filters.userId);
  }
  if (filters.category) {
    conditions.push(`category = $${idx++}`);
    values.push(filters.category);
  }
  if (filters.severity) {
    conditions.push(`severity = $${idx++}`);
    values.push(filters.severity);
  }
  if (filters.resourceType) {
    conditions.push(`resource_type = $${idx++}`);
    values.push(filters.resourceType);
  }
  if (filters.resourceId) {
    conditions.push(`resource_id = $${idx++}`);
    values.push(filters.resourceId);
  }
  if (filters.performedBy) {
    conditions.push(`performed_by = $${idx++}`);
    values.push(filters.performedBy);
  }
  if (filters.success !== undefined) {
    conditions.push(`success = $${idx++}`);
    values.push(filters.success);
  }
  if (filters.since) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(filters.since);
  }
  if (filters.until) {
    conditions.push(`created_at <= $${idx++}`);
    values.push(filters.until);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 100, 1000);
  const offset = filters.offset ?? 0;

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT id, user_id AS "userId", action, reason, category, severity,
              metadata, ip_address AS "ipAddress", user_agent AS "userAgent",
              resource_type AS "resourceType", resource_id AS "resourceId",
              performed_by AS "performedBy", success, error_message AS "errorMessage",
              created_at AS "createdAt"
       FROM audit_events
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM audit_events ${whereClause}`,
      values,
    ),
  ]);

  return {
    events: dataResult.rows,
    total: countResult.rows[0]?.total ?? 0,
  };
}
