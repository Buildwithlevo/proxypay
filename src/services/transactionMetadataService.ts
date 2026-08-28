/**
 * #403 – Transaction Metadata Field Indexing
 *
 * Service for:
 *  - Querying transactions by metadata fields (uses expression indexes)
 *  - Full-text search across metadata values
 *  - Query result caching (Redis-backed with TTL)
 *  - Performance benchmarks / analysis helper
 */

import { pool } from "../config/database";
import { redisClient } from "../config/redis";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MetadataFieldQuery {
  field: string;
  value: string;
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface MetadataFTSQuery {
  query: string;
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface TransactionMetadataRow {
  id: string;
  user_id: string;
  status: string;
  amount: string;
  currency: string;
  provider: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface MetadataQueryResult {
  data: TransactionMetadataRow[];
  total: number;
  cached: boolean;
  queryTimeMs: number;
}

export interface MetadataIndexStats {
  indexName: string;
  scans: number;
  tuplesRead: number;
  indexSize: string;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 60; // 1 minute

function fieldQueryCacheKey(params: MetadataFieldQuery): string {
  const p = JSON.stringify({ ...params, limit: params.limit ?? 20, offset: params.offset ?? 0 });
  return `txn:meta:field:${Buffer.from(p).toString("base64url")}`;
}

function ftsQueryCacheKey(params: MetadataFTSQuery): string {
  const p = JSON.stringify({ ...params, limit: params.limit ?? 20, offset: params.offset ?? 0 });
  return `txn:meta:fts:${Buffer.from(p).toString("base64url")}`;
}

async function cacheGet(key: string): Promise<string | null> {
  try {
    return await redisClient.get(key);
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: string): Promise<void> {
  try {
    await redisClient.setEx(key, CACHE_TTL_SECONDS, value);
  } catch {
    // swallow – cache is best-effort
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function buildWhere(
  params: { userId?: string; status?: string },
  startIndex: number,
): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let idx = startIndex;

  if (params.userId) {
    clauses.push(`user_id = $${idx++}`);
    values.push(params.userId);
  }
  if (params.status) {
    clauses.push(`status = $${idx++}`);
    values.push(params.status);
  }

  return { clauses, values };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Query transactions by a specific metadata field value.
 * Uses the expression indexes created by migration #403.
 */
export async function queryByMetadataField(
  params: MetadataFieldQuery,
): Promise<MetadataQueryResult> {
  const cacheKey = fieldQueryCacheKey(params);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return { ...JSON.parse(cached), cached: true };
  }

  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const t0 = Date.now();

  // Sanitise field name – allow only [a-z_] to prevent SQL injection
  if (!/^[a-z_]+$/.test(params.field)) {
    throw new Error(`Invalid metadata field name: ${params.field}`);
  }

  const { clauses, values } = buildWhere(params, 3);
  const whereExtra = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";

  const countValues = [params.field, params.value, ...values];
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM transactions
     WHERE metadata->>$1 = $2${whereExtra}`,
    countValues,
  );
  const total = parseInt(countRows[0].count, 10);

  const dataValues = [...countValues, limit, offset];
  const lastParam = countValues.length + 1;
  const { rows } = await pool.query<TransactionMetadataRow>(
    `SELECT id, user_id, status, amount, currency, provider, metadata, created_at
     FROM transactions
     WHERE metadata->>$1 = $2${whereExtra}
     ORDER BY created_at DESC
     LIMIT $${lastParam} OFFSET $${lastParam + 1}`,
    dataValues,
  );

  const queryTimeMs = Date.now() - t0;
  const result: MetadataQueryResult = { data: rows, total, cached: false, queryTimeMs };
  await cacheSet(cacheKey, JSON.stringify(result));
  return result;
}

/**
 * Full-text search across all metadata string values.
 * Uses the metadata_tsv generated column + GIN index.
 */
export async function searchMetadataFullText(
  params: MetadataFTSQuery,
): Promise<MetadataQueryResult> {
  const cacheKey = ftsQueryCacheKey(params);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return { ...JSON.parse(cached), cached: true };
  }

  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const t0 = Date.now();

  const { clauses, values } = buildWhere(params, 2);
  const whereExtra = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";

  const countValues = [params.query, ...values];
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM transactions
     WHERE metadata_tsv @@ plainto_tsquery('english', $1)${whereExtra}`,
    countValues,
  );
  const total = parseInt(countRows[0].count, 10);

  const dataValues = [...countValues, limit, offset];
  const lastParam = countValues.length + 1;
  const { rows } = await pool.query<TransactionMetadataRow>(
    `SELECT id, user_id, status, amount, currency, provider, metadata, created_at,
            ts_rank(metadata_tsv, plainto_tsquery('english', $1)) AS rank
     FROM transactions
     WHERE metadata_tsv @@ plainto_tsquery('english', $1)${whereExtra}
     ORDER BY rank DESC, created_at DESC
     LIMIT $${lastParam} OFFSET $${lastParam + 1}`,
    dataValues,
  );

  const queryTimeMs = Date.now() - t0;
  const result: MetadataQueryResult = { data: rows, total, cached: false, queryTimeMs };
  await cacheSet(cacheKey, JSON.stringify(result));
  return result;
}

/**
 * Invalidate metadata query cache for a specific user (after write operations).
 */
export async function invalidateMetadataCache(userId?: string): Promise<void> {
  try {
    const pattern = userId
      ? `txn:meta:*:*${Buffer.from(userId).toString("base64url").slice(0, 10)}*`
      : "txn:meta:*";
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch {
    // swallow
  }
}

/**
 * Return index usage statistics for metadata indexes.
 * Used for benchmarking and monitoring.
 */
export async function getMetadataIndexStats(): Promise<MetadataIndexStats[]> {
  const { rows } = await pool.query<{
    index_name: string;
    scans: string;
    tuples_read: string;
    index_size: string;
  }>(`
    SELECT
      indexrelname  AS index_name,
      idx_scan      AS scans,
      idx_tup_read  AS tuples_read,
      pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
    FROM pg_stat_user_indexes
    WHERE relname = 'transactions'
      AND indexrelname LIKE '%meta%'
    ORDER BY idx_scan DESC
  `);

  return rows.map((r) => ({
    indexName: r.index_name,
    scans: parseInt(r.scans, 10),
    tuplesRead: parseInt(r.tuples_read, 10),
    indexSize: r.index_size,
  }));
}

/**
 * Run a quick benchmark: execute a metadata field query and a FTS query,
 * return timing info.  Intended for admin/monitoring use only.
 */
export async function runMetadataBenchmark(
  sampleField = "provider",
  sampleValue = "mtn",
  sampleFtsQuery = "mobile deposit",
): Promise<{
  fieldQueryMs: number;
  ftsQueryMs: number;
  indexStats: MetadataIndexStats[];
}> {
  const t1 = Date.now();
  await pool.query(
    `SELECT id FROM transactions WHERE metadata->>$1 = $2 LIMIT 1`,
    [sampleField, sampleValue],
  );
  const fieldQueryMs = Date.now() - t1;

  const t2 = Date.now();
  await pool.query(
    `SELECT id FROM transactions
     WHERE metadata_tsv @@ plainto_tsquery('english', $1) LIMIT 1`,
    [sampleFtsQuery],
  );
  const ftsQueryMs = Date.now() - t2;

  const indexStats = await getMetadataIndexStats();

  return { fieldQueryMs, ftsQueryMs, indexStats };
}
