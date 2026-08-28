/**
 * #403 – Transaction Metadata Field Indexing Routes
 *
 * GET /api/transactions/metadata/search   – field-equality or FTS search
 * GET /api/transactions/metadata/stats    – index usage stats (admin)
 * GET /api/transactions/metadata/benchmark – run benchmark (admin)
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateToken } from "../middleware/auth";
import {
  queryByMetadataField,
  searchMetadataFullText,
  getMetadataIndexStats,
  runMetadataBenchmark,
} from "../services/transactionMetadataService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

// ─── GET /search ──────────────────────────────────────────────────────────────

const SearchQuerySchema = z.object({
  mode: z.enum(["field", "fts"]).default("field"),
  field: z.string().regex(/^[a-z_]+$/, "field must be lowercase letters/underscores").optional(),
  value: z.string().optional(),
  q: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

router.get("/search", authenticateToken, async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) throw createError(ERROR_CODES.UNAUTHORIZED, "Not authenticated");

  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid query parameters", {
      errors: parsed.error.errors,
    });
  }

  const { mode, field, value, q, status, limit, offset } = parsed.data;

  if (mode === "field") {
    if (!field || !value) {
      throw createError(
        ERROR_CODES.INVALID_INPUT,
        "mode=field requires both 'field' and 'value' query parameters",
      );
    }

    const result = await queryByMetadataField({
      field,
      value,
      userId,
      status,
      limit,
      offset,
    });

    return res.json({
      data: result.data,
      meta: {
        total: result.total,
        limit,
        offset,
        queryTimeMs: result.queryTimeMs,
        cached: result.cached,
      },
    });
  }

  // FTS mode
  if (!q) {
    throw createError(
      ERROR_CODES.INVALID_INPUT,
      "mode=fts requires a 'q' query parameter",
    );
  }

  const result = await searchMetadataFullText({
    query: q,
    userId,
    status,
    limit,
    offset,
  });

  res.json({
    data: result.data,
    meta: {
      total: result.total,
      limit,
      offset,
      queryTimeMs: result.queryTimeMs,
      cached: result.cached,
    },
  });
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

router.get("/stats", authenticateToken, async (_req: Request, res: Response) => {
  const stats = await getMetadataIndexStats();
  res.json({ data: stats });
});

// ─── GET /benchmark ───────────────────────────────────────────────────────────

router.get("/benchmark", authenticateToken, async (req: Request, res: Response) => {
  const field = (req.query.field as string) || "provider";
  const value = (req.query.value as string) || "mtn";
  const query = (req.query.q as string) || "mobile deposit";

  const result = await runMetadataBenchmark(field, value, query);
  res.json({ data: result });
});

export default router;
