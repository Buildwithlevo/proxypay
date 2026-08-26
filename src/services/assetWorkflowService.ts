import { queryRead, queryWrite } from "../config/database";
import { v4 as uuidv4 } from "uuid";
import { AssetIssuanceService } from "../services/stellar/issuanceService";
import logger from "../utils/logger";

export type AssetWorkflowStatus = "draft" | "pending_approval" | "approved" | "rejected" | "issuing" | "completed" | "failed";
export type ApprovalAction = "approve" | "reject" | "request_changes";

export interface AssetIssuanceRequest {
  id: string;
  assetCode: string;
  name: string;
  description?: string;
  limit: string;
  status: AssetWorkflowStatus;
  requestedBy: string;
  approvedBy?: string;
  approvalNotes?: string;
  metadata: Record<string, any>;
  trustlineConfig?: {
    destinationAccount: string;
    limit: string;
    autoSetup: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetConfigurationValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export class AssetIssuanceRequestModel {
  async create(input: {
    assetCode: string;
    name: string;
    description?: string;
    limit: string;
    requestedBy: string;
    trustlineConfig?: { destinationAccount: string; limit: string; autoSetup: boolean };
  }): Promise<AssetIssuanceRequest> {
    const id = uuidv4();

    const existing = await this.findByCode(input.assetCode);
    if (existing) {
      throw new Error(`Asset code ${input.assetCode} already exists`);
    }

    const result = await queryWrite(
      `INSERT INTO asset_issuance_requests (id, asset_code, name, description, limit, status, requested_by, trustline_config, metadata)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8)
       RETURNING *`,
      [
        id,
        input.assetCode,
        input.name,
        input.description || null,
        input.limit,
        input.requestedBy,
        input.trustlineConfig ? JSON.stringify(input.trustlineConfig) : null,
        JSON.stringify({}),
      ],
    );

    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<AssetIssuanceRequest | null> {
    const result = await queryRead("SELECT * FROM asset_issuance_requests WHERE id = $1", [id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByCode(assetCode: string): Promise<AssetIssuanceRequest | null> {
    const result = await queryRead("SELECT * FROM asset_issuance_requests WHERE asset_code = $1", [assetCode]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findAll(status?: AssetWorkflowStatus): Promise<AssetIssuanceRequest[]> {
    let query = "SELECT * FROM asset_issuance_requests";
    if (status) {
      query += ` WHERE status = $1`;
      const result = await queryRead(query, [status]);
      return result.rows.map((r) => this.mapRow(r));
    }
    const result = await queryRead(query);
    return result.rows.map((r) => this.mapRow(r));
  }

  async updateStatus(id: string, status: AssetWorkflowStatus, approvedBy?: string, approvalNotes?: string): Promise<void> {
    await queryWrite(
      `UPDATE asset_issuance_requests SET status = $1, approved_by = $2, approval_notes = $3, updated_at = NOW() WHERE id = $4`,
      [status, approvedBy || null, approvalNotes || null, id],
    );
  }

  async updateTrustlineConfig(id: string, config: { destinationAccount: string; limit: string; autoSetup: boolean }): Promise<void> {
    await queryWrite(
      `UPDATE asset_issuance_requests SET trustline_config = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(config), id],
    );
  }

  private mapRow(row: any): AssetIssuanceRequest {
    return {
      id: row.id,
      assetCode: row.asset_code,
      name: row.name,
      description: row.description,
      limit: row.limit,
      status: row.status,
      requestedBy: row.requested_by,
      approvedBy: row.approved_by,
      approvalNotes: row.approval_notes,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      trustlineConfig: row.trustline_config ? (typeof row.trustline_config === "string" ? JSON.parse(row.trustline_config) : row.trustline_config) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export class AssetWorkflowService {
  private requestModel = new AssetIssuanceRequestModel();
  private issuanceService = new AssetIssuanceService();

  async createRequest(input: {
    assetCode: string;
    name: string;
    description?: string;
    limit: string;
    requestedBy: string;
    trustlineConfig?: { destinationAccount: string; limit: string; autoSetup: boolean };
  }): Promise<AssetIssuanceRequest> {
    const validation = this.validateConfiguration({ assetCode: input.assetCode, name: input.name, limit: input.limit });
    if (!validation.isValid) {
      throw new Error(`Invalid asset configuration: ${validation.errors.join(", ")}`);
    }

    const request = await this.requestModel.create(input);
    logger.info({ requestId: request.id, assetCode: input.assetCode }, "[asset-workflow] Request created");

    return request;
  }

  async approveRequest(id: string, approverId: string, action: ApprovalAction, notes?: string): Promise<AssetIssuanceRequest> {
    const request = await this.requestModel.findById(id);
    if (!request) {
      throw new Error("Asset issuance request not found");
    }

    if (request.status !== "pending_approval") {
      throw new Error(`Cannot ${action} request in status: ${request.status}`);
    }

    if (action === "approve") {
      await this.requestModel.updateStatus(id, "approved", approverId, notes);
      await this.issueAsset(request);
    } else if (action === "reject") {
      await this.requestModel.updateStatus(id, "rejected", approverId, notes);
    } else {
      await this.requestModel.updateStatus(id, "draft", approverId, notes);
    }

    const updated = await this.requestModel.findById(id);
    logger.info({ requestId: id, action, approverId }, "[asset-workflow] Request updated");
    return updated!;
  }

  async submitForApproval(id: string): Promise<AssetIssuanceRequest> {
    const request = await this.requestModel.findById(id);
    if (!request) {
      throw new Error("Asset issuance request not found");
    }

    if (request.status !== "draft") {
      throw new Error(`Cannot submit request in status: ${request.status}`);
    }

    await this.requestModel.updateStatus(id, "pending_approval");
    logger.info({ requestId: id }, "[asset-workflow] Request submitted for approval");
    return (await this.requestModel.findById(id))!;
  }

  async configureTrustline(id: string, config: { destinationAccount: string; limit: string; autoSetup: boolean }): Promise<AssetIssuanceRequest> {
    const request = await this.requestModel.findById(id);
    if (!request) {
      throw new Error("Asset issuance request not found");
    }

    if (!config.autoSetup) {
      await this.requestModel.updateTrustlineConfig(id, config);
      return (await this.requestModel.findById(id))!;
    }

    await this.setupTrustlineAutomatically(request.assetCode, config.destinationAccount, config.limit);
    await this.requestModel.updateTrustlineConfig(id, config);
    const updated = await this.requestModel.findById(id);
    logger.info({ requestId: id, destinationAccount: config.destinationAccount }, "[asset-workflow] Trustline configured");
    return updated!;
  }

  private async issueAsset(request: AssetIssuanceRequest): Promise<void> {
    await this.requestModel.updateStatus(request.id, "issuing");
    try {
      const setupResult = await this.issuanceService.setupAnchoredAsset(request.assetCode, request.limit);
      await this.requestModel.updateStatus(request.id, "completed");
      logger.info({ requestId: request.id, assetCode: request.assetCode }, "[asset-workflow] Asset issued successfully");
    } catch (error) {
      await this.requestModel.updateStatus(request.id, "failed");
      logger.error({ error, requestId: request.id }, "[asset-workflow] Asset issuance failed");
      throw error;
    }
  }

  private async setupTrustlineAutomatically(assetCode: string, destinationAccount: string, limit: string): Promise<void> {
    logger.info({ assetCode, destinationAccount, limit }, "[asset-workflow] Setting up trustline automatically");
  }

  validateConfiguration(config: { assetCode: string; name: string; limit: string }): AssetConfigurationValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.assetCode || config.assetCode.length < 1 || config.assetCode.length > 12) {
      errors.push("Asset code must be between 1 and 12 characters");
    }
    if (!/^[a-zA-Z0-9]+$/.test(config.assetCode)) {
      errors.push("Asset code must be alphanumeric");
    }
    if (!config.name || config.name.trim().length < 1) {
      errors.push("Asset name is required");
    }
    const limitNum = parseFloat(config.limit);
    if (isNaN(limitNum) || limitNum <= 0) {
      errors.push("Limit must be a positive number");
    }
    if (limitNum > 1000000000) {
      warnings.push("Limit is very high, please verify");
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  async getPendingApprovals(): Promise<AssetIssuanceRequest[]> {
    return this.requestModel.findAll("pending_approval");
  }
}

export const assetWorkflowService = new AssetWorkflowService();
