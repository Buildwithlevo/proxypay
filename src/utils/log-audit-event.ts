import { pool } from "../config/database";

/**
 * Audit event metadata passed alongside the required userId and reason.
 */
export interface AuditEventMetadata {
  /** HTTP request method (GET, POST, etc.) */
  method?: string;
  /** Full request path */
  path?: string;
  /** Client IP address */
  ipAddress?: string;
  /** Client User-Agent header */
  userAgent?: string;
  /** Arbitrary structured data attached to the event */
  extra?: Record<string, unknown>;
}

/**
 * Persist an audit event to the `audit_logs` table.
 *
 * @param userId  – ID of the user performing the action
 * @param reason  – Short identifier for the event (e.g. "RIGHT_TO_BE_FORGOTTEN_EXECUTED")
 * @param meta    – Optional request context and extra metadata
 */
export const logAuditEvent = async (
  userId: string,
  reason: string,
  meta?: AuditEventMetadata,
): Promise<void> => {
  try {
    const query = `
      INSERT INTO audit_logs (admin_id, action, resource, resource_id, diff, ip_address, user_agent, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `;

    const diff = meta?.extra ? JSON.stringify(meta.extra) : null;

    await pool.query(query, [
      userId,
      reason,
      "user",
      userId,
      diff,
      meta?.ipAddress ?? null,
      meta?.userAgent ?? null,
    ]);
  } catch (error) {
    console.error("[AuditLog] Failed to write audit event:", {
      userId,
      reason,
      error,
    });
  }
};

/**
 * Query audit log entries for a given user, ordered by most recent first.
 *
 * @param userId – user to fetch events for
 * @param limit  – max rows to return (default 100)
 * @param offset – row offset for pagination (default 0)
 * @returns Array of audit log rows
 */
export const queryAuditEvents = async (
  userId: string,
  limit: number = 100,
  offset: number = 0,
): Promise<Record<string, unknown>[]> => {
  try {
    const query = `
      SELECT id, admin_id AS "userId", action, resource, diff, ip_address AS "ipAddress",
             user_agent AS "userAgent", created_at AS "timestamp"
      FROM audit_logs
      WHERE admin_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [userId, limit, offset]);
    return result.rows;
  } catch (error) {
    console.error("[AuditLog] Failed to query audit events:", { userId, error });
    return [];
  }
};
