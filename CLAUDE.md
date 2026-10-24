# Agentic Credit Layer on XRPL + Mastercard Agent Pay

Oct 24, 2026 · @Caleb Hite

## TL;DR

Build the credit layer around the person, not the agent. One score per user starts from their existing ledger history and unlocks an XRPL loan. Their agents spend that loan through Mastercard Agent Pay, and every repayment raises the score for all of that user's agents. Every piece except the score itself is a native XRPL amendment or an existing Mastercard spec, so your custom code is the scoring engine and the glue.

### The flow, end to end

1. **Cold start:** read the user's Mainnet history through QuickNode, plus any Devnet history, and set a starting score.
2. **Borrow:** the score maps to a tier, and the tier sets how much the user can draw from an XLS-66 loan.
3. **Spend:** the loan lands as RLUSD in the user's account, and their agents spend it through Mastercard Agent Pay, each inside its own mandate.
4. **Repay:** the user pays on schedule with LoanPay, or pays it all off early. Each repayment is followed by an atomic credential refresh.
5. **Build:** repayments and every agent's clean purchases raise one user-level score, which every agent inherits.

### The stack in one line each

- **Identity:** an XRPL DID for the user with each agent's account linked to it, plus a KYA-Verified Credential proving a real, KYC'd person stands behind every agent.
- **Proof of good behavior:** Mastercard Verifiable Intent (L1/L2/L3 credential chain) on each purchase, with the hash written into the XRPL payment memo.
- **Settlement:** RLUSD on XRPL, which Mastercard already lists as a rail in Agent Pay for Machines.
- **Score output:** an expiring CreditTier Credential on the user's account, which every linked agent inherits.
- **Credit:** Single Asset Vault + Lending Protocol lend to the user; Permission Delegation lets each agent spend the loan without the user's master key.
- **History and repayment:** QuickNode's Mainnet archive for cold start; LoanPay for installments or early payoff, with Batch keeping the credential swap atomic after each repayment.

> **The one constraint that shapes the build:** native lending is not live on Mainnet. On October 19, 2026 LendingProtocol had 19 of the 29 validator votes it needs and SingleAssetVault had 21, so build and demo on Devnet, where the official lending tutorials already run.

**Your differentiator:** most agent reputation today is self-reported feedback. A 2026 study of ERC-8004 found its reputation records are rarely tied to real interactions and are cheap to manipulate. Your score weights Mastercard-verified agent purchases four times higher than plain on-chain activity, which is the gap to pitch.

---

## Mastercard Agent Pay: what you plug into

Agent Pay is five pieces now, and two of them matter most for a credit layer: Verifiable Intent, which proves what the human authorized, and Agent Pay for Machines, which already names XRPL and RLUSD as a settlement rail.

| Piece | What it does | Why it matters to you | Date |
| --- | --- | --- | --- |
| Agent Pay for Machines | Machine-to-machine payments across cards, banks and stablecoins, including sub-cent payments; 30+ partners including RippleX and t54 Labs | Ripple contributes XRPL and RLUSD as settlement rails, so your on-ledger events are a native part of the Mastercard flow | Jun 10, 2026 |
| Verifiable Intent | Linked SD-JWT credentials: L1 identity (Mastercard), L2 authorization (user's mandate and constraints), L3 execution (agent's final order) | The cryptographic proof each scored purchase must carry; open source at github.com/agent-intent/verifiable-intent | Mar 5, 2026 (v0.1) |
| XRPL x402 + Verifiable Intent | t54's XRPL x402 Facilitator accepts VI credentials and screens them through its risk service before settlement | Ready-made path to get VI-backed RLUSD payments onto XRPL | Jul 24, 2026 |
| Agentic Tokens | MDES network tokens bound to one agent, a merchant scope, a consent policy and a spending limit | The spend limit is the lever your credit tier can raise | Apr 29, 2025 |
| Acceptance Framework / Know Your Agent | Registers and verifies agents before they can transact; standard data elements for merchants | Your agent must be a registered agent for its purchases to count | 2025 |

### Purchasing modes

Two purchasing modes, both in the developer docs, and both earn the same credit.

