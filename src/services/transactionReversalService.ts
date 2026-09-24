import { TransactionModel, TransactionStatus } from "../models/transaction";
import { ledgerService, ReversalResult } from "./ledgerService";

export interface TransactionReversalResult {
  transaction: Awaited<ReturnType<TransactionModel["findById"]>>;
  reversal: ReversalResult;
}

export class TransactionReversalService {
  constructor(private readonly transactionModel = new TransactionModel()) {}

  async reverse(
    transactionId: string,
    reason: string,
    actorId?: string,
    options: { allowCompleted?: boolean } = {},
  ): Promise<TransactionReversalResult> {
    const transaction = await this.transactionModel.findById(transactionId);
    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    const allowedStatuses = [
      TransactionStatus.Failed,
      TransactionStatus.Dispute,
      ...(options.allowCompleted ? [TransactionStatus.Completed] : []),
    ];

    if (transaction.status === TransactionStatus.Reversed) {
      return {
        transaction,
        reversal: { alreadyReversed: true, entries: [] },
      };
    }

    if (!allowedStatuses.includes(transaction.status)) {
      throw new Error(
        `Cannot reverse transaction in status: ${transaction.status}`,
      );
    }

    const reversal = await ledgerService.postReversal(
      transaction.id,
      transaction.referenceNumber,
      reason,
      actorId,
    );

    if (transaction.status !== TransactionStatus.Reversed) {
      await this.transactionModel.updateStatus(
        transaction.id,
        TransactionStatus.Reversed,
      );
    }

    const updated = await this.transactionModel.findById(transaction.id);
    return { transaction: updated ?? transaction, reversal };
  }
}

export const transactionReversalService = new TransactionReversalService();