/**
 * @file src/services/accountMergeDryRun.ts
 *
 * Stellar Account Merge Dry-Run Service (Issue #421)
 *
 * Provides safe, non-destructive simulation of account merge operations.
 *
 * Features:
 *  - Pre-merge validation checks (balances, trustlines, signers, sequence numbers)
 *  - Detailed impact report showing what *would* happen on a real merge
 *  - Merchant review capability — return a ReviewReport that must be
 *    explicitly approved before the merge is executed.
 *  - Zero Stellar network state is modified (all checks are read-only).
 */

import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../config/stellar";
import {
  evaluateAccountMergeCandidate,
  xlmToStroops,
  stroopsToXlm,
  AccountMergeCandidate,
} from "../jobs/accountMerge";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A single pre-merge check result. */
export interface PreMergeCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Per-trustline information gathered during a dry-run. */
export interface TrustlineInfo {
  assetCode: string;
  assetIssuer: string;
  balance: string;
  limit: string;
  isAuthorised: boolean;
}

/** Per-signer information gathered during a dry-run. */
export interface SignerInfo {
  key: string;
  weight: number;
  type: string;
}

/** Complete dry-run validation report for a single account. */
export interface AccountMergeDryRunReport {
  /** Stellar public key of the source account. */
  sourcePublicKey: string;
  /** Stellar public key of the destination account. */
  destinationPublicKey: string;
  /** Whether the merge is eligible to proceed. */
  eligible: boolean;
  /** Human-readable summary of the eligibility outcome. */
  summary: string;
  /** Native XLM balance that would be reclaimed. */
  reclaimableXLM: string;
  /** Number of subentries (trustlines, offers, signers, data). */
  subentryCount: number;
  /** Trustlines currently on the source account. */
  trustlines: TrustlineInfo[];
  /** Signers configured on the source account. */
  signers: SignerInfo[];
  /** Current sequence number of the source account. */
  sequenceNumber: string;
  /** Date of last on-chain activity (or null if no transactions found). */
  lastActivityAt: Date | null;
  /** Ordered list of individual pre-merge checks performed. */
  checks: PreMergeCheck[];
  /** Whether the account was found on Horizon. */
  accountFound: boolean;
  /** ISO timestamp when this report was generated. */
  generatedAt: string;
}

/** Result of running dry-run on multiple accounts in batch. */
export interface BatchDryRunResult {
  totalAccounts: number;
  eligible: number;
  ineligible: number;
  notFound: number;
  totalReclaimableXLM: string;
  reports: AccountMergeDryRunReport[];
}

/** Merchant review record: wraps a dry-run report with approval state. */
export interface MerchantReviewRecord {
  id: string;
  sourcePublicKey: string;
  dryRunReport: AccountMergeDryRunReport;
  reviewRequestedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  approved: boolean | null;
  reviewNotes: string | null;
}

// ---------------------------------------------------------------------------
// In-memory merchant review store (replace with DB in production)
// ---------------------------------------------------------------------------

const reviewStore = new Map<string, MerchantReviewRecord>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STROOPS_PER_XLM = 10_000_000n;

function nativeBalance(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): string {
  return (
    account.balances.find((b) => b.asset_type === "native")?.balance ?? "0"
  );
}

function getTrustlines(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): TrustlineInfo[] {
  return account.balances
    .filter((b) => b.asset_type !== "native")
    .map((b) => {
      const balance = b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset;
      return {
        assetCode: balance.asset_code ?? "",
        assetIssuer: balance.asset_issuer ?? "",
        balance: balance.balance,
        limit: balance.limit,
        isAuthorised: balance.is_authorized ?? false,
      };
    });
}

function getSigners(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): SignerInfo[] {
  return account.signers.map((s) => ({
    key: s.key,
    weight: s.weight,
    type: s.type,
  }));
}

async function fetchLastActivity(
  server: StellarSdk.Horizon.Server,
  publicKey: string,
): Promise<Date | null> {
  try {
    const response = await server
      .transactions()
      .forAccount(publicKey)
      .order("desc")
      .limit(1)
      .call();
    const tx = response.records[0];
    return tx ? new Date(tx.created_at) : null;
  } catch {
    return null;
  }
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { response?: { status?: number } };
  return e?.response?.status === 404;
}

// ---------------------------------------------------------------------------
// Core dry-run logic
// ---------------------------------------------------------------------------

/**
 * Run a complete pre-merge dry-run for a single account.
 *
 * @param sourcePublicKey       Ed25519 public key of the account to merge.
 * @param destinationPublicKey  Ed25519 public key of the merge destination.
 * @param inactivityDays        Number of days of inactivity required.
 * @param server                (Optional) Horizon server instance — injectable for tests.
 */
