export type BorrowMode = "automatic" | "limited";

export type TierName = "A" | "B" | "C";

export type RepaymentOutcome = "on_time" | "early" | "late" | "default";

export type DecisionReason =
  | "approved"
  | "credit_limit"
  | "user_limit"
  | "kya_missing"
  | "kya_expired"
  | "defaulted"
  | "score_too_low"
  | "revoked"
  | "limit_required"
  | "zero_amount"
  | "exhausted";

export type Agent = {
  id: string;
  did: string;
  revoked: boolean;
};

export type AgentPurchaseEvent = {
  type: "agent_purchase";
  at: number;
  agentId: string;
  merchantId: string;
  merchantOwnerId: string;
  merchantDid?: string;
  fundingSourceId?: string;
};

export type ChainPaymentEvent = {
  type: "chain_payment";
  at: number;
  merchantId: string;
  merchantOwnerId: string;
  merchantDid?: string;
  fundingSourceId?: string;
};

export type RepaymentEvent = {
  type: "repayment";
  at: number;
  outcome: RepaymentOutcome;
  loanId?: string;
};

export type DisputeEvent = {
  type: "dispute";
  at: number;
  merchantId?: string;
};

export type MandateEvent = {
  type: "mandate";
  at: number;
  agentId: string;
  outcome: "clean_stop" | "refused";
};

export type UtilizationEvent = {
  type: "utilization";
  at: number;
  /** Share of the credit line in use, from 0 to 1. */
  value: number;
};

export type CreditEvent =
  | AgentPurchaseEvent
  | ChainPaymentEvent
  | RepaymentEvent
  | DisputeEvent
  | MandateEvent
  | UtilizationEvent;

export type CreditEventInput =
  | (Omit<AgentPurchaseEvent, "at"> & { at?: number })
  | (Omit<ChainPaymentEvent, "at"> & { at?: number })
  | (Omit<RepaymentEvent, "at"> & { at?: number })
  | (Omit<DisputeEvent, "at"> & { at?: number })
  | (Omit<MandateEvent, "at"> & { at?: number })
  | (Omit<UtilizationEvent, "at"> & { at?: number });

/**
 * LoanSet fields the Devnet lending protocol expects.
 * Fees are zero so the borrower receives the full principal.
 * Flags 65536 (`tfLoanOverpayment`) allows extra principal payments.
 * Early payoff is a later LoanPay with `tfLoanFullPayment`, not this flag.
 */
export type LoanSetDraft = {
  TransactionType: "LoanSet";
  Account: string;
  Counterparty: string;
  LoanBrokerID: string;
  Flags: number;
  PrincipalRequested: string;
  InterestRate: number;
  LateInterestRate: number;
  CloseInterestRate: number;
  OverpaymentInterestRate: number;
  PaymentTotal: number;
  PaymentInterval: number;
  GracePeriod: number;
  LoanOriginationFee: string;
  LoanServiceFee: string;
  LatePaymentFee: string;
  ClosePaymentFee: string;
  OverpaymentFee: number;
};

export type Loan = {
  id: string;
  userId: string;
  agentId: string;
  principalCents: number;
  status: "active" | "repaid" | "defaulted";
  createdAt: number;
  settlement: "local" | "xrpl";
  loanSet: LoanSetDraft;
};

export type UserAccount = {
  id: string;
  did: string;
  ownerId: string;
  fundingSourceId: string;
  /** XRPL account that will co-sign LoanSet. Empty until the wallet exists. */
  address: string;
  createdAt: number;
  /** Unix ms. Null means no KYA-Verified credential. */
  kyaExpiresAt: number | null;
  mode: BorrowMode;
  /** Ceiling on the shared line, in cents. Used only in limited mode. */
  userLimitCents: number | null;
  agents: Agent[];
  events: CreditEvent[];
  loans: Loan[];
};

export type ScoreInputs = {
  pA: number;
  pC: number;
  repaymentRatio: number;
  diversity: number;
  ageWeeks: number;
  disputes: number;
  lates: number;
  utilization: number;
  mandate: number;
};

export type ScoreBreakdown = {
  score: number;
  x: number;
  inputs: ScoreInputs;
  terms: {
    purchases: number;
    repayment: number;
    diversity: number;
    age: number;
    disputes: number;
    lates: number;
    utilization: number;
    mandate: number;
  };
};

export type AgentProfile = {
  agentId: string;
  userId: string;
  mode: BorrowMode;
  /** Provisional formula output. A missing or expired KYA still shows it, but no tier is issued. */
  score: number;
  tier: TierName | null;
  rawTier: TierName | null;
  repaymentCapped: boolean;
  creditLimitCents: number;
  userLimitCents: number | null;
  effectiveLimitCents: number;
  outstandingCents: number;
  availableCents: number;
  denial: DecisionReason | null;
  breakdown: ScoreBreakdown;
};

export type BorrowDecision = {
  outcome: "approved" | "partial" | "denied";
  reason: DecisionReason;
  agentId: string;
  userId: string;
  mode: BorrowMode;
  score: number;
  tier: TierName | null;
  rawTier: TierName | null;
  repaymentCapped: boolean;
  creditLimitCents: number;
  effectiveLimitCents: number;
  outstandingCents: number;
  availableCents: number;
  amountNeededCents: number;
  approvedCents: number;
  breakdown: ScoreBreakdown;
  loan: Loan | null;
};

export type BorrowRequest = {
  agentId: string;
  /** Test dollars the agent wants to draw, such as "180" or "180.50". */
  amountNeeded: string;
  /** Defaults to the user's stored mode. */
  mode?: BorrowMode;
  /** Limited mode only. Overrides the stored ceiling for this call. */
  userLimit?: string;
};
