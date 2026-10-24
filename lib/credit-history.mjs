import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * @property {'mainnet' | 'ethereum'} network
 * @property {string} fetchedAt ISO-8601
 * @property {'quicknode' | 'blockscout'} source
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

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".data", "credit-history");
const MEM_TTL_MS = 60_000;
const DISK_TTL_MS = 30 * 60_000;
/** @type {Map<string, { at: number, snapshot: CreditHistorySnapshot }>} */
const memCache = new Map();
/** @type {Map<string, Promise<CreditHistorySnapshot>>} */
const inflight = new Map();

function historyCacheKey(account, maxTransactions) {
  return `v2:${account.toLowerCase()}:${maxTransactions ?? "all"}`;
}

function diskPath(key) {
  return join(CACHE_DIR, `${encodeURIComponent(key)}.json`);
}

function readDisk(key, maxAgeMs) {
  try {
    const row = JSON.parse(readFileSync(diskPath(key), "utf8"));
    if (!row?.snapshot || typeof row.at !== "number") return null;
    if (Date.now() - row.at > maxAgeMs) return null;
    return row.snapshot;
  } catch {
    return null;
  }
}

function writeDisk(key, snapshot) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(diskPath(key), JSON.stringify({ at: Date.now(), snapshot }));
  } catch {
    // Cache is best-effort; a full disk should not fail the read.
  }
}

function isRateLimited(err) {
  const message = err && err.message ? String(err.message) : "";
  return err?.code === "rate_limited" || err?.status === 429 || /HTTP 429|\b429\b|too many requests|rate.?limit/i.test(message);
}

function rateLimitError(cause) {
  const err = new Error(
    "QuickNode is rate-limiting this address. Showing the last successful read if we have one; otherwise retry in a few seconds.",
  );
  err.code = "rate_limited";
  err.cause = cause;
  return err;
}

/**
 * Pull on-chain activity for initial credit scoring.
 * Classic `r` addresses use QuickNode `account_tx` on QUICKNODE_XRP_RPC_URL.
 * `0x` addresses default to Ethereum mainnet: QuickNode `qn_getTransactionsByAddress` when
 * the Token API add-on is enabled, otherwise the ETH explorer index (about a second).
 * Successful snapshots are cached so a page refresh or the follow-up /score call cannot
 * replace a real history with an empty 429/304 payload.
 * @param {FetchCreditHistoryOptions} options
 * @returns {Promise<CreditHistorySnapshot>}
 */