export async function runAccountMergeDryRun(
  sourcePublicKey: string,
  destinationPublicKey: string,
  inactivityDays = 30,
  server?: StellarSdk.Horizon.Server,
): Promise<AccountMergeDryRunReport> {
  const horizonServer = server ?? getStellarServer();
  const generatedAt = new Date().toISOString();
  const checks: PreMergeCheck[] = [];

  // --- Check 1: valid public keys ---
  const validSource = StellarSdk.StrKey.isValidEd25519PublicKey(sourcePublicKey);
  checks.push({
    name: "valid_source_key",
    passed: validSource,
    detail: validSource
      ? "Source public key is a valid Ed25519 key"
      : `Invalid source public key: ${sourcePublicKey}`,
  });

  const validDest = StellarSdk.StrKey.isValidEd25519PublicKey(destinationPublicKey);
  checks.push({
    name: "valid_destination_key",
    passed: validDest,
    detail: validDest
      ? "Destination public key is a valid Ed25519 key"
      : `Invalid destination public key: ${destinationPublicKey}`,
  });

  if (!validSource || !validDest) {
    return {
      sourcePublicKey,
      destinationPublicKey,
      eligible: false,
      summary: "Invalid public key(s) — cannot proceed with merge check",
      reclaimableXLM: "0",
      subentryCount: 0,
      trustlines: [],
      signers: [],
      sequenceNumber: "0",
      lastActivityAt: null,
      checks,
      accountFound: false,
      generatedAt,
    };
  }

  // --- Check 2: source ≠ destination ---
  const notSelf = sourcePublicKey !== destinationPublicKey;
  checks.push({
    name: "source_not_destination",
    passed: notSelf,
    detail: notSelf
      ? "Source and destination are different accounts"
      : "Source and destination are the same account — merge would be a no-op",
  });

  if (!notSelf) {
    return {
      sourcePublicKey,
      destinationPublicKey,
      eligible: false,
      summary: "Source and destination are the same account",
      reclaimableXLM: "0",
      subentryCount: 0,
      trustlines: [],
      signers: [],
      sequenceNumber: "0",
      lastActivityAt: null,
      checks,
      accountFound: false,
      generatedAt,
    };
  }

  // --- Fetch account from Horizon ---
  let account: StellarSdk.Horizon.ServerApi.AccountRecord;
  try {
    account = await horizonServer.loadAccount(sourcePublicKey);
  } catch (err) {
    const notFound = isNotFoundError(err);
    checks.push({
      name: "account_exists",
      passed: false,
      detail: notFound
        ? "Account not found on Horizon — it may have already been merged or never funded"
        : `Failed to load account: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      sourcePublicKey,
      destinationPublicKey,
      eligible: false,
      summary: notFound
        ? "Account not found on Horizon"
        : "Failed to fetch account from Horizon",
      reclaimableXLM: "0",
      subentryCount: 0,
      trustlines: [],
      signers: [],
      sequenceNumber: "0",
      lastActivityAt: null,
      checks,
      accountFound: false,
      generatedAt,
    };
  }

  checks.push({
    name: "account_exists",
    passed: true,
    detail: "Account found on Horizon",
  });

  // --- Gather account data ---
  const xlmBalance = nativeBalance(account);
  const trustlines = getTrustlines(account);
  const signers = getSigners(account);
  const sequenceNumber = account.sequence;
  const lastActivityAt = await fetchLastActivity(horizonServer, sourcePublicKey);

  const candidate: AccountMergeCandidate = {
    nativeBalance: xlmBalance,
    subentryCount: account.subentry_count,
    hasNonNativeBalances: trustlines.some(
      (t) => parseFloat(t.balance) > 0,
    ),
    lastActivityAt,
  };

  // --- Check 3: sufficient balance ---
  const balanceStroops = xlmToStroops(xlmBalance);
  const BASE_FEE = BigInt(StellarSdk.BASE_FEE.toString());
  const hasBalance = balanceStroops > BASE_FEE;
  checks.push({
    name: "sufficient_balance",
    passed: hasBalance,
    detail: hasBalance
      ? `Native balance ${xlmBalance} XLM is sufficient to cover the merge fee`
      : `Native balance ${xlmBalance} XLM is too low to cover the merge fee`,
  });

  // --- Check 4: no subentries ---
  const noSubentries = account.subentry_count === 0;
  checks.push({
    name: "no_subentries",
    passed: noSubentries,
    detail: noSubentries
      ? "Account has no subentries — safe to merge"
      : `Account has ${account.subentry_count} subentrie(s) that must be removed before merging`,
  });

  // --- Check 5: no non-native balances ---
  const noNonNative = !candidate.hasNonNativeBalances;
  checks.push({
    name: "no_non_native_balances",
    passed: noNonNative,
    detail: noNonNative
      ? "Account holds no non-native asset balances"
      : `Account holds non-native assets: ${trustlines.filter((t) => parseFloat(t.balance) > 0).map((t) => t.assetCode).join(", ")}`,
  });

  // --- Check 6: inactivity ---
  let isInactive = true;
  if (lastActivityAt) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - inactivityDays);
    isInactive = lastActivityAt <= cutoff;
  }
  checks.push({
    name: "inactivity_requirement",
    passed: isInactive,
    detail: isInactive
      ? `Account has been inactive for at least ${inactivityDays} day(s)`
      : `Account was active after the ${inactivityDays}-day inactivity cutoff (last activity: ${lastActivityAt?.toISOString() ?? "unknown"})`,
  });

  // --- Check 7: destination account exists ---
  let destExists = false;
  try {
    await horizonServer.loadAccount(destinationPublicKey);
    destExists = true;
  } catch {
    // destination may not exist — that's allowed for account merge
    destExists = false;
  }
  checks.push({
    name: "destination_exists",
    passed: destExists,
    detail: destExists
      ? "Destination account exists on Horizon"
      : "Destination account not found on Horizon (merge will create it)",
  });

  // --- Check 8: single primary signer (no multisig) ---
  const primarySigners = signers.filter(
    (s) => s.key === sourcePublicKey && s.weight > 0,
  );
  const isSimpleSigner = primarySigners.length === 1 && signers.length === 1;
  checks.push({
    name: "simple_signer",
    passed: isSimpleSigner,
    detail: isSimpleSigner
      ? "Account uses a simple single-signer configuration"
      : `Account has ${signers.length} signer(s) — verify multisig before merging`,
  });

  // --- Compute reclaimable balance ---
  const evaluation = evaluateAccountMergeCandidate(candidate, inactivityDays);

  const allChecksPassed = checks.every((c) => c.passed);

  return {
    sourcePublicKey,
    destinationPublicKey,
    eligible: allChecksPassed && evaluation.eligible,
    summary: evaluation.eligible && allChecksPassed
      ? `Account is eligible for merge — ${evaluation.reclaimableBalance} XLM will be reclaimed`
      : evaluation.reason
        ? `Account is ineligible: ${evaluation.reason}`
        : `Pre-merge checks failed — see individual checks for details`,
    reclaimableXLM: evaluation.reclaimableBalance,
    subentryCount: account.subentry_count,
    trustlines,
    signers,
    sequenceNumber,
    lastActivityAt,
    checks,
    accountFound: true,
    generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Batch dry-run
// ---------------------------------------------------------------------------

/**
 * Run dry-run checks on multiple accounts in parallel.
 */
export async function runBatchDryRun(
  accounts: Array<{
    sourcePublicKey: string;
    destinationPublicKey: string;
    inactivityDays?: number;
  }>,
  server?: StellarSdk.Horizon.Server,
): Promise<BatchDryRunResult> {
  const reports = await Promise.all(
    accounts.map(({ sourcePublicKey, destinationPublicKey, inactivityDays = 30 }) =>
      runAccountMergeDryRun(
        sourcePublicKey,
        destinationPublicKey,
        inactivityDays,
        server,
      ),
    ),
  );

  let totalReclaimableStroops = 0n;
  let eligible = 0;
  let ineligible = 0;
  let notFound = 0;

  for (const r of reports) {
    if (!r.accountFound) {
      notFound++;
    } else if (r.eligible) {
      eligible++;
      try {
        totalReclaimableStroops += xlmToStroops(r.reclaimableXLM);
      } catch {
        // ignore parse errors
      }
    } else {
      ineligible++;
    }
  }

  const totalReclaimableXLM =
    totalReclaimableStroops > 0n
      ? stroopsToXlm(totalReclaimableStroops)
      : "0";

  return {
    totalAccounts: reports.length,
    eligible,
    ineligible,
    notFound,
    totalReclaimableXLM,
    reports,
  };
}

// ---------------------------------------------------------------------------
// Merchant review
// ---------------------------------------------------------------------------

/**
 * Submit a dry-run report for merchant review.
 * Returns the review record ID that merchants/admins can use to approve/reject.
 */
export function submitForMerchantReview(
  report: AccountMergeDryRunReport,
): MerchantReviewRecord {
  const id = `review-${report.sourcePublicKey}-${Date.now()}`;
  const record: MerchantReviewRecord = {
    id,
    sourcePublicKey: report.sourcePublicKey,
    dryRunReport: report,
    reviewRequestedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
    approved: null,
    reviewNotes: null,
  };
  reviewStore.set(id, record);
  return record;
}

/**
 * Record a merchant/admin review decision.
 *
 * @param reviewId   The ID returned by `submitForMerchantReview`.
 * @param approved   Whether the merge was approved.
 * @param reviewedBy Identifier of the reviewer.
 * @param notes      Optional review notes.
 */
export function recordMerchantReviewDecision(
  reviewId: string,
  approved: boolean,
  reviewedBy: string,
  notes?: string,
): MerchantReviewRecord {
  const record = reviewStore.get(reviewId);
  if (!record) {
    throw new Error(`Review record ${reviewId} not found`);
  }
  record.reviewedAt = new Date();
  record.reviewedBy = reviewedBy;
  record.approved = approved;
  record.reviewNotes = notes ?? null;
  return record;
}

/**
 * Retrieve a merchant review record by ID.
 */
export function getMerchantReviewRecord(
  reviewId: string,
): MerchantReviewRecord | undefined {
  return reviewStore.get(reviewId);
}

/**
 * Retrieve all pending (not yet reviewed) merchant review records.
 */
export function getPendingMerchantReviews(): MerchantReviewRecord[] {
  return Array.from(reviewStore.values()).filter((r) => r.approved === null);
}

/** Clear the review store (for testing only). */
export function clearReviewStore(): void {
  reviewStore.clear();
}