- **Immediate mode:** the human approves a specific purchase (L1 + L2).
- **Autonomous mode:** the human signs constraints in L2 and the agent signs its own L3 credentials, one for the payment network and one for the merchant.

Either way the purchase carries a Verifiable Intent chain, and that chain is what earns full credit; the mode only changes who approved the order. Mastercard's tutorials page has a sandbox onboarding guide and a walkthrough for each mode.

### Real versus simulated

Sandbox access needs a Mastercard Developers project and approval, which may not arrive inside a hackathon weekend. Plan to generate real VI credential chains with the open-source reference code, and treat the network authorization result as a mocked response unless sandbox access comes through.

### Useful tooling

The Mastercard Developers Agent Toolkit ships an MCP server (`npx -y @mastercard/developers-mcp`) that lets your coding agent look up Mastercard APIs while you build.

---

## XRPL building blocks

Twelve native features cover identity, proof, access control, credit and repayment, so you write no smart contracts. Ten are live on Mainnet today; the two lending amendments run on Devnet only.

| Feature (XLS) | Mainnet status, Oct 24 2026 | Role in the credit layer |
| --- | --- | --- |
| DID (XLS-40) | Live since Oct 30, 2024 (record) | `did:xrpl:` identifier for the agent and its owner; the DID document points to the agent's Mastercard registration and public key |
| Credentials (XLS-70) | Live since Sep 2025 (report) | Two credentials on the user's account: KYA-Verified (owner is a real, KYC'd person) and CreditTier-A/B/C (your score), each with an expiration so tiers must be re-earned |
| Permissioned Domains (XLS-80) | Live since Feb 4, 2026 (report) | One domain per credit tier, meaning "this tier or better" (A: A only; B: A or B; C: any tier); accounts holding an accepted credential are members automatically, no join step |
| Deposit Authorization + credential-based DepositPreauth | Live (extended by Credentials) | Lender and merchant accounts accept funds only from credentialed agents |
| Multi-Purpose Tokens (XLS-33) | Live since about Oct 1, 2025 (report) | Vault shares are MPTs; you can also issue a non-transferable "credit points" MPT as a visible, soulbound-style score |
| Permission Delegation V1.1 (XLS-75) | Live since Oct 8, 2026 | Owner account delegates only Payment rights to the agent's key, so the agent never holds the master key; up to 10 permissions per delegate |
| Batch V1.1 (XLS-56) | Live since Oct 9, 2026 | Up to 8 transactions all-or-nothing. Used to swap the tier credential atomically (delete, create, accept). **LoanPay cannot be an inner transaction on current Devnet** (`temINVALID_INNER_BATCH`), so repayment is a LoanPay followed by the Batch |
| Token Escrow (XLS-85) | Live since early 2026 (report) | Escrow RLUSD, not just XRP: hold-back on large agent purchases, or pay-later released on a date |
| Price Oracle (XLS-47) | Live since Nov 2, 2024 | Price XRP or other collateral in USD when an agent posts partial collateral |
| Checks, Payment Channels | Live | Checks for pull-style repayment; channels for streaming sub-cent repayments from agent revenue |
| Single Asset Vault (XLS-65) | Voting: 21 of 29 votes on Oct 19 (crypto.news); live on Devnet | The lending pool: lenders deposit RLUSD and get MPT shares; a private vault can require a Permissioned Domain. **A loan broker needs a closed-ended vault** (`VaultKind: 1` with `SubscriptionDate` and `RedemptionDate`, at least 180 s apart); lending starts after the subscription date |
| Lending Protocol (XLS-66 + V1.1) | Voting: 19 of 29 votes on Oct 19; live on Devnet | LoanBrokerSet, LoanSet (co-signed by broker and borrower), LoanPay, default handling and first-loss cover. Underwriting is off-chain by design, which is exactly where your score plugs in. Single-signature `LoanSet`: broker is `Account`, borrower is `Counterparty`, submit the blob from `signLoanSetByCounterparty` |

**Worth knowing but optional:**

- Confidential Transfers for MPTs (22 votes, per this report) could later hide individual credit balances.
- Sponsorship (XLS-68) shipped in server 3.3.0 and would let your service pay reserves for new agent accounts; check its vote status before relying on it.
- Smart Escrows (XLS-100) are still in development.

