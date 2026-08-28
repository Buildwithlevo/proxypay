import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  listRetryPolicies,
  getRetryPolicy,
  createRetryPolicy,
  updateRetryPolicy,
  deleteRetryPolicy,
  getMerchantRetryMetrics,
  getOrCreateDefaultsForMerchant,
} from "../controllers/webhookAdminController";

const router = Router();

router.use(requireAuth);

// GET /api/admin/webhooks/retry-policies
router.get("/retry-policies", listRetryPolicies);

// GET /api/admin/webhooks/retry-policies/:id
router.get("/retry-policies/:id", getRetryPolicy);

// POST /api/admin/webhooks/retry-policies
router.post("/retry-policies", createRetryPolicy);

// PATCH /api/admin/webhooks/retry-policies/:id
router.patch("/retry-policies/:id", updateRetryPolicy);

// DELETE /api/admin/webhooks/retry-policies/:id
router.delete("/retry-policies/:id", deleteRetryPolicy);

// GET /api/admin/webhooks/merchants/:merchantId/metrics
router.get("/merchants/:merchantId/metrics", getMerchantRetryMetrics);

// POST /api/admin/webhooks/merchants/:merchantId/defaults
router.post("/merchants/:merchantId/defaults", getOrCreateDefaultsForMerchant);

export default router;
