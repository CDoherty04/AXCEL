export type NormalizedAmount = {
  kind: "xrp" | "iou";
  value: string;
  currency?: string;
  issuer?: string;
};

export type CreditTransaction = {
  hash: string;
  type: string;
  timestamp: string;
  ledgerIndex: number;
  validated: boolean;
  direction: "in" | "out" | "other";
  counterparty: string | null;
  amount: NormalizedAmount | null;
  result: string;
  feeXrp: string;
};

export type CreditHistorySummary = {
  transactionCount: number;
  paymentCount: number;
  paymentsSent: number;
  paymentsReceived: number;
  totalSentXrp: string;
  totalReceivedXrp: string;
  uniqueCounterparties: number;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  failedTransactionCount: number;
};

export type CreditHistorySnapshot = {
  account: string;
  network: "mainnet" | "ethereum";
  fetchedAt: string;
  source: "quicknode" | "blockscout";
  summary: CreditHistorySummary;
  transactions: CreditTransaction[];
  partial: boolean;
  pagination: { marker: unknown } | null;
};

export type FetchCreditHistoryOptions = {
  account: string;
  maxTransactions?: number;
  pageSize?: number;
};
