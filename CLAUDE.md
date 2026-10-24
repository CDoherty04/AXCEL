# Agentic Credit Layer on XRPL + Mastercard Agent Pay

Oct 24, 2026 · @Caleb Hite

## TL;DR

Build the credit layer around the person, not the agent. One score per user starts from their existing ledger history and unlocks an XRPL loan. Their agents spend that loan through Mastercard Agent Pay, and every repayment raises the score for all of that user's agents. Every piece except the score itself is a native XRPL amendment or an existing Mastercard spec, so your custom code is the scoring engine and the glue.

### The flow, end to end

1. **Cold start:** read the user's Mainnet history through QuickNode, plus any Devnet history, and set a starting score.
2. **Borrow:** the score maps to a tier, and the tier sets how much the user can draw from an XLS-66 loan.
3. **Spend:** the loan lands as RLUSD in the user's account, and their agents spend it through Mastercard Agent Pay, each inside its own mandate.
4. **Repay:** the user pays on schedule with LoanPay, or pays it all off early.
5. **Build:** repayments and every agent's clean purchases raise one user-level score, which every agent inherits.

### The stack in one line each

- **Identity:** an XRPL DID for the user with each agent's account linked to it, plus a KYA-Verified Credential proving a real, KYC'd person stands behind every agent.
- **Proof of good behavior:** Mastercard Verifiable Intent (L1/L2/L3 credential chain) on each purchase, with the hash written into the XRPL payment memo.
- **Settlement:** RLUSD on XRPL, which Mastercard already lists as a rail in Agent Pay for Machines.
- **Score output:** an expiring CreditTier Credential on the user's account, which every linked agent inherits.
- **Credit:** Single Asset Vault + Lending Protocol lend to the user; Permission Delegation lets each agent spend the loan without the user's master key.
- **History and repayment:** QuickNode's Mainnet archive for cold start; LoanPay for installments or early payoff, with Batch keeping repayment and credential refresh atomic.

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
| Permissioned Domains (XLS-80) | Live since Feb 4, 2026 (report) | One domain per credit tier; accounts holding an accepted credential are members automatically, no join step |
| Deposit Authorization + credential-based DepositPreauth | Live (extended by Credentials) | Lender and merchant accounts accept funds only from credentialed agents |
| Multi-Purpose Tokens (XLS-33) | Live since about Oct 1, 2025 (report) | Vault shares are MPTs; you can also issue a non-transferable "credit points" MPT as a visible, soulbound-style score |
| Permission Delegation V1.1 (XLS-75) | Live since Oct 8, 2026 | Owner account delegates only Payment rights to the agent's key, so the agent never holds the master key; up to 10 permissions per delegate |
| Batch V1.1 (XLS-56) | Live since Oct 9, 2026 | Up to 8 transactions all-or-nothing: repay a loan installment and refresh the tier credential in one atomic step |
| Token Escrow (XLS-85) | Live since early 2026 (report) | Escrow RLUSD, not just XRP: hold-back on large agent purchases, or pay-later released on a date |
| Price Oracle (XLS-47) | Live since Nov 2, 2024 | Price XRP or other collateral in USD when an agent posts partial collateral |
| Checks, Payment Channels | Live | Checks for pull-style repayment; channels for streaming sub-cent repayments from agent revenue |
| Single Asset Vault (XLS-65) | Voting: 21 of 29 votes on Oct 19 (crypto.news); live on Devnet | The lending pool: lenders deposit RLUSD and get MPT shares; a private vault can require a Permissioned Domain |
| Lending Protocol (XLS-66 + V1.1) | Voting: 19 of 29 votes on Oct 19; live on Devnet | LoanBrokerSet, LoanSet (co-signed by broker and borrower), LoanPay, default handling and first-loss cover. Underwriting is off-chain by design, which is exactly where your score plugs in |

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
4. **Link agents.** Each agent gets its own account, listed under the user's DID, and a `DelegateSet` from the user granting only Payment permission on the user's account. Delegation limits which actions an agent can take, not how much it spends. Per-agent caps come from each agent's L2 mandate and Agentic Token limit.
5. **Spend.** An agent builds an L3 order inside its mandate and pays through Agent Pay. Settlement is a delegated RLUSD Payment from the user's account, with `sha256(VI chain)` and the agent's DID in Memos. The service checks that total spend across all agents stays under the credit line.
6. **Repay.** The user pays installments with `LoanPay` or pays the balance off early; create the loan with overpayment allowed so early payoff works. A Batch can pair each payment with a credential refresh.
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
S = 300 + 550 \cdot \sigma\big(w_1 \log(1 + P_A + \lambda P_C) + w_2 R + w_3 D + w_4 A - w_5 C - w_6 L - w_7 U\big), \quad \lambda = 0.25
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
| $U$ | Average utilization |

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
| 4 Repay | Repayment | Devnet | Reuse | `LoanPay` for installments or full payoff, inside a Batch with the credential refresh |
| 5 Build | Live event feed | Devnet | Build (small) | xrpl.js `subscribe` on the user's account for purchases and repayments; QuickNode Streams can take over if you later move to Testnet or Mainnet |
| 5 Build | Scoring engine | Off-ledger | Build (your core) | Node or Python service: formula, anti-gaming rules, and a check that total spend across all agents stays under the credit line |
| All | Dashboard | Off-ledger | Build | User profile: score, tier, credit used vs. limit, spend per agent, repayment schedule, with the network labeled on every panel |

### Demo script (about 4 minutes)

1. **Cold start:** the user signs a challenge proving they own a Mainnet account. QuickNode pulls its history, and the dashboard shows a starting score of, say, 610 (tier B).
2. **Borrow:** the service issues a CreditTier-B credential on Devnet. The user joins the tier-B domain and draws a 250-token credit line with `LoanSet`.
3. **Link agents:** the user adds a shopping agent and an API-buying agent, each with a Payment-only delegation and its own L2 mandate.
4. **Spend:** both agents buy through the Agent Pay flow, one in Immediate mode (the user approves each order) and one in Autonomous mode. Both add the same credit per purchase, and the dashboard shows each one is worth four plain Mainnet payments. Each purchase settles from the user's account with the VI hash in the memo, and the "credit used" bar fills.
5. **Guardrail:** one agent tries an out-of-mandate purchase; it's refused, and the score shows a clean stop.
6. **Repay:** the user pays one installment live, then pays off the rest early. Each payment is paired with a credential refresh in a Batch.
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