export async function fetchCreditHistory(options) {
  const { account, maxTransactions } = options;
  assertScoreAddress(account);
  const key = historyCacheKey(account, maxTransactions);

  const pending = inflight.get(key);
  if (pending) return pending;

  const fresh = memCache.get(key);
  if (fresh && Date.now() - fresh.at < MEM_TTL_MS) return fresh.snapshot;

  // After a process restart there is no mem cache; reuse the last successful
  // read instead of hammering QuickNode into a 429 empty response.
  if (!fresh) {
    const disk = readDisk(key, DISK_TTL_MS);
    if (disk) {
      memCache.set(key, { at: Date.now(), snapshot: disk });
      return disk;
    }
  }

  const job = (async () => {
    try {
      const snapshot = await readCreditHistory(options);
      memCache.set(key, { at: Date.now(), snapshot });
      writeDisk(key, snapshot);
      return snapshot;
    } catch (err) {
      const stale = memCache.get(key)?.snapshot ?? readDisk(key, Number.POSITIVE_INFINITY);
      if (stale) return stale;
      throw isRateLimited(err) ? rateLimitError(err) : err;
    }
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, job);
  return job;
}

/**
 * @param {FetchCreditHistoryOptions} options
 * @returns {Promise<CreditHistorySnapshot>}
 */
async function readCreditHistory(options) {
  const {
    account,
    rpcUrl: explicitRpcUrl,
    pageSize = 100,
    maxTransactions,
  } = options;

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
  const timestamp = tx.blockTimestamp || tx.timestamp;
  return {
    hash: tx.transactionHash || tx.hash,
    type: "Payment",
    timestamp: typeof timestamp === "number" ? new Date(timestamp * 1000).toISOString() : timestamp,
    ledgerIndex: Number(tx.blockNumber ?? tx.block_number ?? 0),
    validated: true,
    direction,
    counterparty: direction === "out" ? to : direction === "in" ? (tx.fromAddress || tx.from?.hash || null) : to,
    amount: { kind: "iou", value, currency: "ETH" },
    result: ok ? "tesSUCCESS" : "tecFAILED",
    feeXrp: "0",
  };
}

let nextRpcSlot = 0;
function waitForRpcSlot() {
  const now = Date.now();
  const start = Math.max(now, nextRpcSlot);
  nextRpcSlot = start + 120;
  const delay = start - now;
  return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

function methodUnavailable(message) {
  return /unknownCmd|does not exist|not available|method not found|not supported/i.test(message);
}

async function quickNodeEvmPages(rpcUrl, account, cap) {
  /** @type {CreditTransaction[]} */
  const transactions = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && transactions.length < cap) {
    const perPage = Math.min(100, Number.isFinite(cap) ? cap - transactions.length : 100);
    let last = new Error("qn_getTransactionsByAddress failed");
    let payload = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      await waitForRpcSlot();
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
      if (res.status === 429 || !res.ok) {
        last = new Error(`qn_getTransactionsByAddress HTTP ${res.status}`);
        last.code = res.status === 429 ? "rate_limited" : last.code;
        await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
        continue;
      }
      payload = await res.json();
      const err = payload.error || payload.result?.error;
      if (err) {
        const message = typeof err === "string" ? err : err.message || payload.result?.error_message || JSON.stringify(err);
        if (methodUnavailable(message)) return null;
        if (/rate|limit|timeout|429/i.test(message) && attempt < 5) {
          last = new Error(message);
          last.code = "rate_limited";
          await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
          continue;
        }
        throw new Error(`QuickNode EVM history failed: ${message}`);
      }
      break;
    }
    if (!payload) throw last;
    // A missing result is "addon unavailable", not "this account has 0 transactions".
    if (payload.result == null) return null;
    const result = payload.result;
    const items = result.paginatedItems ?? result.transactions;
    if (!Array.isArray(items)) return null;
    for (const item of items) transactions.push(evmRow(account, item));
    totalPages = Number(result.totalPages ?? page);
    if (!items.length) break;
    page += 1;
  }
  return transactions;
}

const ETH_EXPLORER = "https://eth.blockscout.com/api/v2";
const EVM_DEFAULT_CAP = 100;

/** Ethereum mainnet history from the public explorer index. One HTTP call per 50 txs. */
async function ethExplorerHistory(account, cap) {
  /** @type {CreditTransaction[]} */
  const transactions = [];
  let path = `/addresses/${account}/transactions`;
  while (transactions.length < cap) {
    const res = await fetch(`${ETH_EXPLORER}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`ETH explorer HTTP ${res.status}`);
    const json = await res.json();
    const items = json.items ?? [];
    for (const item of items) {
      transactions.push(evmRow(account, {
        transactionHash: item.hash,
        fromAddress: item.from?.hash,
        toAddress: item.to?.hash,
        value: item.value,
        blockTimestamp: item.timestamp,
        blockNumber: item.block_number,
        status: item.status || item.result,
      }));
      if (transactions.length >= cap) break;
    }
    const next = json.next_page_params;
    if (!items.length || !next) break;
    const params = new URLSearchParams(
      Object.fromEntries(Object.entries(next).map(([key, value]) => [key, String(value)])),
    );
    path = `/addresses/${account}/transactions?${params}`;
  }
  return transactions;
}

async function fetchEvmCreditHistory(account, explicitRpcUrl, maxTransactions) {
  const cap = maxTransactions ?? EVM_DEFAULT_CAP;
  const rpcUrl = explicitRpcUrl ?? ethRpcUrlFromEnv();
  if (!rpcUrl) throw new Error("Missing QUICKNODE_ETH_RPC_URL in .env.local");
  let transactions = null;
  let source = "quicknode";
  try {
    transactions = await quickNodeEvmPages(rpcUrl, account, cap);
  } catch (err) {
    if (isRateLimited(err)) {
      // Token API is optional; the ETH explorer is the fast default when QuickNode has no history add-on.
    } else if (!err.unavailable) {
      throw err;
    }
    transactions = null;
  }
  if (!transactions) {
    transactions = await ethExplorerHistory(account, cap);
    source = "blockscout";
  }
  const partial = Number.isFinite(cap) && transactions.length >= cap;
  return {
    account,
    network: "ethereum",
    fetchedAt: new Date().toISOString(),
    source,
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
