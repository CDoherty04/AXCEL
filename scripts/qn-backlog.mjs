#!/usr/bin/env node
/**
 * CLI: mainnet on-chain credit history (QuickNode → account_tx).
 *
 *   npm run qn-backlog -- rAccount…
 *   npm run qn-backlog -- rAccount… --json
 *   npm run qn-backlog -- rAccount… --max 200
 */

import {
  fetchCreditHistory,
  formatCreditTransactionRow,
  loadEnvLocal,
  maskRpcUrl,
  resolveRpcUrl,
} from "../lib/index.mjs";

loadEnvLocal();

function usage() {
  console.error(`Usage: npm run qn-backlog -- <xrpl-address> [options]

Options:
  --max N          max transactions to fetch (default 500)
  --page-size N    RPC page size (default 100)
  --json           CreditHistorySnapshot JSON (for credit score / frontend)
`);
}

function parseArgs(argv) {
  let maxTransactions = 500;
  let pageSize = 100;
  let json = false;
  /** @type {string[]} */
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--max") {
      maxTransactions = Number(argv[++i]);
    } else if (arg === "--page-size") {
      pageSize = Number(argv[++i]);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const account = positional[0];
  if (!account) {
    usage();
    process.exit(1);
  }

  return { account, maxTransactions, pageSize, json };
}

async function main() {
  const { account, maxTransactions, pageSize, json } = parseArgs(process.argv.slice(2));
  const rpcUrl = resolveRpcUrl();

  const snapshot = await fetchCreditHistory({
    account,
    rpcUrl,
    maxTransactions,
    pageSize,
  });

  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(`RPC:     ${maskRpcUrl(rpcUrl)}`);
  console.log(`Network: mainnet`);
  console.log(`Account: ${account}`);
  console.log(
    `Summary: ${snapshot.summary.transactionCount} txs, ${snapshot.summary.paymentCount} payments, ` +
      `${snapshot.summary.uniqueCounterparties} counterparties` +
      (snapshot.partial ? " (partial — increase --max)" : "") +
      `\n`,
  );

  for (const tx of snapshot.transactions) {
    const row = formatCreditTransactionRow(tx);
    console.log(
      [
        row.when,
        row.type.padEnd(14),
        `ledger ${row.ledger}`,
        row.detail,
        `fee ${row.fee}`,
        row.hash.slice(0, 16) + "…",
      ].join(" | "),
    );
  }

  console.log(`\n${snapshot.transactions.length} transaction(s) shown.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