> **Safety note:** XRPL docs warn against delegating the `PaymentBurn` permission until the `fixCleanup3_4_0` amendment is active (it was projected for Oct 23). Delegate plain `Payment` only.

---

## Architecture

It's one loop in five steps. History sets a starting score, the score sets a credit line, the user's agents spend it through Mastercard, and repayments raise the score. The higher score then lifts the limit for every agent.

The score and the loan belong to the user. A new agent starts with the user's tier on day one, and a misbehaving agent costs the user, not just itself.

### How Mastercard and XRPL connect, step by step

1. **Cold start.** The user proves control of their Mainnet account by signing a challenge. The service reads its history through QuickNode's archive endpoint (`account_tx`), plus any Devnet history from the public endpoint, and computes a starting score.
2. **Tier.** The service issues a CreditTier credential to the user's account with `CredentialCreate`, and the user accepts it. Holding the credential places the user in the matching Permissioned Domain.
3. **Borrow.** The private vault lends only to that domain. The loan broker and the user co-sign a `LoanSet` sized to the tier's limit, and RLUSD lands in the user's account.
4. **Link agents.** Each agent gets its own key account, listed under the user's DID, plus a **spending account** (pot). The pot holds an `AGENT_PAYER` credential and a `DelegateSet` granting the agent only Payment on the pot, never on the user's main account. Delegation limits which actions an agent can take, not how much it spends, so the pot is funded just in time and holds about nothing between purchases. Per-agent caps come from each agent's L2 mandate and Agentic Token limit.
5. **Spend.** An agent builds an L3 order inside its mandate and pays through Agent Pay. The service moves exactly the purchase amount from the user's account into the agent's pot, and the agent's delegated RLUSD Payment from the pot settles it, with `sha256(VI chain)` and the agent's DID in Memos. The service checks that total spend across all agents stays under the credit line.
6. **Repay.** The user pays installments with `LoanPay` or pays the balance off early; create the loan with overpayment allowed so early payoff works. Each repayment is followed by a Batch that atomically swaps the tier credential (LoanPay itself cannot be batched on current Devnet).
7. **Rescore.** Repayments and every agent's verified purchases update the single user score. When the tier rises, the next loan's limit rises for all agents.

### Card rail

Card-rail spending is the production path. In the demo, borrowed RLUSD settles on XRPL directly. In production, a stablecoin card issuer in the Agent Pay for Machines network (Rain is a listed partner) could issue each agent an Agentic Token backed by the user's RLUSD balance. The scoring service would then anchor each card purchase on-ledger with a small memo-carrying payment, so all history stays in one place.

---

## Credit score design

Score the user, not each agent. Every agent linked to the user's DID feeds one score, and that score decides how much the user can borrow. An agent purchase earns the same credit whether the human approved the order (Immediate mode) or the agent bought on its own (Autonomous mode). Either kind earns four times the credit of a regular on-chain payment.

Agent purchases are worth more because they are verified three ways: a valid Verifiable Intent chain, a purchase inside the L2 constraints, and settlement on XRPL. A regular payment proves only that money moved, and could be a transfer between the user's own wallets.

| Signal | Where it comes from | Weight and direction |
| --- | --- | --- |
| Verified agent purchases (all agents) | VI chain (Immediate: L1 + L2; Autonomous: L1 + L2 + L3) plus a settled Payment with the VI hash in Memos | Full weight (1.0) per purchase, identical in either mode; diminishing returns per merchant |
| Regular on-chain payments | The user's XRPL payments with no VI chain: cold-start history from QuickNode's Mainnet archive, plus ongoing activity | Reduced weight (λ = 0.25 of an agent purchase) |
| Repayment record | LoanPay on time, early payoff, late, or default | Strongest factor once a loan exists; early payoff counts as on time |
| Mandate adherence (all agents) | Purchases that hit an L2 limit and stopped vs. ones refused for exceeding it, in either mode | Up for clean stops, down for refused attempts |
| Credit utilization | Borrowed balance in use vs. the credit line, across all agents | Down when it sits near the limit for long stretches |
| Merchant diversity | Count of distinct merchant accounts paid | Up; blocks one-merchant wash loops |
| Disputes and chargebacks | Mastercard dispute outcome (mocked in the demo) or merchant refund flag | Down, sharply |
| Owner verification | KYA-Verified credential present and unexpired | Required to score at all |

