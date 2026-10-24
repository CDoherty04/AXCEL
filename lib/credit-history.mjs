import { resolveRpcUrl } from "./config.mjs";
import { rippled } from "./xrpl-rpc.mjs";

const RIPPLE_EPOCH_UNIX_OFFSET = 946_684_800;

/**
 * @typedef {Object} NormalizedAmount
 * @property {'xrp' | 'iou'} kind
 * @property {string} value
 * @property {string} [currency]
 * @property {string} [issuer]
 */

/**
 * @typedef {Object} CreditTransaction
 * @property {string} hash
 * @property {string} type
 * @property {string} timestamp ISO-8601
 * @property {number} ledgerIndex
 * @property {boolean} validated
 * @property {'in' | 'out' | 'other'} direction
 * @property {string | null} counterparty
 * @property {NormalizedAmount | null} amount
 * @property {string} result
 * @property {string} feeXrp
 */

/**
 * @typedef {Object} CreditHistorySummary
 * @property {number} transactionCount
 * @property {number} paymentCount
 * @property {number} paymentsSent
 * @property {number} paymentsReceived
 * @property {string} totalSentXrp
 * @property {string} totalReceivedXrp
 * @property {number} uniqueCounterparties
 * @property {string | null} firstActivityAt
 * @property {string | null} lastActivityAt
 * @property {number} failedTransactionCount
 */

/**
 * @typedef {Object} CreditHistorySnapshot
 * @property {string} account
 * @property {'mainnet'} network
 * @property {string} fetchedAt ISO-8601
 * @property {'quicknode'} source
 * @property {CreditHistorySummary} summary
 * @property {CreditTransaction[]} transactions
 * @property {boolean} partial
 * @property {{ marker: unknown } | null} pagination
 */

/**
 * @typedef {Object} FetchCreditHistoryOptions
 * @property {string} account
 * @property {string} [rpcUrl]
 * @property {number} [pageSize]
 * @property {number} [maxTransactions]
 */

export function assertClassicAddress(account) {
  if (!account || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account)) {
    throw new Error(`Invalid XRPL classic address: ${account ?? "(missing)"}`);
  }
}

export function rippleDateToIso(rippleSeconds) {
  if (rippleSeconds == null) return null;
  const unixMs = (Number(rippleSeconds) + RIPPLE_EPOCH_UNIX_OFFSET) * 1000;
  return new Date(unixMs).toISOString();
}

export function dropsToXrpDecimal(drops) {
  const n = BigInt(drops);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/** @param {string | { value: string; currency: string; issuer?: string }} raw */
export function normalizeAmount(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    return { kind: "xrp", value: dropsToXrpDecimal(raw) };
  }
  if (typeof raw === "object" && raw.currency != null) {
    return {
      kind: "iou",
      value: String(raw.value),
      currency: raw.currency,
      issuer: raw.issuer,
    };
  }
  return null;
}

