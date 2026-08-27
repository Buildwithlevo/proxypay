import {
  evaluateDispute,
  type DisputeContext,
} from "../../../src/services/disputeResolutionEngine";

// Mock the database pool
jest.mock("../../../src/config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../../src/utils/logger", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { pool } from "../../../src/config/database";

const mockQuery = pool.query as jest.MockedFunction<typeof pool.query>;

function makeContext(overrides: Partial<DisputeContext> = {}): DisputeContext {
  return {
    disputeId: "disp-1",
    transactionId: "txn-1",
    reason: "Transaction not received",
    category: null,
    transactionStatus: "completed",
    transactionAmount: 500,
    transactionCurrency: "NGN",
    transactionCreatedAt: new Date(Date.now() - 3600_000),
    providerReference: "prov-ref-1",
    merchantId: "merch-1",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Dispute Resolution Engine", () => {
  describe("ruleDuplicateTransaction", () => {
    it("matches when duplicates exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "2" }], rowCount: 1, command: "", oid: 0, fields: [] });
      // Config query
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });

      const ctx = makeContext();
      const result = await evaluateDispute(ctx);
      expect(result).not.toBeNull();
      expect(result!.ruleName).toBe("duplicate_transaction");
      expect(result!.confidence).toBe(0.95);
      expect(result!.resolution).toBe("resolved");
    });

    it("does not match when no duplicates", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1, command: "", oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });

      const ctx = makeContext();
      const result = await evaluateDispute(ctx);
      expect(result).toBeNull();
    });
  });

  describe("ruleAlreadyRefunded", () => {
    it("matches when refund exists", async () => {
      // duplicate_transaction rule query
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1, command: "", oid: 0, fields: [] });
      // Config query
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
      // already_refunded rule query
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1, command: "", oid: 0, fields: [] });

      const ctx = makeContext({ reason: "Wrong amount charged" });
      const result = await evaluateDispute(ctx);
      expect(result).not.toBeNull();
      expect(result!.ruleName).toBe("already_refunded");
      expect(result!.resolution).toBe("resolved");
    });
  });

  describe("ruleProviderTimeout", () => {
    it("matches when transaction is old and pending", async () => {
      // duplicate query
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1, command: "", oid: 0, fields: [] });
      // config query
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
      // already_refunded query
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1, command: "", oid: 0, fields: [] });

      const ctx = makeContext({
        transactionStatus: "pending",
        transactionCreatedAt: new Date(Date.now() - 600_000), // 10 minutes ago
      });
      const result = await evaluateDispute(ctx);
      expect(result).not.toBeNull();
      expect(result!.ruleName).toBe("provider_timeout");
      expect(result!.resolution).toBe("rejected");
    });

    it("does not match when transaction is recent", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1, command: "", oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1, command: "", oid: 0, fields: [] });

      const ctx = makeContext({
        transactionStatus: "pending",
        transactionCreatedAt: new Date(Date.now() - 30_000), // 30 seconds ago
      });
      const result = await evaluateDispute(ctx);
      expect(result).toBeNull();
    });
  });

  describe("ruleAmountMismatch", () => {
    it("returns partial confidence for amount disputes on completed transactions", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1, command: "", oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1, command: "", oid: 0, fields: [] });

      const ctx = makeContext({ reason: "Wrong amount charged" });
      const result = await evaluateDispute(ctx);
      // confidence 0.7 is below threshold 0.85, so should return null
      expect(result).toBeNull();
    });
  });
});
