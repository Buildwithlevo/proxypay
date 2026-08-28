import {
  generatePortalUrl,
  verifyPortalToken,
  consumePortalToken,
} from "../services/merchantPortalService";

// Mock database pool
jest.mock("../config/database", () => ({
  pool: {
    query: jest.fn(),
  },
}));

import { pool } from "../config/database";
const mockPool = pool as jest.Mocked<typeof pool>;

describe("merchantPortalService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("generatePortalUrl", () => {
    it("generates a portal URL for a valid merchant", async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: "m1",
              name: "Test Merchant",
              email: "test@example.com",
              business_name: "Test Corp",
              phone_number: "+1234567890",
              status: "active",
            },
          ],
          rowCount: 1,
          command: "",
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 1,
          command: "",
          fields: [],
        });

      const result = await generatePortalUrl("m1");

      expect(result.url).toContain("/session?token=");
      expect(result.merchantId).toBe("m1");
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it("throws for non-existent merchant", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: "",
        fields: [],
      });

      await expect(generatePortalUrl("nonexistent")).rejects.toThrow(
        "Merchant not found",
      );
    });
  });

  describe("verifyPortalToken", () => {
    it("returns null for invalid token", () => {
      expect(verifyPortalToken("invalid.token.here")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(verifyPortalToken("")).toBeNull();
    });

    it("returns null for malformed token", () => {
      expect(verifyPortalToken("abc")).toBeNull();
    });
  });
});
