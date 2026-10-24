import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Tier } from '../config.js'
import type { ScoreEvent } from '../scoring/types.js'

export interface Jwk { [k: string]: unknown }
export interface KeyPairJwk { private_jwk: Jwk; public_jwk: Jwk }

export interface Infra {
  issuerSeed: string
  serviceSeed: string
  currency: string
  /** Permissioned Domain per tier: "this tier or better". */
  domains: Record<Tier, string>
  vaultId: string
  brokerId: string
  /** Mastercard (L1 issuer) key used by the VI bridge. */
  viIssuer: KeyPairJwk
  /** Key the mock merchants sign checkout JWTs with. */
  viMerchant: KeyPairJwk
  vaultSubscriptionDate: number
}

export interface AgentRecord {
  id: string
  label: string
  account: string
  seed: string
  did: string
  kid: string
  viKey: KeyPairJwk
  /** Mock Know-Your-Agent registration id (Mastercard Acceptance Framework). */
  mastercardAgentId: string
  /**
   * Spending account the agent pays from. It is funded just in time for each purchase and holds ~0 between
   * purchases, so a stolen agent key can reach almost nothing. The agent is delegated Payment on this account,
   * never on the user's main account.
   */
  pot: { account: string; seed: string }
  mode: 'immediate' | 'autonomous'
  status: 'active' | 'revoked'
  /** Per-purchase cap, USD cents (the L2 payment.amount max). */
  maxCents: number
  /** Total budget across all purchases for this agent, USD cents. */
  budgetCents: number
  spentCents: number
  /** Serialized L2 for autonomous agents. */
  l2?: string
  merchants: { id: string; name: string; website: string }[]
  items: { id: string; title: string }[]
  createdAt: number
  revokedAt?: number
}

export interface LoanRecord {
  loanId: string
  principal: number
  openedAt: number
  closedAt?: number
  paymentsMade: number
  outstanding: number
  tx: string
}

export interface MerchantRecord {
  id: string
  name: string
  website: string
  /** Devnet account that receives settlement. */
  account: string
  seed: string
}

export type PendingState = 'validated' | 'authorized' | 'funded' | 'paid' | 'declined' | 'stranded'

/**
 * Write-ahead record of a purchase in flight. Created before the network is asked to authorize, advanced one
 * step at a time, and resumed by the reconciler, so a crash between "network redeemed" and "XRPL anchored"
 * never loses or repeats the redemption.
 */
export interface PendingPurchase {
  id: string
  agentId: string
  viHash: string
  mode: 'immediate' | 'autonomous'
  amountCents: number
  merchantId: string
  merchantAccount: string
  chain: { l1: string; l2: string; l3a?: string; l2Payment?: string }
  state: PendingState
  authorizationId?: string
  evidence?: { network: string; channelId?: string; redeemTx?: string; claimId?: string; rlusd?: string }
  fundTx?: string
  payTx?: string
  attempts: number
  error?: string
  createdAt: number
  updatedAt: number
}

export interface PurchaseRecord {
  id: string
  agentId: string
  merchant: string
  amount: number
  mode: 'immediate' | 'autonomous'
  viHash: string
  txHash: string
  ts: number
  /** Full VI chain, kept off-ledger. Only its hash is in the payment memo. */
  chain: { l1: string; l2: string; l3a?: string; l2Payment?: string }
}

export interface UserRecord {
  id: string
  /** Devnet account that holds the DID, credentials, loan and funds. */
  account: string
  /** Demo custody only. Production signs client-side. */
  seed: string
  mainnetAccount?: string
  mainnetVerified: boolean
  did: string
  viUserKey: KeyPairJwk
  /** Serialized L1 issued by the (mock) Mastercard credential provider. */
  l1?: string
  kyaExpiresAt?: number
  tier?: Tier
  tierExpiresAt?: number
  score?: number
  accountCreatedAt: number
  agents: Record<string, AgentRecord>
  events: ScoreEvent[]
  loans: LoanRecord[]
  purchases: PurchaseRecord[]
  pending: PendingPurchase[]
  /** Merchants flagged as self-dealing by the anti-gaming resolver. */
  excludedMerchants: string[]
  challenge?: { message: string; expiresAt: number }
  /** Funding source of the user's Mainnet account, for the self-dealing check. */
  fundingSources: string[]
  /** NextPaymentDueDate values already penalized as late, so a sweep is idempotent. */
  lateFlaggedDue: number[]
}

export interface State {
  infra?: Infra
  users: Record<string, UserRecord>
  merchants: Record<string, MerchantRecord>
}

/** JSON-file state store. Fine for a hackathon demo; swap for a database in production. */
export class Store {
  state: State

  constructor(private readonly path: string) {
    this.state = { users: {}, merchants: {}, ...(existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<State>) : {}) }
    this.migrate()
  }

  /**
   * State written before spending accounts existed: agents had a delegation on the user's main account and no pot.
   * Retire them (they cannot settle any more) and give every user a pending list.
   */
  private migrate(): void {
    for (const u of Object.values(this.state.users)) {
      u.pending ??= []
      for (const a of Object.values(u.agents)) {
        if (!a.pot && a.status === 'active') {
          a.status = 'revoked'
          a.revokedAt ??= Math.floor(Date.now() / 1000)
        }
      }
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.state, null, 2))
  }

  user(id: string): UserRecord {
    const u = this.state.users[id]
    if (!u) throw new HttpError(404, `unknown user ${id}`)
    return u
  }

  userByAccount(account: string): UserRecord | undefined {
    return Object.values(this.state.users).find((u) => u.account === account)
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