/** @param {string} a @param {string} b */
function addDecimal(a, b) {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const aPad = af.padEnd(scale, "0");
  const bPad = bf.padEnd(scale, "0");
  const sum = BigInt(ai + aPad) + BigInt(bi + bPad);
  const s = sum.toString().padStart(scale + 1, "0");
  if (scale === 0) return s;
  const whole = s.slice(0, -scale) || "0";
  const frac = s.slice(-scale).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * @param {string} account
 * @param {{ tx: Record<string, unknown>; meta?: Record<string, unknown>; validated?: boolean }} entry
 * @returns {CreditTransaction}
 */
export function normalizeAccountTxEntry(account, entry) {
  const { tx, meta, validated } = entry;
  const type = String(tx.TransactionType ?? "Unknown");
  const hash = String(tx.hash ?? "");
  const ledgerIndex = Number(tx.ledger_index ?? tx.inLedger ?? 0);
  const timestamp = rippleDateToIso(tx.date) ?? new Date(0).toISOString();
  const result = String(meta?.TransactionResult ?? "unknown");
  const feeXrp = tx.Fee != null ? dropsToXrpDecimal(String(tx.Fee)) : "0";

  let direction = /** @type {'in' | 'out' | 'other'} */ ("other");
  let counterparty = null;
  let amount = null;

  if (type === "Payment") {
    if (tx.Account === account) {
      direction = "out";
      counterparty = tx.Destination ? String(tx.Destination) : null;
    } else if (tx.Destination === account) {
      direction = "in";
      counterparty = tx.Account ? String(tx.Account) : null;
    }
    amount = normalizeAmount(meta?.delivered_amount ?? tx.Amount ?? tx.DeliverMax);
  }

  return {
    hash,
    type,
    timestamp,
    ledgerIndex,
    validated: Boolean(validated),
    direction,
    counterparty,
    amount,
    result,
    feeXrp,
  };
}

/** @param {CreditTransaction[]} transactions */
export function summarizeCreditHistory(transactions) {
  let paymentCount = 0;
  let paymentsSent = 0;
  let paymentsReceived = 0;
  let totalSentXrp = "0";
  let totalReceivedXrp = "0";
  let failedTransactionCount = 0;
  const counterparties = new Set();

  let firstActivityAt = null;
  let lastActivityAt = null;

  for (const tx of transactions) {
    if (tx.result !== "tesSUCCESS") failedTransactionCount += 1;

    if (!firstActivityAt || tx.timestamp < firstActivityAt) firstActivityAt = tx.timestamp;
    if (!lastActivityAt || tx.timestamp > lastActivityAt) lastActivityAt = tx.timestamp;

    if (tx.type !== "Payment") continue;
    paymentCount += 1;
    if (tx.counterparty) counterparties.add(tx.counterparty);

    if (tx.amount?.kind === "xrp") {
      if (tx.direction === "out") {
        paymentsSent += 1;
        totalSentXrp = addDecimal(totalSentXrp, tx.amount.value);
      } else if (tx.direction === "in") {
        paymentsReceived += 1;
        totalReceivedXrp = addDecimal(totalReceivedXrp, tx.amount.value);
      }
    }
  }

  return {
    transactionCount: transactions.length,
    paymentCount,
    paymentsSent,
    paymentsReceived,
    totalSentXrp,
    totalReceivedXrp,
    uniqueCounterparties: counterparties.size,
    firstActivityAt,
    lastActivityAt,
    failedTransactionCount,
  };
}

/**
 * Pull on-chain activity for initial credit scoring (QuickNode / rippled `account_tx`).
 * @param {FetchCreditHistoryOptions} options
 * @returns {Promise<CreditHistorySnapshot>}
 */
export async function fetchCreditHistory(options) {
  const {
    account,
    rpcUrl: explicitRpcUrl,
    pageSize = 100,
    maxTransactions = 500,
  } = options;

  assertClassicAddress(account);
  const rpcUrl = resolveRpcUrl(explicitRpcUrl);

  /** @type {CreditTransaction[]} */
  const transactions = [];
  let marker;
  let partial = false;

  while (transactions.length < maxTransactions) {
    const limit = Math.min(pageSize, maxTransactions - transactions.length);
    /** @type {Record<string, unknown>} */
    const params = {
      account,
      binary: false,
      forward: false,
      limit,
    };
    if (marker) params.marker = marker;

    const result = await rippled(rpcUrl, "account_tx", params);
    const entries = result.transactions ?? [];

    for (const entry of entries) {
      transactions.push(normalizeAccountTxEntry(account, entry));
    }

    marker = result.marker;
    if (!marker || entries.length === 0) break;
    if (transactions.length >= maxTransactions) {
      partial = Boolean(marker);
      break;
    }
  }

  return {
    account,
    network,
    fetchedAt: new Date().toISOString(),
    source: "quicknode",
    summary: summarizeCreditHistory(transactions),
    transactions,
    partial,
    pagination: partial && marker ? { marker } : null,
  };
}

/**
 * Human-readable row for CLI / logs (not the integration contract).
 * @param {CreditTransaction} tx
 */
export function formatCreditTransactionRow(tx) {
  let detail = `account activity`;
  if (tx.type === "Payment") {
    const arrow = tx.direction === "out" ? "sent →" : tx.direction === "in" ? "received ←" : "payment";
    const cp = tx.counterparty ?? "?";
    const amt =
      tx.amount?.kind === "xrp"
        ? `${tx.amount.value} XRP`
        : tx.amount
          ? `${tx.amount.value} ${tx.amount.currency}`
          : "—";
    detail = `${arrow} ${cp}, ${amt}`;
  }
  return {
    when: tx.timestamp,
    type: tx.type,
    ledger: tx.ledgerIndex,
    detail,
    fee: `${tx.feeXrp} XRP`,
    hash: tx.hash,
  };
}
