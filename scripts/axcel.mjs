#!/usr/bin/env node
/**
 * AXCEL CLI. Named methods instead of curl:
 *
 *   axcel history <address>
 *   axcel score <address>
 *   axcel catalog
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchCreditHistory,
  formatCreditTransactionRow,
  loadEnvLocal,
  maskRpcUrl,
  resolveRpcUrl,
} from "../lib/index.mjs";

loadEnvLocal();

const API = (process.env.AXCEL_API || "http://127.0.0.1:3000") + "/api/v1";
const X402 = process.env.AXCEL_X402 || "http://127.0.0.1:4020";

function usage() {
  console.error(`Usage: axcel <command> [args]

Commands:
  history <address> [--json] [--limit N]   Mainnet credit history (QuickNode)
  score <address>                          Cold-start score from that history
  catalog                                  List API routes
  health                                   API health check
  profile <userId>                         User profile
  credit <userId>                          Credit line state
  borrow --user ID [--amount N]            Draw from the credit line
  repay --user ID [--amount N | --full]    Repay a loan
  agents add --label NAME --limit N [--user ID]
  agents add --user ID --label NAME --mode immediate|autonomous [--max N] [--budget N]
  agents revoke <agentId>
  agents run <agentId> --task TEXT
  buy --agent ID --merchant ID --item TITLE --amount N
  merchants add --name NAME --website URL
  reconcile                                Finish in-flight purchases
  settle-channel [--close]                 Settle the Agent Pay channel
  price <resource>                         Ask an x402 price (npm run x402)
  pay <resource>                           Pay an x402 resource
  settle <claimId>                         Settle an x402 claim
  proof                                    Run the x402 settlement proof
`);
}

function splitFlagArg(raw) {
  const eq = raw.indexOf("=");
  if (eq === -1) return { flag: raw, inlineValue: undefined };
  return { flag: raw.slice(0, eq), inlineValue: raw.slice(eq + 1) };
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const { flag, inlineValue } = splitFlagArg(raw);
    const nextValue = () => {
      if (inlineValue !== undefined && inlineValue !== "") return inlineValue;
      const next = argv[i + 1];
      if (next != null && !next.startsWith("-")) {
        i += 1;
        return next;
      }
      return true;
    };
    if (flag === "--help" || flag === "-h") flags.help = true;
    else if (flag.startsWith("--")) {
      const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = nextValue();
    } else positional.push(raw);
  }
  return { flags, positional };
}

function need(value, name) {
  if (value == null || value === "" || value === true) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function dollarsToCents(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}: ${value}`);
  return Math.round(n * 100);
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function request(base, method, path, body) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const host = base.replace(/^https?:\/\//, "");
    const hint = base.includes(":4020") || base === X402 ? "npm run x402" : "npm run api";
    throw new Error(`failed to connect to ${host}. Start the service with ${hint}`);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { body: text };
  }
  if (!res.ok && res.status !== 402) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  printJson(data);
  return data;
}

function api(method, path, body) {
  return request(API, method, path, body);
}

function x402(method, path, body) {
  return request(X402, method, path, body);
}

async function history(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) {
    console.error("Usage: axcel history <address> [--json] [--limit N] [--page-size N]");
    return;
  }
  const account = need(positional[0], "address");
  const maxTransactions = Number(flags.limit ?? flags.max ?? 500);
  const pageSize = Number(flags.pageSize ?? 100);
  const snapshot = await fetchCreditHistory({
    account,
    rpcUrl: resolveRpcUrl(),
    maxTransactions,
    pageSize,
  });

  if (flags.json) {
    printJson(snapshot);
    return;
  }

  const rpcUrl = resolveRpcUrl();
  console.log(`RPC:     ${maskRpcUrl(rpcUrl)}`);
  console.log(`Network: mainnet`);
  console.log(`Account: ${account}`);
  console.log(
    `Summary: ${snapshot.summary.transactionCount} txs, ${snapshot.summary.paymentCount} payments, ` +
      `${snapshot.summary.uniqueCounterparties} counterparties` +
      (snapshot.partial ? " (partial — increase --limit)" : "") +
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

async function agents(argv) {
  const [sub, ...rest] = argv;
  if (sub === "add") return agentsAdd(rest);
  if (sub === "revoke") {
    const { positional, flags } = parseArgs(rest);
    if (flags.help) {
      console.error("Usage: axcel agents revoke <agentId>");
      return;
    }
    return api("DELETE", `/agents/${encodeURIComponent(need(positional[0], "agentId"))}`);
  }
  if (sub === "run") return agentsRun(rest);
  throw new Error("usage: axcel agents add|revoke|run …");
}

async function agentsAdd(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help) {
    console.error(`Usage:
  axcel agents add --label NAME --limit N [--user ID]
  axcel agents add --user ID --label NAME --mode immediate|autonomous [--max N] [--budget N]`);
    return;
  }
  const label = need(flags.label, "--label");
  if (flags.mode) {
    const userId = need(flags.user, "--user");
    const max = flags.max != null && flags.max !== true ? dollarsToCents(flags.max, "--max") : undefined;
    const budget = flags.budget != null && flags.budget !== true ? dollarsToCents(flags.budget, "--budget") : undefined;
    const fallback = max || budget || 100000;
    return api("POST", `/users/${encodeURIComponent(userId)}/agents`, {
      label,
      mode: flags.mode,
      maxCents: max || fallback,
      budgetCents: budget || fallback,
      merchantIds: [],
      items: [],
    });
  }
  const limitCents = dollarsToCents(need(flags.limit, "--limit"), "--limit");
  const body = { label, limitCents };
  if (flags.user && flags.user !== true) body.userId = flags.user;
  return api("POST", "/agents/simple", body);
}

async function agentsRun(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help) {
    console.error("Usage: axcel agents run <agentId> --task TEXT");
    return;
  }
  const agentId = need(positional[0], "agentId");
  return api("POST", `/agents/${encodeURIComponent(agentId)}/run`, {
    task: String(need(flags.task, "--task")),
  });
}

async function buy(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help) {
    console.error("Usage: axcel buy --agent ID --merchant ID --item TITLE --amount N");
    return;
  }
  const item = String(need(flags.item, "--item"));
  return api("POST", "/payments/agentic/demo", {
    agentId: need(flags.agent, "--agent"),
    merchantId: need(flags.merchant, "--merchant"),
    item: { id: item.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: item },
    amountCents: dollarsToCents(need(flags.amount, "--amount"), "--amount"),
  });
}

async function repay(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help) {
    console.error("Usage: axcel repay --user ID [--amount N | --full]");
    return;
  }
  const body = { userId: need(flags.user, "--user") };
  if (flags.full) body.full = true;
  else if (flags.amount && flags.amount !== true) body.amount = Number(flags.amount);
  return api("POST", "/lending/repay", body);
}

async function borrow(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help) {
    console.error("Usage: axcel borrow --user ID [--amount N]");
    return;
  }
  const body = { userId: need(flags.user, "--user") };
  if (flags.amount && flags.amount !== true) body.amount = Number(flags.amount);
  return api("POST", "/lending/borrow", body);
}

async function merchants(argv) {
  const [sub, ...rest] = argv;
  if (sub !== "add") throw new Error("usage: axcel merchants add --name NAME --website URL");
  const { flags } = parseArgs(rest);
  if (flags.help) {
    console.error("Usage: axcel merchants add --name NAME --website URL");
    return;
  }
  return api("POST", "/merchants", {
    name: need(flags.name, "--name"),
    website: need(flags.website, "--website"),
  });
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }

  switch (cmd) {
    case "history":
      return history(rest);
    case "score": {
      const { positional, flags } = parseArgs(rest);
      if (flags.help) {
        console.error("Usage: axcel score <address>");
        return;
      }
      return api("GET", `/credit-history/${encodeURIComponent(need(positional[0], "address"))}/score`);
    }
    case "catalog":
      return api("GET", "");
    case "health":
      return api("GET", "/health");
    case "profile": {
      const { positional, flags } = parseArgs(rest);
      if (flags.help) {
        console.error("Usage: axcel profile <userId>");
        return;
      }
      return api("GET", `/users/${encodeURIComponent(need(positional[0], "userId"))}/profile`);
    }
    case "credit": {
      const { positional, flags } = parseArgs(rest);
      if (flags.help) {
        console.error("Usage: axcel credit <userId>");
        return;
      }
      return api("GET", `/users/${encodeURIComponent(need(positional[0], "userId"))}/credit`);
    }
    case "borrow":
      return borrow(rest);
    case "repay":
      return repay(rest);
    case "agents":
      return agents(rest);
    case "buy":
      return buy(rest);
    case "merchants":
      return merchants(rest);
    case "reconcile":
      return api("POST", "/payments/reconcile");
    case "settle-channel": {
      const { flags } = parseArgs(rest);
      return api("POST", "/payments/network/settle", flags.close ? { close: true } : {});
    }
    case "price": {
      const { positional, flags } = parseArgs(rest);
      if (flags.help) {
        console.error("Usage: axcel price <resource>");
        return;
      }
      return x402("GET", `/x402/resources/${encodeURIComponent(need(positional[0], "resource"))}`);
    }
    case "pay": {
      const { positional, flags } = parseArgs(rest);
      if (flags.help) {
        console.error("Usage: axcel pay <resource>");
        return;
      }
      return x402("POST", "/x402/agent", { resource: need(positional[0], "resource") });
    }
    case "settle": {
      const { positional, flags } = parseArgs(rest);
      if (flags.help) {
        console.error("Usage: axcel settle <claimId>");
        return;
      }
      return x402("POST", "/x402/settle", { claimId: need(positional[0], "claimId") });
    }
    case "proof":
      return x402("POST", "/x402/proof");
    default:
      throw new Error(`unknown command: ${cmd}\nRun axcel --help`);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