### Formula

A simple, explainable formula judges can follow:

$$
S = 300 + 550 \cdot \sigma\big(b + w_1 \log(1 + P_A + \lambda P_C) + w_2 R + w_3 D + w_4 A - w_5 C - w_6 L - w_7 U + w_8 M\big), \quad \lambda = 0.25
$$

| Term | Meaning |
| --- | --- |
| $P_A$ | Verified agent purchases across all of the user's agents, counted the same in Immediate and Autonomous mode |
| $P_C$ | Regular on-chain payments with no Verifiable Intent chain, including the cold-start history |
| $\lambda$ | Makes each regular payment worth a quarter of an agent purchase, so a new user starts with some credit, and agent activity quickly outweighs it |
| $R$ | On-time repayment ratio |
| $D$ | Merchant diversity |
| $A$ | Account age in weeks |
| $C$ | Dispute count |
| $L$ | Late or defaulted payments |
| $U$ | Average utilization: purchases not yet matched by principal repayment, over the credit line |
| $M$ | Mandate adherence: clean stops minus twice the refused attempts, scaled to -1..1 |
| $b$, $w_i$ | Bias -2.0; weights 0.9 (volume), 1.5 (repayment), 0.8 (diversity), 0.5 (age), 1.2 (disputes), 1.5 (late), 0.8 (utilization), 0.4 (mandate). All in `src/config.ts` |

All events decay with a 90-day half-life, and the sigmoid keeps S on a familiar 300 to 850 range.

### Tiers

Map S to tiers and each tier to a borrowing limit that covers all of the user's agents together:

| Tier | Score | Credit line (example, test dollars) |
| --- | --- | --- |
| A | 700 and up | 1,000 |
| B | 580 to 699 | 250 |
| C | Below 580 | 50 |

Issue the tier, not the raw number, as the on-ledger credential.

### Anti-gaming rules to build in

- Ignore payments where the merchant shares an owner, DID controller or funding source with the user; that is the classic self-dealing loop.
- Cap how much any single merchant can add, and decay old events (for example a 90-day half-life).
- Require the KYA-Verified credential, so one person cannot spread activity over many fresh identities; ERC-8004 research found reputation there can be manipulated at minimal cost without this kind of grounding.
- Cap the tier by repayment: a user with no repayment history cannot exceed tier B, however much cold-start history or purchase volume they have.
- One bad agent hurts the shared score, so let the user revoke an agent's delegation instantly; the score keeps that agent's history.
- Give credentials a short expiration (30 days), so a stolen or sold identity loses its tier quickly.

### Privacy

Keep raw purchase data off-ledger. Write only the VI hash in the payment memo and the tier in the credential. The full chain lives with your scoring service and can be shown selectively, which SD-JWT already supports.

---

## Use cases once the score exists

The core product is one credit line per user that all of their agents draw on. XLS-66 was designed for off-chain underwriting, and your score is that underwriting. The other rows show the score is reusable beyond lending.

| Use case | How it works on XRPL + Mastercard | Who benefits | Demo effort |
| --- | --- | --- | --- |
| Shared credit line for all of a user's agents | Private vault requires the tier-A domain; broker co-signs LoanSet with the user; RLUSD lands in the user's account and is spent through Agent Pay | Users running several agents; vault depositors earn interest | Medium (Devnet tutorials exist) |
| Dynamic spend limits | Tier upgrade prompts the owner to sign a wider L2 mandate, raising the Agentic Token's spending limit | Owners get fewer approval prompts; merchants see larger baskets | Low |
| Pay-later for agents (net-30) | Merchant ships now; Token Escrow or a Check holds the agent's RLUSD obligation until the due date | B2B procurement agents, SaaS and API vendors | Low to medium |
| Postpaid x402 / API access | API providers let tier A/B agents pay in arrears instead of per call, settled in one batch | High-frequency agents paying sub-cent fees | Low |
| Merchant risk tiers | Merchant DepositPreauth accepts credentialed agents only; tier A skips step-up checks on big orders | Merchants cut fraud and friction | Low |
| Agent-to-agent hiring | An agent checks a counterparty's tier credential before paying it or extending it terms | Agent marketplaces | Low |
| Default insurance and first-loss cover | Loan broker's first-loss capital and an insurer price premiums by tier; similar to the Ward Protocol idea built on XLS-66 | Vault depositors | High |
| Securitized agent receivables | Bundle tier-A loans and issue MPT tranches to investors | Institutional lenders | High, pitch only |

