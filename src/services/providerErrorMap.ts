export type ProviderName = "mtn" | "airtel" | "orange" | "generic";

export interface ProviderErrorMapping {
  provider: ProviderName;
  providerErrorCode: string;
  providerErrorMessage: string;
  mappedCode: string;
  userMessage: string;
  recoverySuggestion: string;
  isRetryable: boolean;
  severity: "low" | "medium" | "high" | "critical";
}

export interface LocalizedError {
  code: string;
  message: string;
  recoverySuggestion: string;
  locale: string;
}

const ERROR_MAPPINGS: ProviderErrorMapping[] = [
  {
    provider: "mtn",
    providerErrorCode: "4001",
    providerErrorMessage: "Invalid credentials",
    mappedCode: "INVALID_CREDENTIALS",
    userMessage: "Payment provider authentication failed. Please try again later.",
    recoverySuggestion: "Contact support if the issue persists.",
    isRetryable: false,
    severity: "high",
  },
  {
    provider: "mtn",
    providerErrorCode: "4002",
    providerErrorMessage: "Insufficient balance",
    mappedCode: "INSUFFICIENT_FUNDS",
    userMessage: "Insufficient balance to complete this transaction.",
    recoverySuggestion: "Top up your account and try again.",
    isRetryable: false,
    severity: "medium",
  },
  {
    provider: "mtn",
    providerErrorCode: "4003",
    providerErrorMessage: "Transaction expired",
    mappedCode: "TRANSACTION_EXPIRED",
    userMessage: "This transaction has expired.",
    recoverySuggestion: "Initiate a new transaction.",
    isRetryable: false,
    severity: "medium",
  },
  {
    provider: "mtn",
    providerErrorCode: "5001",
    providerErrorMessage: "Internal server error",
    mappedCode: "PROVIDER_ERROR",
    userMessage: "Payment provider is experiencing issues. Please try again in a few minutes.",
    recoverySuggestion: "Retry after 5 minutes. If it fails again, contact support.",
    isRetryable: true,
    severity: "high",
  },
  {
    provider: "airtel",
    providerErrorCode: "AUTH_FAILED",
    providerErrorMessage: "Authentication failed",
    mappedCode: "INVALID_CREDENTIALS",
    userMessage: "Payment provider authentication failed. Please try again later.",
    recoverySuggestion: "Contact support if the issue persists.",
    isRetryable: false,
    severity: "high",
  },
  {
    provider: "airtel",
    providerErrorCode: "INSUFFICIENT",
    providerErrorMessage: "Insufficient funds",
    mappedCode: "INSUFFICIENT_FUNDS",
    userMessage: "Insufficient balance to complete this transaction.",
    recoverySuggestion: "Top up your account and try again.",
    isRetryable: false,
    severity: "medium",
  },
  {
    provider: "orange",
    providerErrorCode: "ORANGE_401",
    providerErrorMessage: "Unauthorized",
    mappedCode: "UNAUTHORIZED",
    userMessage: "Payment provider authentication failed.",
    recoverySuggestion: "Contact support if the issue persists.",
    isRetryable: false,
    severity: "high",
  },
  {
    provider: "orange",
    providerErrorCode: "ORANGE_503",
    providerErrorMessage: "Service unavailable",
    mappedCode: "SERVICE_UNAVAILABLE",
    userMessage: "Payment provider is temporarily unavailable.",
    recoverySuggestion: "Retry after a few minutes.",
    isRetryable: true,
    severity: "high",
  },
];

const LOCALIZED_MESSAGES: Record<string, Record<string, { message: string; recovery: string }>> = {
  en: {
    INVALID_CREDENTIALS: { message: "Payment provider authentication failed. Please try again later.", recovery: "Contact support if the issue persists." },
    INSUFFICIENT_FUNDS: { message: "Insufficient balance to complete this transaction.", recovery: "Top up your account and try again." },
    TRANSACTION_EXPIRED: { message: "This transaction has expired.", recovery: "Initiate a new transaction." },
    PROVIDER_ERROR: { message: "Payment provider is experiencing issues. Please try again in a few minutes.", recovery: "Retry after 5 minutes. If it fails again, contact support." },
    SERVICE_UNAVAILABLE: { message: "Payment provider is temporarily unavailable.", recovery: "Retry after a few minutes." },
  },
  fr: {
    INVALID_CREDENTIALS: { message: "L'authentification du prestataire de paiement a échoué. Veuillez réessayer plus tard.", recovery: "Contactez le support si le problème persiste." },
    INSUFFICIENT_FUNDS: { message: "Solde insuffisant pour effectuer cette transaction.", recovery: "Rechargez votre compte et réessayez." },
    TRANSACTION_EXPIRED: { message: "Cette transaction a expiré.", recovery: "Initiez une nouvelle transaction." },
    PROVIDER_ERROR: { message: "Le prestataire de paiement rencontre des problèmes. Veuillez réessayer dans quelques minutes.", recovery: "Réessayez après 5 minutes. Si cela échoue à nouveau, contactez le support." },
    SERVICE_UNAVAILABLE: { message: "Le prestataire de paiement est temporairement indisponible.", recovery: "Réessayez dans quelques minutes." },
  },
};

export class ProviderErrorMapService {
  private mappings: Map<string, ProviderErrorMapping> = new Map();

  constructor() {
    for (const mapping of ERROR_MAPPINGS) {
      const key = `${mapping.provider}:${mapping.providerErrorCode}`;
      this.mappings.set(key, mapping);
    }
  }

  mapError(provider: ProviderName, providerErrorCode: string, providerErrorMessage?: string): ProviderErrorMapping | null {
    const key = `${provider}:${providerErrorCode}`;
    const mapping = this.mappings.get(key);

    if (mapping) return mapping;

    const fallback = this.mappings.get(`${provider}:default`);
    if (fallback) return fallback;

    return {
      provider,
      providerErrorCode,
      providerErrorMessage: providerErrorMessage || "Unknown error",
      mappedCode: "PROVIDER_ERROR",
      userMessage: "An unexpected error occurred. Please try again.",
      recoverySuggestion: "Contact support if the issue persists.",
      isRetryable: true,
      severity: "medium",
    };
  }

  getLocalizedError(provider: ProviderName, providerErrorCode: string, locale = "en"): LocalizedError {
    const mapping = this.mapError(provider, providerErrorCode);
    if (!mapping) {
      return {
        code: "PROVIDER_ERROR",
        message: "An unexpected error occurred. Please try again.",
        recoverySuggestion: "Contact support if the issue persists.",
        locale,
      };
    }

    const localized = LOCALIZED_MESSAGES[locale]?.[mapping.mappedCode] || LOCALIZED_MESSAGES["en"]?.[mapping.mappedCode];

    return {
      code: mapping.mappedCode,
      message: localized?.message || mapping.userMessage,
      recoverySuggestion: localized?.recovery || mapping.recoverySuggestion,
      locale,
    };
  }

  getErrorDocumentation(provider: ProviderName): ProviderErrorMapping[] {
    return ERROR_MAPPINGS.filter((m) => m.provider === provider);
  }

  getAllMappings(): ProviderErrorMapping[] {
    return [...ERROR_MAPPINGS];
  }
}

export const providerErrorMapService = new ProviderErrorMapService();
