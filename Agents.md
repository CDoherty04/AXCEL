# Agents — QuickNode mainnet credit history (Charlie)

BEC uses on-chain **mainnet** XRPL activity as the seed dataset for an initial credit profile. This repo slice is **mainnet-only** (single QuickNode HTTP endpoint).

## Env

Create `.env.local` (gitignored) from `.env.example`:

- `QUICKNODE_XRP_RPC_URL` — QuickNode XRP **mainnet** HTTP URL

`loadEnvLocal()` in `lib/config.mjs` loads `.env.local` at repo root without overriding existing shell env.

## Library API

Import from `lib/index.mjs` (package `"type": "module"`, export map in `package.json`).

```js
import { loadEnvLocal, fetchCreditHistory } from "./lib/index.mjs";

loadEnvLocal();
const snapshot = await fetchCreditHistory({
  account: "r…", // required classic address
  maxTransactions: 500, // optional cap; sets snapshot.partial if more exist
  pageSize: 100,
  rpcUrl: "…", // optional override
});
```

### `CreditHistorySnapshot` (integration contract)

| Field | Purpose |
| --- | --- |
| `account` | XRPL classic address queried |
| `network` | Always `"mainnet"` |
| `fetchedAt` | ISO timestamp |
| `source` | `"quicknode"` |
| `summary` | Aggregates for scoring (see below) |
| `transactions` | Normalized ledger rows |
| `partial` | `true` if `--max` / `maxTransactions` stopped early |
| `pagination.marker` | Present when `partial`; pass to rippled for next page if you extend fetch |

### `summary` (suggested credit-score inputs)

- `transactionCount`, `paymentCount`, `paymentsSent`, `paymentsReceived`
- `totalSentXrp`, `totalReceivedXrp` (decimal strings, XRP payments only)
- `uniqueCounterparties`
- `firstActivityAt`, `lastActivityAt`
- `failedTransactionCount` (`result !== tesSUCCESS`)

### `transactions[]`

Each row: `hash`, `type`, `timestamp`, `ledgerIndex`, `validated`, `direction` (`in` | `out` | `other`), `counterparty`, `amount` (`{ kind: 'xrp' \| 'iou', value, … }`), `result`, `feeXrp`.

Downstream (Caleb KYA/credit, Anthony frontend): prefer **`fetchCreditHistory`** or CLI **`--json`**, not parsing CLI text.

## CLI

```bash
npm run qn-backlog -- rAddress…
npm run qn-backlog -- rAddress… --json --max 1000
```

Address is **required** (no default).

## REST API (`src/api/`)

```bash
npm run api
curl -s "http://127.0.0.1:3000/api/v1/credit-history/rAddress…?limit=50"
curl -s http://127.0.0.1:3000/api/v1   # route catalog
```

Template layout for other owners:

| File | Owner | Status |
| --- | --- | --- |
| `routes/credit-history.ts` | Charlie | live — same snapshot as CLI |
| `routes/kya.ts` | Caleb | stub |
| `routes/lending.ts` | Will | stub |
| `routes/payments.ts` | Mastercard | stub |

Add handlers in the matching `routes/*.ts` and register in `routes/index.ts`.

## RPC

Uses rippled JSON-RPC `account_tx` via `lib/xrpl-rpc.mjs`. Newest-first pagination via `marker` until `maxTransactions` or history exhausted.

## Wiring into repo credit stack

Will’s lending demo lives in `src/` (TypeScript). Scoring uses `CreditEvent[]` and `computeScore()` in `src/score.ts` (`ChainPaymentEvent`, `RepaymentEvent`, etc. in `src/types.ts`).

This QuickNode module does **not** map ledger rows to `CreditEvent` yet. Intended flow:

1. `fetchCreditHistory({ account })` → `CreditHistorySnapshot`
2. Adapter (Caleb/Charlie): map payments to `chain_payment` events (`at` = ms epoch, merchant ids from counterparty / KYA)
3. Pass events into the existing score + `src/system.ts` origination path

## AP4M agentic payments (`integrations/ap4m/`)

Mastercard hackathon kit: SDK + end-to-end agent script (sign-in → channel → 1 RLUSD pay → settle → close).

```bash
npm install
npm run ap4m-agent
```

| Env (`.env.local`) | Required |
| --- | --- |
| `AGENT_PRIVATE_KEY` | Yes — agent wallet key (never commit) |
| `TEAM_NAME` | Yes — portal registration |
| `AP4M_API_URL` | Optional — defaults to `https://hackathon.ap4m.build` |
| `CHANNEL_ID` | Optional — reuse open channel; omit to open new |
| `CHANNEL_CAP` | Optional — RLUSD cap for new channel (default `5`) |

Portal: register **agent wallet address** (not the private key) on My setup. Agent needs **gas** on the hackathon EVM chain. RPC/ledger come from `GET /public/config` unless you override `AP4M_RPC_URL` / `PAYMENT_LEDGER`.

REST stub: `POST /api/v1/payments/agentic` — wire to SDK or trigger `ap4m-agent` flow later.

## Out of scope here

- Devnet / testnet (mainnet QuickNode only)
- `CreditEvent` adapter and KYA (Caleb)
- Lending execution (`src/system.ts`, Will)
- UI (Anthony)
