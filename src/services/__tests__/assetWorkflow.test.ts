import { assetWorkflowService, AssetIssuanceRequestModel } from "../services/assetWorkflowService";
import { queryRead, queryWrite } from "../../config/database";
import { AssetIssuanceService } from "../../services/stellar/issuanceService";

jest.mock("../../config/database");
jest.mock("../../services/stellar/issuanceService");

describe("AssetWorkflowService", () => {
  let model: AssetIssuanceRequestModel;

  beforeEach(() => {
    jest.clearAllMocks();
    model = new AssetIssuanceRequestModel();
  });

  describe("AssetIssuanceRequestModel", () => {
    it("should create a request", async () => {
      (queryRead as jest.Mock).mockResolvedValue({ rows: [] });
      (queryWrite as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USD",
            name: "USD Coin",
            description: "Test",
            limit: "1000000",
            status: "draft",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const request = await model.create({
        assetCode: "USD",
        name: "USD Coin",
        description: "Test",
        limit: "1000000",
        requestedBy: "user-1",
      });

      expect(request.assetCode).toBe("USD");
      expect(request.status).toBe("draft");
    });

    it("should throw if asset code already exists", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [{ id: "req-existing", asset_code: "USD" }],
      });

      await expect(
        model.create({
          assetCode: "USD",
          name: "USD Coin",
          limit: "1000000",
          requestedBy: "user-1",
        }),
      ).rejects.toThrow("already exists");
    });
  });

  describe("validateConfiguration", () => {
    it("should validate correct configuration", () => {
      const result = assetWorkflowService.validateConfiguration({ assetCode: "USD", name: "USD Coin", limit: "1000000" });
      expect(result.isValid).toBe(true);
    });

    it("should reject invalid asset code", () => {
      const result = assetWorkflowService.validateConfiguration({ assetCode: "", name: "USD Coin", limit: "1000000" });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes("1 and 12"))).toBe(true);
    });

    it("should reject invalid limit", () => {
      const result = assetWorkflowService.validateConfiguration({ assetCode: "USD", name: "USD Coin", limit: "-1" });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes("positive number"))).toBe(true);
    });
  });

  describe("submitForApproval", () => {
    it("should submit draft request for approval", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USD",
            name: "USD Coin",
            limit: "1000000",
            status: "draft",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });
      (queryWrite as jest.Mock).mockResolvedValue({ rows: [] });

      const request = await assetWorkflowService.submitForApproval("req-1");
      expect(request.status).toBe("pending_approval");
    });

    it("should throw if request is not in draft", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USD",
            name: "USD Coin",
            limit: "1000000",
            status: "pending_approval",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      await expect(assetWorkflowService.submitForApproval("req-1")).rejects.toThrow("Cannot submit request");
    });
  });

  describe("approveRequest", () => {
    it("should approve a pending request", async () => {
      (queryRead as jest.Mock).mockResolvedValue({
        rows: [
          {
            id: "req-1",
            asset_code: "USD",
            name: "USD Coin",
            limit: "1000000",
            status: "pending_approval",
            requested_by: "user-1",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });
      (queryWrite as jest.Mock).mockResolvedValue({ rows: [] });
      (AssetIssuanceService as jest.MockedClass<typeof AssetIssuanceService>).mockImplementation(() => ({
        setupAnchoredAsset: jest.fn().mockResolvedValue({ assetCode: "USD", issuerPublicKey: "G...", distributionPublicKey: "G..." }),
      } as any));

      const request = await assetWorkflowService.approveRequest("req-1", "admin-1", "approve", "Looks good");
      expect(request.status).toBe("approved");
    });
  });
});
