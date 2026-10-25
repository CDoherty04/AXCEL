# AXCEL
Agentic XRPL Credit Exchange Layer

We enable agents to be tied to a user and build a new type of credit which represents responsible use of trading agents. It uses Mastercard Agent Pay for Machines (AP4M) so each agent spends through a signed, capped payment channel with Verifiable Intent on every purchase, QuickNode to read the user's Mainnet XRPL history as a cold-start score, and native XRPL identity and lending so every linked agent inherits one shared credit line. Clean spend and on-time repayment raise that one user-level score; a misbehaving agent costs the user, not just itself.

## Technical description

AXCEL scores the user, not each agent. QuickNode reads Mainnet XRPL history to cold-start a 300–850 score; that score becomes an A–F credential and unlocks a native XRPL loan that every linked agent shares. Agents are DID-linked keys with Payment-only delegation—they never hold the user's master key.

Spend goes through Mastercard Agent Pay for Machines (AP4M): an RLUSD-capped payment channel and a Verifiable Intent chain on every purchase. Each buy redeems a voucher against that cap, then an XRPL Payment anchors the same amount with the VI hash and AP4M claim in the memo—the event the score reads. Verified agent purchases count 4× a plain payment. Repayment raises the shared tier; a bad agent costs the user.

## QuickNode Mainnet Backlog

XRPL `account_tx` backlog for an account (default: `rUjfTQpvBr6wsGGxMw6sRmRQGG76nvp8Ln`).

Put your QuickNode HTTP URL in `.env.local` (see `.env.example`), then:

```bash
npm run axcel -- history rAddress…
npm run axcel -- history rAddress… --json --limit 1000
npm run axcel -- score rAddress…
```
