import { providerErrorMapService, ProviderErrorMapping } from "../providerErrorMap";

describe("ProviderErrorMapService", () => {
  describe("mapError", () => {
    it("should map known MTN error code", () => {
      const mapping = providerErrorMapService.mapError("mtn", "4001", "Invalid credentials");
      expect(mapping).not.toBeNull();
      expect(mapping!.mappedCode).toBe("INVALID_CREDENTIALS");
      expect(mapping!.userMessage).toContain("authentication failed");
      expect(mapping!.isRetryable).toBe(false);
    });

    it("should map known Airtel error code", () => {
      const mapping = providerErrorMapService.mapError("airtel", "INSUFFICIENT", "Insufficient funds");
      expect(mapping).not.toBeNull();
      expect(mapping!.mappedCode).toBe("INSUFFICIENT_FUNDS");
      expect(mapping!.userMessage).toContain("Insufficient balance");
    });

    it("should return fallback for unknown error code", () => {
      const mapping = providerErrorMapService.mapError("mtn", "9999", "Unknown error");
      expect(mapping).not.toBeNull();
      expect(mapping!.mappedCode).toBe("PROVIDER_ERROR");
      expect(mapping!.isRetryable).toBe(true);
    });

    it("should return null for completely unknown provider without fallback", () => {
      const mapping = providerErrorMapService.mapError("unknown" as any, "123", "Error");
      expect(mapping).not.toBeNull();
      expect(mapping!.provider).toBe("unknown");
    });
  });

  describe("getLocalizedError", () => {
    it("should return English message by default", () => {
      const error = providerErrorMapService.getLocalizedError("mtn", "4001");
      expect(error.locale).toBe("en");
      expect(error.code).toBe("INVALID_CREDENTIALS");
    });

    it("should return French message when requested", () => {
      const error = providerErrorMapService.getLocalizedError("mtn", "4001", "fr");
      expect(error.locale).toBe("fr");
      expect(error.message).toContain("prestataire");
    });

    it("should return fallback for unmapped error code", () => {
      const error = providerErrorMapService.getLocalizedError("mtn", "9999", "en");
      expect(error.code).toBe("PROVIDER_ERROR");
    });
  });

  describe("getErrorDocumentation", () => {
    it("should return all mappings for a provider", () => {
      const docs = providerErrorMapService.getErrorDocumentation("mtn");
      expect(docs.length).toBeGreaterThan(0);
      expect(docs.every((d) => d.provider === "mtn")).toBe(true);
    });

    it("should return empty array for unknown provider", () => {
      const docs = providerErrorMapService.getErrorDocumentation("unknown" as any);
      expect(docs).toEqual([]);
    });
  });

  describe("getAllMappings", () => {
    it("should return all error mappings", () => {
      const all = providerErrorMapService.getAllMappings();
      expect(all.length).toBeGreaterThan(0);
      expect(all.some((m) => m.provider === "mtn")).toBe(true);
      expect(all.some((m) => m.provider === "airtel")).toBe(true);
      expect(all.some((m) => m.provider === "orange")).toBe(true);
    });
  });
});