### Prior art to position against

t54 Labs, an Agent Pay for Machines partner, runs ClawCredit, which underwrites agent credit lines from its Trustline risk engine. Several ERC-8004 projects (for example Fera Protocol) do reputation-based micro-loans on EVM chains. Your angle: the score is built from Mastercard-verified intent plus XRPL settlement, and the loan itself is a native ledger object rather than a custom contract.

---

## Hackathon build plan

Run cold start on Mainnet through QuickNode and everything after it on Devnet. The loan funds the agents' spending, so borrowing, spending and repaying must all happen on the network where lending is live. QuickNode has no Devnet endpoint, so the Devnet steps use the public server (`wss://s.devnet.rippletest.net:51233`). Use real Verifiable Intent credentials from the open-source reference code, and mock only the Mastercard network response.

| Step | Component | Network | Build or reuse | Tooling |
| --- | --- | --- | --- | --- |
| 1 Cold start | History reader | Mainnet (+ Devnet) | Build (small) | QuickNode archive `account_tx` on accounts the user proves they own; public Devnet endpoint for any Devnet history (Devnet resets periodically, so expect little) |
| 1 Cold start | Score calibration | Mainnet | Build (small) | QuickNode Streams backfill of real agentic payments (t54's x402 facilitator passed 1.4M by July 2026) to sanity-check weights |
| 2 Borrow | Tier credential and domain | Devnet | Reuse | `CredentialCreate` / `CredentialAccept` on the user's account, `PermissionedDomainSet` |
| 2 Borrow | Vault, broker and loans | Devnet | Reuse | Official tutorials: create a loan broker, create a loan. Vault asset is a test dollar token you issue on Devnet, standing in for RLUSD; allow overpayment so early payoff works |
| 3 Spend | Agent accounts and delegation | Devnet | Reuse | One account per agent, linked in the user's DID document; `DelegateSet` granting Payment only |
| 3 Spend | Agent wallet and payments | Devnet | Reuse | XRPL AI Starter Kit: Docs MCP server plus Agent Wallet and Payment skills for Claude; xrpl.js or xrpl-py |
| 3 Spend | VI credential chain (L1, L2, L3) | Off-ledger | Reuse, run locally | agent-intent/verifiable-intent reference implementation, one L2 mandate per agent |
| 3 Spend | Mastercard authorization result | Off-ledger | Mock, or sandbox if approved | Mastercard Agent Pay sandbox tutorial |
| 4 Repay | Repayment | Devnet | Reuse | `LoanPay` for installments or full payoff, then a Batch that swaps the tier credential (LoanPay is rejected as an inner Batch transaction on current Devnet) |
| 5 Build | Live event feed | Devnet | Build (small) | xrpl.js `subscribe` on the user's account for purchases and repayments; QuickNode Streams can take over if you later move to Testnet or Mainnet |
| 5 Build | Scoring engine | Off-ledger | Build (your core) | Node or Python service: formula, anti-gaming rules, and a check that total spend across all agents stays under the credit line |
| All | Dashboard | Off-ledger | Build | User profile: score, tier, credit used vs. limit, spend per agent, repayment schedule, with the network labeled on every panel |

### Demo script (about 4 minutes)

1. **Cold start:** the user signs a challenge proving they own a Mainnet account. QuickNode pulls its history, and the dashboard shows a starting score of, say, 610 (tier B).
2. **Borrow:** the service issues a CreditTier-B credential on Devnet. The user joins the tier-B domain and draws a 250-token credit line with `LoanSet`.
3. **Link agents:** the user adds a shopping agent and an API-buying agent, each with a Payment-only delegation and its own L2 mandate.
4. **Spend:** both agents buy through the Agent Pay flow, one in Immediate mode (the user approves each order) and one in Autonomous mode. Both add the same credit per purchase, and the dashboard shows each one is worth four plain Mainnet payments. Each purchase settles from the user's account with the VI hash in the memo, and the "credit used" bar fills.
5. **Guardrail:** one agent tries an out-of-mandate purchase; it's refused, and the score shows a clean stop.
6. **Repay:** the user pays one installment live, then pays off the rest early. Each payment is followed by an atomic credential refresh (Batch).
7. **Shared credit:** the score crosses 700 and the tier becomes A. A third agent linked afterward gets the tier-A limit on its first purchase.

---

## Risks and fallbacks

- **Lending not on Mainnet:** say so up front; Devnet is the honest and expected place for XLS-66 demos. An April 2026 hackathon team had to run a local node because the amendments were not on Devnet then; confirm Devnet support on day one.
- **Two networks in one demo:** keep both endpoints in one config file and label the network on each dashboard panel. Judges should see that history comes from Mainnet while credit runs on Devnet.
- **Delegation has no spend limit:** it controls which transactions an agent may send, not amounts. Enforce per-agent caps in each L2 mandate and total spend in your service, and make revoking a delegation one click.
- **Scoring someone else's wallet:** cold start reads public history, so only score accounts the user proves they control with a signed challenge.
- **No Mastercard sandbox access:** keep the authorization result behind one interface so you can swap the mock for the real API later.
- **Verifiable Intent is v0.1:** pin the reference implementation version you build against.
- **Score feels arbitrary:** show the formula and a per-event breakdown on the dashboard; judges trust what they can trace.

---

## Build status (code in this repo)

TypeScript service in `src/`, Python bridge to the pinned VI reference in `vi_bridge/` (reference cloned to `vendor/verifiable-intent` at commit `356c296`, v0.1). Everything below runs on Devnet. `npm run bootstrap` creates the lending infrastructure once (about 200 s because of the vault subscription window), `npm run demo` runs the full demo script, `npm test` runs the unit tests, `npm run api` starts the API. Python setup: `python -m venv .venv` then `.venv/Scripts/python -m pip install cryptography`.

| Area | File | What it does |
| --- | --- | --- |
| Config | `src/config.ts` | Both network endpoints, tier table, score weights, credential types and TTLs, loan terms |
| Ledger | `src/xrpl/client.ts` | Connect, faucet funding, submit and validate, created-object lookup |
| Ownership proof | `src/identity/challenge.ts` | Challenge binds the Mainnet and Devnet addresses; both keys sign; verified with `ripple-keypairs` |
| DID | `src/identity/did.ts` | `DIDSet` carries a URI and the sha256 of the DID document (ledger fields cap at 256 bytes); the resolver checks the hash. The user DID lists active agents; each agent DID names the user as controller |
| KYA | `src/identity/kya.ts` | KYC provider interface (mocked), `KYA_VERIFIED` credential with 365-day expiry, live credential status reads |
| Know Your Agent | `src/mastercard/agentPay.ts`, `ap4m.ts` | `AgentRegistry` and `NetworkAuthorizer` interfaces. Mocks by default; `MASTERCARD_MODE=ap4m` selects the real Agent Pay for Machines adapter (see below) |
| Verifiable Intent | `vi_bridge/bridge.py`, `src/vi/bridge.ts` | Real L1/L2/L3 issuance and network-side verification (STRICT constraints); the memo hash is sha256 over L1, L2 and L3a |
| Scoring | `src/scoring/engine.ts` | The formula, per-merchant diminishing returns and cap, 90-day decay, repayment tier cap, default cap, per-event breakdown |
| History | `src/scoring/history.ts`, `quicknodeHistory.ts` | QuickNode reader built on the teammate's `lib/` (`QUICKNODE_XRP_RPC_URL`), a websocket `account_tx` fallback, and a static reader for demos |
| Anti-gaming | `src/scoring/antiGaming.ts` | Excludes merchants that are the user's own accounts, share a funding source, or have a DID controlled by the user |
| Lending | `src/credit/infra.ts`, `loans.ts` | Test-dollar issuer, three tier domains, private closed-ended vault, loan broker with first-loss cover, `LoanSet`, `LoanPay`, atomic credential refresh |
| Credentials | `src/credit/tierCredential.ts` | Tier credential swap (30-day expiry) |
| Delegation | `src/credit/delegation.ts`, `pots.ts` | `DelegateSet` with `Payment` only, on a per-agent spending account; revoke with an empty permission list; payer credential and merchant `DepositPreauth` |
| Orchestration | `src/service.ts` | Users, linking, KYA, cold start, tier sync, borrow, agents, purchase settlement, repayment, late sweep, dashboard profile |
| Feed | `src/feed.ts` | Account subscription; folds in plain payments, ignores VI-memo payments with no settled chain |
| API | `src/api/server.ts`, `src/api/routes/*` | REST on the shared router over the service (demo custody, no auth) |

### Verified on Devnet (scripts/demo.ts)

Cold start scores 614 (tier B), a 250 loan is drawn, an Immediate and an Autonomous agent buy through delegated Payments with the VI hash in Memos (score rises 614 to 660), an over-cap purchase is refused by the VI verifier, an installment plus credential refresh lifts the score to 785 (tier A), early payoff succeeds, a 1,000 loan is drawn at the new limit and a third agent buys on its first purchase.

### Behaviour worth knowing

- **Purchases score only after settlement.** The amount and payee come from the validated chain, not from the request. The service verifies the chain, enforces the agent budget and the credit line, calls the network authorizer, submits the delegated Payment signed by the agent, and records the purchase after validation. A chain hash can be settled once.
- **Refused attempts are scored.** A chain that fails validation (for example an amount over the L2 cap) records a `refused` mandate event. A purchase that brings an agent to 95% of its budget records a `clean_stop`.
- **Utilization** is purchases not yet matched by principal repaid, over the credit line, not the drawn loan balance; a user who borrows the whole line and leaves it idle is not penalized.
- **Credit check:** spend outstanding plus the purchase must stay under the held tier's credit line, and the user's token balance must cover it.
- **Credential refresh after repayment:** LoanPay, then a Batch that deletes the old tier credential, creates the new one and accepts it. If the Batch fails, the repayment is already recorded and `syncTier` reconciles.
- **Early payoff** uses `tfLoanFullPayment` with the current `TotalValueOutstanding`; the user needs funds beyond the borrowed balance they have left (the demo tops up from the issuer).
- **Closed-ended vault:** the redemption date is 180 days after creation, so a long-lived deployment needs a new vault after that.

### Hardening: spending accounts, settlement state machine, live guard

- **Spending accounts (`src/credit/pots.ts`).** A delegate on the user's main account can reach everything in it. Each agent therefore pays from its own pot: funded just in time with exactly the purchase amount, delegated Payment-only to the agent key, and holding an `AGENT_PAYER` credential. Merchants set `DepositAuth` plus a credential-based `DepositPreauth`, so they accept funds only from credential holders. Verified on Devnet: no credential gives `tecNO_PERMISSION`, a deleted credential gives `tecBAD_CREDENTIALS`. **Limit of this defense:** it protects merchants and gives revocation a second lever; it does not stop a thief sending the pot's contents to an arbitrary address, so the real bound is the pot balance (about 0 between purchases) plus the guard below.
- **Revocation** removes the pot delegation, deletes the payer credential, sweeps the pot back to the user, drops the Mastercard registration and marks any in-flight purchase of that agent stranded.
- **Settlement state machine (`src/service.ts`).** A purchase is a write-ahead record: `validated -> authorized -> funded -> paid`, saved before each step. The network is asked once per chain hash (a retry resumes and never redeems a second voucher; the AP4M authorizer is idempotent per hash and re-reports an unrecorded redemption without redeeming again). Payment checks the pot's recent history for the chain hash first and refuses to pay when the pot is short, so a lost response never causes a double payment. Failures after authorization return `202 pending`; `reconcile()` (every 60 s in the server, or `POST /api/v1/payments/reconcile`) finishes them; after 5 failed attempts a purchase is `stranded` for review. Only a paid purchase scores. Settlement is serialized per agent.
- **Live guard (`src/feed.ts`, `src/settlement.ts`).** The feed watches every spending account. A delegated payment out of a pot must match an approved purchase (same chain hash, destination and amount); anything else revokes the agent immediately and records an alert.
- **Borrow on demand (opt-in).** `autoBorrowChunk` in the service dependencies draws `max(shortfall, chunk)` when the user balance is short, instead of the whole line up front.
- **API.** The credit-layer service now sits behind the shared router (`src/api/routes/`, `npm run api`, paths under `/api/v1`); the Express server is gone. Routes answer 503 until the Devnet bootstrap finishes. `scripts/resilience.ts` is the live check for the guard and for crash recovery.

### Known gaps

- Authorization idempotency is in memory: a process restart between "redeemed" and "recorded" can re-redeem. Persisting the redemption would close it.
- Keys are custodied by the service for the demo. Production needs client-side signing and user authentication on the API.
- The self-dealing resolver reads funding sources from the ledger it is wired to (Devnet); Mainnet merchants are only checked against the user's own accounts unless a Mainnet resolver is added.
- Loan default handling (`LoanManage`) and the Mastercard dispute feed are not built; disputes can be added as `dispute` score events.
- The Mastercard network authorization result and KYC are mocked behind interfaces.
- The dashboard UI is not built; `GET /users/:id/profile` returns everything it needs, with the network labeled.

### Agent Pay for Machines integration (live service, needs gas to spend)

The AP4M hackathon service (`https://hackathon.ap4m.build`, SDK in `integrations/ap4m/`) runs on **XRPL EVM Testnet** (chain 1449000), not native XRPL Devnet. A team signs in with its agent wallet (EIP-191 challenge), opens a payment **channel** with an RLUSD cap (within its allocation), signs EIP-712 **cumulative vouchers**, redeems them on the `PaymentLedger` contract, reports the redemption, and **settles** (RLUSD released to the merchant payout wallet, with a receipt). `src/mastercard/ap4m.ts` wraps that SDK behind the `AgentRegistry` and `NetworkAuthorizer` interfaces; `MASTERCARD_MODE=ap4m` selects it, and it throws if `TEAM_NAME` or `AGENT_PRIVATE_KEY` is missing rather than falling back to the mock.

How the two ledgers fit together:

- **Channel cap = the agent spending limit the tier raises** (the Agentic Token analogue). One channel serves all of a user's agents, like the single credit line. Vouchers are cumulative, so the cap bounds total network spend.
- **Authorization = redeeming a voucher** for the purchase amount, serialized so cumulative amounts never collide. A purchase that would pass the cap is declined before anything is redeemed.
- **The native XRPL Devnet Payment still carries the Verifiable Intent hash** and is what the score reads; the AP4M claim id is added to its Memos (`ap4m/claim`), linking both legs.
- **Amounts are scaled** by `AP4M_AMOUNT_SCALE` (default 0.01): the demo borrows test dollars in the hundreds while a team's allocation is 20 RLUSD, so a 35-dollar purchase redeems 0.35 RLUSD.
- **Funding gap:** the loan is in Devnet test dollars and the channel is funded from the team's RLUSD allocation. Bridging borrowed RLUSD to the EVM side is out of scope here; in production the borrowed RLUSD itself would fund the channel.
- `settleNetwork({ close })` on the service settles and closes the channel.
- `npx tsx scripts/ap4m-check.ts` is a read-only readiness check (sign-in, allocation, payout wallet, gas).

Status: sign-in, service config, allocation (20 RLUSD, active) and the merchant payout wallet are verified live. **Not yet exercised live:** channel open and voucher redemption, because the agent wallet has no gas on the EVM testnet (fund it at https://faucet.testevm.ripple.com). The adapter is covered against an SDK double (`test/ap4m.test.ts`).

### Single backend

The earlier parallel `CreditSystem` (`system.ts`, `score.ts`, `policy.ts`, `originator.ts`, `store.ts`, `types.ts`, `money.ts`, `errors.ts`, the CLI demo and its tests) was removed; the credit-layer scoring engine in `src/scoring/` is the only scoring model. What stays from the other branch: the router and HTTP helpers (`src/api/`), the QuickNode history library (`lib/`, used for cold start through `src/scoring/quicknodeHistory.ts` when `QUICKNODE_XRP_RPC_URL` is set), the AP4M SDK (`integrations/ap4m/`) and the website draft. Commands: `npm test` (vitest), `npm run demo`, `npm run api`, `npm run bootstrap`, `npm run resilience`.
