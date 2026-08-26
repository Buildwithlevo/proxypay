jest.mock("../../src/config/database", () => {
  return {
    pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
    queryRead: jest.fn().mockResolvedValue({ rows: [] }),
    queryWrite: jest.fn().mockResolvedValue({ rows: [] }),
  };
});

import { queryRead } from "../../src/config/database";
import {
  DisputeResolutionEngine,
} from "../../src/services/disputeResolutionEngine";
import { DisputeModel } from "../../src/models/dispute";
import { TransactionModel, TransactionStatus } from "../../src/models/transaction";

const mockQueryRead = queryRead as jest.Mock;

const txId = "tx-001";
const disputeId = "dispute-001";

const baseTransaction = {
  id: txId,
  userId: "user-1",
  referenceNumber: "TXN-001",
  type: "deposit",
  amount: "100",
  phoneNumber: "+237600000000",
  provider: "mtn",
  stellarAddress: "G".padEnd(56, "A"),
  tags: [],
  status: TransactionStatus.Completed,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseDispute = (overrides: Record<string, any> = {}) => ({
  id: disputeId,
  transactionId: txId,
  reason: "Wrong amount charged",
  status: "open" as const,
  assignedTo: null,
  resolution: null,
  reportedBy: "user-1",
  priority: "medium" as const,
  category: null,
  slaDueDate: null,
  slaWarningSent: false,
  internalNotes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("DisputeResolutionEngine (#372)", () => {
  let engine: DisputeResolutionEngine;

  beforeEach(() => {
    engine = new DisputeResolutionEngine();
    jest.clearAllMocks();
    mockQueryRead.mockResolvedValue({ rows: [] });
  });

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  describe("configuration", () => {
    it("initializes with default rules", () => {
      const rules = engine.getRules();
      expect(rules.length).toBeGreaterThanOrEqual(5);
      expect(rules.every((r) => r.id && r.name && r.type)).toBe(true);
    });

    it("returns a copy of config", () => {
      const config = engine.getConfig();
      config.enabled = false;
      expect(engine.getConfig().enabled).toBe(true);
    });

    it("updates enabled flag", () => {
      engine.updateConfig({ enabled: false });
      expect(engine.getConfig().enabled).toBe(false);
    });

    it("updates duplicate window", () => {
      engine.updateConfig({ duplicateWindowMinutes: 10 });
      expect(engine.getConfig().duplicateWindowMinutes).toBe(10);
    });

    it("toggles individual rules", () => {
      engine.toggleRule("duplicate-transaction", false);
      const rule = engine.getRules().find((r) => r.id === "duplicate-transaction");
      expect(rule!.enabled).toBe(false);
    });

    it("handles toggle for non-existent rule gracefully", () => {
      expect(() => engine.toggleRule("non-existent", false)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicate transaction detection
  // ---------------------------------------------------------------------------

  describe("duplicate transaction detection", () => {
    it("resolves dispute when duplicates found", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute());

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 2 }] });

      const result = await engine.evaluateDispute(disputeId);
      expect(result.resolved).toBe(true);
      expect(result.action).toBe("resolve");
      expect(result.autoResolvedBy).toBe("duplicate-transaction");
      expect(result.resolution).toContain("Duplicate transaction detected");
    });

    it("does not match when no duplicates found", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute({ reason: "some other reason" }));

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      expect(result.resolved).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Amount mismatch detection
  // ---------------------------------------------------------------------------

  describe("amount mismatch detection", () => {
    it("resolves small amount mismatches", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(
          baseDispute({ reason: "I was charged 101 but should be 100" }),
        );

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      expect(result.resolved).toBe(true);
      expect(result.action).toBe("resolve");
      expect(result.resolution).toContain("Amount mismatch");
    });

    it("rejects when amount keywords are missing", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(
          baseDispute({ reason: "Service was not delivered" }),
        );

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      expect(result.resolved).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout resolution
  // ---------------------------------------------------------------------------

  describe("timeout resolution", () => {
    it("resolves failed transactions with timeout reason", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(
          baseDispute({ reason: "Transaction timed out, money deducted" }),
        );

      jest.spyOn(TransactionModel.prototype, "findById").mockResolvedValue({
        ...baseTransaction,
        status: TransactionStatus.Failed,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      } as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      expect(result.resolved).toBe(true);
      expect(result.action).toBe("resolve");
      expect(result.autoResolvedBy).toBe("timeout-resolution");
    });

    it("does not resolve completed transactions as timeout", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(
          baseDispute({ reason: "Transaction timed out" }),
        );

      jest.spyOn(TransactionModel.prototype, "findById").mockResolvedValue({
        ...baseTransaction,
        status: TransactionStatus.Completed,
      } as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      const timeoutEval = result.evaluated.find(
        (e) => e.ruleId === "timeout-resolution",
      );
      expect(timeoutEval?.matched).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Provider failure detection
  // ---------------------------------------------------------------------------

  describe("provider failure detection", () => {
    it("resolves disputes caused by known provider errors", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute());

      jest.spyOn(TransactionModel.prototype, "findById").mockResolvedValue({
        ...baseTransaction,
        status: TransactionStatus.Failed,
        errorCode: "provider_unavailable",
      } as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      const providerEval = result.evaluated.find(
        (e) => e.ruleId === "provider-failure",
      );
      expect(providerEval?.matched).toBe(true);
      expect(result.action).toBe("resolve");
    });

    it("does not match non-failed transactions", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute());

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue({
          ...baseTransaction,
          status: TransactionStatus.Completed,
          errorCode: "provider_unavailable",
        } as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      const providerEval = result.evaluated.find(
        (e) => e.ruleId === "provider-failure",
      );
      expect(providerEval?.matched).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Stale dispute handling
  // ---------------------------------------------------------------------------

  describe("stale dispute handling", () => {
    it("rejects disputes older than threshold", async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute({ createdAt: oldDate }));

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      const staleEval = result.evaluated.find(
        (e) => e.ruleId === "stale-dispute",
      );
      expect(staleEval?.matched).toBe(true);
    });

    it("does not reject recent disputes", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute());

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      const staleEval = result.evaluated.find(
        (e) => e.ruleId === "stale-dispute",
      );
      expect(staleEval?.matched).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-resolve execution
  // ---------------------------------------------------------------------------

  describe("autoResolve", () => {
    it("updates dispute status on auto-resolve", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute());

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 2 }] });

      const updateSpy = jest
        .spyOn(DisputeModel.prototype, "update")
        .mockResolvedValue(baseDispute({ status: "resolved" }) as any);

      const txUpdateSpy = jest
        .spyOn(TransactionModel.prototype, "updateStatus")
        .mockResolvedValue(undefined);

      const result = await engine.autoResolve(disputeId);
      expect(result.resolved).toBe(true);
      expect(updateSpy).toHaveBeenCalled();
      expect(txUpdateSpy).toHaveBeenCalled();
    });

    it("does not resolve when no rule matches", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(
          baseDispute({ reason: "Service was excellent" }),
        );

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      mockQueryRead.mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.autoResolve(disputeId);
      expect(result.resolved).toBe(false);
    });

    it("returns error for non-existent dispute", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(null);

      await expect(engine.autoResolve("nonexistent")).rejects.toThrow(
        "not found",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Batch processing
  // ---------------------------------------------------------------------------

  describe("processOpenDisputes", () => {
    it("processes multiple disputes and counts results", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findSlaWarningCandidates")
        .mockResolvedValue([
          baseDispute({ id: "d1" }) as any,
          baseDispute({ id: "d2", reason: "Service not delivered" }) as any,
        ]);

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute() as any);

      mockQueryRead
        .mockResolvedValueOnce({ rows: [{ duplicate_count: 2 }] })
        .mockResolvedValueOnce({ rows: [{ duplicate_count: 0 }] });

      jest
        .spyOn(DisputeModel.prototype, "update")
        .mockResolvedValue(baseDispute({ status: "resolved" }) as any);

      jest
        .spyOn(TransactionModel.prototype, "updateStatus")
        .mockResolvedValue(undefined);

      const result = await engine.processOpenDisputes();
      expect(result.processed).toBe(2);
      expect(result.resolved).toBeGreaterThanOrEqual(1);
    });

    it("handles errors in batch processing gracefully", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findSlaWarningCandidates")
        .mockResolvedValue([baseDispute({ id: "d-fail" }) as any]);

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockRejectedValue(new Error("db error"));

      const result = await engine.processOpenDisputes();
      expect(result.processed).toBe(1);
      expect(result.resolved).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Disabled engine
  // ---------------------------------------------------------------------------

  describe("disabled engine", () => {
    it("returns no resolution when engine is disabled", async () => {
      const disabledEngine = new DisputeResolutionEngine({ enabled: false });

      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(baseDispute());

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue(baseTransaction as any);

      const result = await disabledEngine.evaluateDispute(disputeId);
      expect(result.resolved).toBe(false);
      expect(result.evaluated).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rule priority
  // ---------------------------------------------------------------------------

  describe("rule priority", () => {
    it("evaluates rules in priority order and stops at first match", async () => {
      jest
        .spyOn(DisputeModel.prototype, "findById")
        .mockResolvedValue(
          baseDispute({ reason: "Payment timed out" }),
        );

      jest
        .spyOn(TransactionModel.prototype, "findById")
        .mockResolvedValue({
          ...baseTransaction,
          status: TransactionStatus.Failed,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        } as any);

      mockQueryRead.mockResolvedValue({ rows: [{ duplicate_count: 0 }] });

      const result = await engine.evaluateDispute(disputeId);
      expect(result.resolved).toBe(true);
      expect(result.autoResolvedBy).toBe("timeout-resolution");

      const duplicateIdx = result.evaluated.findIndex(
        (e) => e.ruleId === "duplicate-transaction",
      );
      const timeoutIdx = result.evaluated.findIndex(
        (e) => e.ruleId === "timeout-resolution",
      );
      expect(duplicateIdx).toBeLessThan(timeoutIdx);
    });
  });
});
