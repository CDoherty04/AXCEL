import { ethRpcUrlFromEnv, resolveRpcUrl } from "./config.mjs";
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

const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function assertClassicAddress(account) {
  if (!account || !CLASSIC_ADDRESS.test(account)) {
    throw new Error(`Invalid XRPL classic address: ${account ?? "(missing)"}`);
  }
}

/** Classic `r` address or an XRPL EVM `0x` address. */
export function assertScoreAddress(account) {
  if (CLASSIC_ADDRESS.test(account ?? "") || EVM_ADDRESS.test(account ?? "")) return;
  throw new Error(`Invalid XRPL address: ${account ?? "(missing)"}`);
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
    if (tx.direction === "out") paymentsSent += 1;
    else if (tx.direction === "in") paymentsReceived += 1;

    if (tx.amount?.kind === "xrp") {
      if (tx.direction === "out") totalSentXrp = addDecimal(totalSentXrp, tx.amount.value);
      else if (tx.direction === "in") totalReceivedXrp = addDecimal(totalReceivedXrp, tx.amount.value);
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
 * Pull on-chain activity for initial credit scoring.
 * Classic `r` addresses use QuickNode `account_tx` on QUICKNODE_XRP_RPC_URL.
 * `0x` addresses use QuickNode `qn_getTransactionsByAddress` on QUICKNODE_ETH_RPC_URL.
 * @param {FetchCreditHistoryOptions} options
 * @returns {Promise<CreditHistorySnapshot>}
 */
export async function fetchCreditHistory(options) {
  const {
    account,
    rpcUrl: explicitRpcUrl,
    pageSize = 100,
    maxTransactions,
  } = options;

  assertScoreAddress(account);
  if (EVM_ADDRESS.test(account)) {
    return fetchEvmCreditHistory(account, explicitRpcUrl, maxTransactions);
  }
  const rpcUrl = resolveRpcUrl(explicitRpcUrl);
  const cap = maxTransactions ?? Number.POSITIVE_INFINITY;

  /** @type {CreditTransaction[]} */
  const transactions = [];
  let marker;
  let partial = false;

  while (transactions.length < cap) {
    const room = cap - transactions.length;
    const limit = Math.min(pageSize, Number.isFinite(room) ? room : pageSize);
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
    if (transactions.length >= cap) {
      partial = Boolean(marker);
      break;
    }
  }

  return {
    account,
    network: "mainnet",
    fetchedAt: new Date().toISOString(),
    source: "quicknode",
    summary: summarizeCreditHistory(transactions),
    transactions,
    partial,
    pagination: partial && marker ? { marker } : null,
  };
}

function weiToXrp(wei) {
  const n = BigInt(wei || "0");
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function evmRow(account, tx) {
  const from = (tx.fromAddress || tx.from?.hash || "").toLowerCase();
  const to = tx.toAddress || tx.to?.hash || null;
  const mine = account.toLowerCase();
  const direction = from === mine ? "out" : (to || "").toLowerCase() === mine ? "in" : "other";
  const ok = tx.status === "ok" || tx.status === "success" || tx.result === "success" || tx.status === "1";
  const value = weiToXrp(tx.value ?? "0");
  return {
    hash: tx.transactionHash || tx.hash,
    type: "Payment",
    timestamp: tx.blockTimestamp || tx.timestamp,
    ledgerIndex: Number(tx.blockNumber ?? tx.block_number ?? 0),
    validated: true,
    direction,
    counterparty: direction === "out" ? to : direction === "in" ? (tx.fromAddress || tx.from?.hash || null) : to,
    amount: { kind: "xrp", value },
    result: ok ? "tesSUCCESS" : "tecFAILED",
    feeXrp: "0",
  };
}

async function quickNodeEvmPages(rpcUrl, account, cap) {
  /** @type {CreditTransaction[]} */
  const transactions = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && transactions.length < cap) {
    const perPage = Math.min(100, Number.isFinite(cap) ? cap - transactions.length : 100);
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "qn_getTransactionsByAddress",
        params: [{ address: account, page, perPage }],
      }),
    });
    const payload = await res.json();
    const err = payload.error || payload.result?.error;
    if (err) {
      const message = typeof err === "string" ? err : err.message || payload.result?.error_message || JSON.stringify(err);
      if (/unknownCmd|does not exist|not available|method not found|not supported/i.test(message)) return null;
      throw new Error(`QuickNode EVM history failed: ${message}`);
    }
    const result = payload.result ?? {};
    const items = result.paginatedItems ?? result.transactions ?? [];
    for (const item of items) transactions.push(evmRow(account, item));
    totalPages = Number(result.totalPages ?? page);
    if (!items.length) break;
    page += 1;
  }
  return transactions;
}

