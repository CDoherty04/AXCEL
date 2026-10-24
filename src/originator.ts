import { formatCents } from "./money.js";
import type { LoanSetDraft } from "./types.js";

/** Public Devnet websocket. LendingProtocol and SingleAssetVault are enabled here. */
export const DEVNET_WEBSOCKET = "wss://s.devnet.rippletest.net:51233";

/** Terms that clear XLS-66 precision checks on a decimal IOU. See the lending prep notes. */
export const LOAN_TERMS = {
  interestRate: 500,
  lateInterestRate: 0,
  closeInterestRate: 0,
  overpaymentInterestRate: 0,
  paymentTotal: 12,
  paymentInterval: 2_592_000,
  gracePeriod: 604_800,
  overpaymentFlag: 0x00010000,
} as const;

export type OriginationRequest = {
  loanId: string;
  userId: string;
  agentId: string;
  borrowerAddress: string;
  principalCents: number;
};

export type OriginationReceipt = {
  loanId: string;
  settlement: "local" | "xrpl";
  loanSet: LoanSetDraft;
};

/**
 * Books the draw. The default records a LoanSet locally.
 * Replace it with a submitter that co-signs this draft on Devnet (`DEVNET_WEBSOCKET`).
 */
export interface LoanOriginator {
  originate(request: OriginationRequest): Promise<OriginationReceipt>;
}

export function localOriginator(options?: {
  brokerAddress?: string;
  loanBrokerId?: string;
}): LoanOriginator {
  const brokerAddress = options?.brokerAddress ?? "";
  const loanBrokerId = options?.loanBrokerId ?? "";
  return {
    async originate(request) {
      return {
        loanId: request.loanId,
        settlement: "local",
        loanSet: draftLoanSet(request, brokerAddress, loanBrokerId),
      };
    },
  };
}

export function draftLoanSet(
  request: OriginationRequest,
  brokerAddress: string,
  loanBrokerId: string,
): LoanSetDraft {
  return {
    TransactionType: "LoanSet",
    Account: brokerAddress,
    Counterparty: request.borrowerAddress,
    LoanBrokerID: loanBrokerId,
    Flags: LOAN_TERMS.overpaymentFlag,
    PrincipalRequested: formatCents(request.principalCents),
    InterestRate: LOAN_TERMS.interestRate,
    LateInterestRate: LOAN_TERMS.lateInterestRate,
    CloseInterestRate: LOAN_TERMS.closeInterestRate,
    OverpaymentInterestRate: LOAN_TERMS.overpaymentInterestRate,
    PaymentTotal: LOAN_TERMS.paymentTotal,
    PaymentInterval: LOAN_TERMS.paymentInterval,
    GracePeriod: LOAN_TERMS.gracePeriod,
    LoanOriginationFee: "0",
    LoanServiceFee: "0",
    LatePaymentFee: "0",
    ClosePaymentFee: "0",
    OverpaymentFee: 0,
  };
}
