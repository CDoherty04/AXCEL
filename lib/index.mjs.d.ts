export function loadEnvLocal(root?: string): void;

export function rpcUrlFromEnv(): string | undefined;

export function resolveRpcUrl(explicitUrl?: string): string;

export function maskRpcUrl(rpcUrl: string): string;

export function rippled(
  rpcUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>>;

export function assertClassicAddress(account: string): void;

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

export function fetchCreditHistory(options: {
  account: string;
  rpcUrl?: string;
  pageSize?: number;
  maxTransactions?: number;
}): Promise<CreditHistorySnapshot>;

export function formatCreditTransactionRow(tx: CreditTransaction): {
  when: string;
  type: string;
  ledger: number;
  detail: string;
  fee: string;
  hash: string;
};

export function normalizeAccountTxEntry(
  account: string,
  entry: { tx: Record<string, unknown>; meta?: Record<string, unknown>; validated?: boolean },
): CreditTransaction;

export function summarizeCreditHistory(transactions: CreditTransaction[]): CreditHistorySummary;