async function ethCall(rpcUrl, method, params) {
  let last = new Error(`${method} failed`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429 || !res.ok) {
      last = new Error(`${method} HTTP ${res.status}`);
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      continue;
    }
    const payload = await res.json();
    if (payload.error) {
      const message = payload.error.message || JSON.stringify(payload.error);
      if (/rate|limit|timeout|429/i.test(message) && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
        continue;
      }
      const error = new Error(message);
      error.unavailable = /does not exist|not available|unknownCmd|method not found|not supported/i.test(message);
      throw error;
    }
    if (payload.result == null) {
      last = new Error(`${method} returned no result`);
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      continue;
    }
    return payload.result;
  }
  throw last;
}

/** Sent transactions, found from the account nonce. Works on a standard Ethereum endpoint. */
async function ethSentHistory(rpcUrl, account, cap) {
  const latest = Number(await ethCall(rpcUrl, "eth_blockNumber", []));
  const sent = Number(await ethCall(rpcUrl, "eth_getTransactionCount", [account, "latest"]));
  const want = Math.min(sent, Number.isFinite(cap) ? cap : sent);
  if (want === 0) return [];

  const counts = new Map();
  async function countAt(block) {
    if (counts.has(block)) return counts.get(block);
    const count = Number(await ethCall(rpcUrl, "eth_getTransactionCount", [account, "0x" + block.toString(16)]));
    counts.set(block, count);
    return count;
  }

  async function blockForNonce(nonce) {
    let lo = 0;
    let hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await countAt(mid) >= nonce) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  const blocks = new Set();
  for (let nonce = 1; nonce <= want; nonce++) blocks.add(await blockForNonce(nonce));

  /** @type {CreditTransaction[]} */
  const transactions = [];
  for (const blockNumber of blocks) {
    const block = await ethCall(rpcUrl, "eth_getBlockByNumber", ["0x" + blockNumber.toString(16), true]);
    const timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
    for (const tx of block.transactions ?? []) {
      if ((tx.from || "").toLowerCase() !== account.toLowerCase()) continue;
      transactions.push(evmRow(account, {
        ...tx,
        blockTimestamp: timestamp,
        blockNumber,
        value: tx.value,
        status: "success",
      }));
    }
  }
  transactions.sort((a, b) => b.ledgerIndex - a.ledgerIndex);
  return transactions.slice(0, want);
}

async function fetchEvmCreditHistory(account, explicitRpcUrl, maxTransactions) {
  const cap = maxTransactions ?? Number.POSITIVE_INFINITY;
  const rpcUrl = explicitRpcUrl ?? ethRpcUrlFromEnv();
  if (!rpcUrl) throw new Error("Missing QUICKNODE_ETH_RPC_URL in .env.local");
  let transactions;
  try {
    transactions = await quickNodeEvmPages(rpcUrl, account, cap);
  } catch (err) {
    if (!err.unavailable) throw err;
    transactions = null;
  }
  if (!transactions) transactions = await ethSentHistory(rpcUrl, account, cap);
  const partial = Number.isFinite(cap) && transactions.length >= cap;
  return {
    account,
    network: "xrpl-evm",
    fetchedAt: new Date().toISOString(),
    source: "quicknode",
    summary: summarizeCreditHistory(transactions),
    transactions,
    partial,
    pagination: null,
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
