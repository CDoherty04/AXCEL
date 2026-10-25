import { randomUUID } from 'node:crypto'
import { Wallet } from 'xrpl'
import { credentialTypes, hex, publicUrl, tiers, type Tier } from './config.js'
import { issuerWallet, serviceWallet, tokenAmount } from './credit/infra.js'
import { createPot, ensurePayerCredential, freezePot, fundPot, restrictMerchant } from './credit/pots.js'
import {
  openLoan, payoffAmount, readLoan, submitCredentialRefreshBatch, tokenBalance, TF_LOAN_FULL_PAYMENT, type LoanState,
} from './credit/loans.js'
import { currentTier, existingTiers, issueTierCredential, tierRefreshTransactions } from './credit/tierCredential.js'
import { createChallenge, signChallenge, verifyChallenge } from './identity/challenge.js'
import { agentDocument, didFor, publishDid, userDocument, type DidDocument } from './identity/did.js'
import { issueKya, kyaStatus, tierStatus, type KycProvider } from './identity/kya.js'
import type { AgentRegistry, AuthorizationResult, NetworkAuthorizer } from './mastercard/agentPay.js'
import { findSelfDealing, type MerchantResolver } from './scoring/antiGaming.js'
import { computeScore } from './scoring/engine.js'
import type { HistoryReader } from './scoring/history.js'
import type { ScoreEvent, ScoreResult } from './scoring/types.js'
import { HttpError, type AgentRecord, type MerchantRecord, type PendingPurchase, type PendingState, type Store, type UserRecord } from './store/state.js'
import { judgePotPayment, viHashOf, type LedgerPayment, type PotPaymentVerdict } from './settlement.js'
import { chainHash, type Item, type Merchant, type ViChain, type ViBridge } from './vi/bridge.js'
import { nowUnix, type Ledger } from './xrpl/client.js'

export interface Deps {
  ledger: Ledger
  store: Store
  vi: ViBridge
  kyc: KycProvider
  registry: AgentRegistry
  authorizer: NetworkAuthorizer
  mainnetHistory: HistoryReader
  /** Optional: Devnet history for the user's credit account. */
  devnetHistory?: HistoryReader
  resolver: MerchantResolver
  baseUrl?: string
  /** Borrow on demand: when the user's balance is short, draw max(shortfall, chunk) test dollars (off by default). */
  autoBorrowChunk?: number
}

export interface AgentOptions {
  label: string
  mode: 'immediate' | 'autonomous'
  /** Per-purchase cap in USD cents. For autonomous agents this is the L2 payment.amount max. */
  maxCents?: number
  /** Total this agent may spend, USD cents. */
  budgetCents?: number
  /** Defaults to every registered merchant (a default one is registered when none exist). */
  merchantIds?: string[]
  /** Defaults to a generic "Purchase" item. */
  items?: Item[]
}

/** When a limit is left blank it falls back to the other one, then to the top tier's credit line. */
const DEFAULT_LIMIT_CENTS = Math.round(tiers.A.creditLine * 100)

export interface CreditState {
  tier: Tier | null
  creditLine: number
  principalOutstanding: number
  /** Purchases not yet matched by principal repayment. */
  spendOutstanding: number
  available: number
  utilization: number
  balance: number
}

const cents = (c: number): string => (c / 100).toFixed(2)
const ripple = (unix: number): number => unix - 946_684_800
const MAX_ATTEMPTS = 5

/** A network decline: final, not retried. */
class Declined extends Error {}

/** Records handed to API callers never carry seeds or private keys. */
export type PublicAgent = Omit<AgentRecord, 'seed' | 'pot' | 'viKey' | 'l2'> & { pot: { account: string }; viPublicKey: unknown }
export const publicAgent = (a: AgentRecord): PublicAgent => {
  const { seed: _s, pot, viKey, l2: _l2, ...rest } = a
  return { ...rest, pot: { account: pot.account }, viPublicKey: viKey.public_jwk }
}
export const publicUser = (u: UserRecord) => ({
  id: u.id, account: u.account, did: u.did, mainnetAccount: u.mainnetAccount, mainnetVerified: u.mainnetVerified,
  kyaExpiresAt: u.kyaExpiresAt, tier: u.tier, tierExpiresAt: u.tierExpiresAt, score: u.score,
  agents: Object.values(u.agents).map(publicAgent), viUserPublicKey: u.viUserKey.public_jwk,
})

export class CreditService {
  readonly ledger: Ledger
  readonly store: Store
  private readonly base: string
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Unexpected agent activity caught by the guard; surfaced on the profile. */
  readonly alerts: { ts: number; agentId: string; txHash: string; reason: string }[] = []
  /** Set by the live feed so newly created spending accounts are watched. */
  onWatch?: (account: string) => void

  constructor(private readonly d: Deps) {
    this.ledger = d.ledger
    this.store = d.store
    this.base = d.baseUrl ?? publicUrl
  }

  // ------------------------------------------------------------------ plumbing

  private get infra() {
    const i = this.store.state.infra
    if (!i) throw new HttpError(503, 'lending infrastructure not bootstrapped (run scripts/bootstrap.ts)')
    return i
  }
  private get service(): Wallet { return serviceWallet(this.infra) }
  private userWallet(u: UserRecord): Wallet { return Wallet.fromSeed(u.seed) }
  private agentWallet(a: AgentRecord): Wallet { return Wallet.fromSeed(a.seed) }
  private merchant(id: string): MerchantRecord {
    const m = this.store.state.merchants[id]
    if (!m) throw new HttpError(404, `unknown merchant ${id}`)
    return m
  }
  private agentOf(agentId: string): { user: UserRecord; agent: AgentRecord } {
    for (const user of Object.values(this.store.state.users)) {
      const agent = user.agents[agentId]
      if (agent) return { user, agent }
    }
    throw new HttpError(404, `unknown agent ${agentId}`)
  }
  private vim(m: MerchantRecord): Merchant { return { id: m.id, name: m.name, website: m.website } }

  /** DID document by account, as served at /did/:account. */
  didDocument(account: string): DidDocument | null {
    for (const u of Object.values(this.store.state.users)) {
      if (u.account === account) return userDocument(u)
      for (const a of Object.values(u.agents)) if (a.account === account) return agentDocument(u, a)
    }
    return null
  }

  private async publishUserDid(u: UserRecord): Promise<string> {
    return publishDid(this.ledger, this.userWallet(u), `${this.base}/did/${u.account}`, userDocument(u))
  }

  // ------------------------------------------------------------------ merchants (mock Agent Pay acceptors)

  async registerMerchant(input: { name: string; website: string }): Promise<Omit<MerchantRecord, 'seed'>> {
    const wallet = await this.ledger.fund()
    const token = tokenAmount(this.infra, '100000000')
    await this.ledger.submit({ TransactionType: 'TrustSet', Account: wallet.address, LimitAmount: token }, wallet)
    // Accept funds only from accounts holding an AGENT_PAYER credential from this service.
    await restrictMerchant(this.ledger, this.service.address, wallet)
    const m: MerchantRecord = { id: `m_${randomUUID().slice(0, 8)}`, ...input, account: wallet.address, seed: wallet.seed! }
    this.store.state.merchants[m.id] = m
    this.store.save()
    const { seed: _seed, ...pub } = m
    return pub
  }

  // ------------------------------------------------------------------ users and identity

  /** Create the user's Devnet account, VI keys, Mastercard L1 credential and an XRPL DID. */
  async createUser(id: string = `u_${randomUUID().slice(0, 8)}`) {
    if (this.store.state.users[id]) throw new HttpError(409, `user ${id} exists`)
    const [wallet, viUserKey] = await Promise.all([this.ledger.fund(), this.d.vi.keygen()])
    const did = didFor(wallet.address)
    const l1 = await this.d.vi.issueL1({ issuer: this.infra.viIssuer, userPublicJwk: viUserKey.public_jwk, subject: did })
    const user: UserRecord = {
      id, account: wallet.address, seed: wallet.seed!, mainnetVerified: false, did, viUserKey, l1,
      accountCreatedAt: nowUnix(), agents: {}, events: [], loans: [], purchases: [], pending: [], excludedMerchants: [],
      fundingSources: [], lateFlaggedDue: [],
    }
    this.store.state.users[id] = user
    await this.publishUserDid(user)
    this.store.save()
    return publicUser(user)
  }

  /** Step 1 of cold start: a challenge that binds the Mainnet and Devnet accounts. */
  startLink(userId: string, mainnetAccount: string): { message: string; expiresAt: number } {
    const u = this.store.user(userId)
    u.mainnetAccount = mainnetAccount
    u.mainnetVerified = false
    u.challenge = createChallenge(mainnetAccount, u.account, nowUnix())
    this.store.save()
    return u.challenge
  }

  /** Step 2: both accounts sign the challenge. Only then is the Mainnet history scorable. */
  confirmLink(userId: string, proofs: { mainnet: { signature: string; publicKey: string }; devnet: { signature: string; publicKey: string } }): void {
    const u = this.store.user(userId)
    if (!u.challenge || !u.mainnetAccount) throw new HttpError(400, 'no challenge issued')
    if (u.challenge.expiresAt < nowUnix()) throw new HttpError(400, 'challenge expired')
    const okMain = verifyChallenge(u.challenge.message, proofs.mainnet.signature, proofs.mainnet.publicKey, u.mainnetAccount)
    const okDev = verifyChallenge(u.challenge.message, proofs.devnet.signature, proofs.devnet.publicKey, u.account)
    if (!okMain || !okDev) throw new HttpError(403, 'signature does not prove control of both accounts')
    u.mainnetVerified = true
    u.challenge = undefined
    this.store.save()
  }

  /** Demo convenience: sign the challenge with the custodied Devnet key and a supplied Mainnet wallet. */
  demoSignLink(userId: string, mainnetWallet: Wallet) {
    const u = this.store.user(userId)
    if (!u.challenge) throw new HttpError(400, 'no challenge issued')
    const dev = this.userWallet(u)
    return {
      mainnet: { signature: signChallenge(mainnetWallet, u.challenge.message), publicKey: mainnetWallet.publicKey },
      devnet: { signature: signChallenge(dev, u.challenge.message), publicKey: dev.publicKey },
    }
  }

  /** KYC the person and issue the KYA-Verified credential (service -> user, accepted by the user). */
  async verifyOwner(userId: string, subject: { legalName: string; country: string; documentId: string }) {
    const u = this.store.user(userId)
    const out = await issueKya(this.ledger, this.service, this.userWallet(u), this.d.kyc, subject)
    u.kyaExpiresAt = out.expiresAt
    this.store.save()
    return { expiresAt: out.expiresAt, txHashes: out.txHashes }
  }

  /** KYA status by DID or account, for third parties (merchants, other agents) that want to check an owner. */
  async kyaLookup(didOrAccount: string) {
    const u = Object.values(this.store.state.users).find((x) => x.did === didOrAccount || x.account === didOrAccount)
    if (!u) throw new HttpError(404, `no user for ${didOrAccount}`)
    const [kya, tier] = await Promise.all([
      kyaStatus(this.ledger, u.account, this.service.address),
      currentTier(this.ledger, u.account, this.service.address),
    ])
    return { did: u.did, account: u.account, kyaVerified: kya.valid, kyaExpiresAt: kya.expiresAt, tier: tier?.tier ?? null, tierExpiresAt: tier?.expiresAt }
  }

  // ------------------------------------------------------------------ scoring

  /** Read Mainnet (and any Devnet) history for the proven accounts and score the user. */
  async coldStart(userId: string): Promise<ScoreResult> {
    const u = this.store.user(userId)
    if (!u.mainnetAccount || !u.mainnetVerified) throw new HttpError(403, 'prove control of the Mainnet account first')

    const main = await this.d.mainnetHistory.read(u.mainnetAccount)
    const dev = this.d.devnetHistory ? await this.d.devnetHistory.read(u.account) : undefined
    const seen = new Set(u.events.flatMap((e) => ('txHash' in e && e.txHash ? [e.txHash] : [])))
    for (const e of [...main.events, ...(dev?.events ?? [])]) {
      if ('txHash' in e && e.txHash && seen.has(e.txHash)) continue
      u.events.push(e)
    }
    const firsts = [main.firstActivityAt, dev?.firstActivityAt, u.accountCreatedAt].filter((x): x is number => !!x)
    u.accountCreatedAt = Math.min(...firsts)
    u.fundingSources = [...new Set([...u.fundingSources, ...[main.fundingSource, dev?.fundingSource].filter((x): x is string => !!x)])]
    this.store.save()
    return this.rescore(userId)
  }

  private async identity(u: UserRecord) {
    return {
      ownedAccounts: [u.account, ...(u.mainnetAccount ? [u.mainnetAccount] : []), ...Object.values(u.agents).flatMap((a) => [a.account, a.pot.account])],
      fundingSources: u.fundingSources,
      didControllers: [u.did],
    }
  }

  /** Recompute the score from all events, with the live KYA status and the self-dealing filter applied. */
  async rescore(userId: string, extra: ScoreEvent[] = []): Promise<ScoreResult> {
    const u = this.store.user(userId)
    const now = nowUnix()
    const events = [...u.events, ...extra]
    const merchants = events.flatMap((e) => (e.type === 'plain_payment' || e.type === 'agent_purchase' ? [e.merchant] : []))
    const excluded = await findSelfDealing(merchants, await this.identity(u), this.d.resolver)
    u.excludedMerchants = [...excluded]
    const kya = await kyaStatus(this.ledger, u.account, this.service.address, now)
    const result = computeScore({ events, kyaValid: kya.valid, accountCreatedAt: u.accountCreatedAt, now, excludedMerchants: excluded })
    if (!extra.length) {
      u.score = result.score ?? undefined
      this.store.save()
    }
    return result
  }

  /** Issue or replace the CreditTier credential so it matches the current score. */
  async syncTier(userId: string): Promise<{ tier: Tier; expiresAt: number; score: number; changed: boolean }> {
    const u = this.store.user(userId)
    const r = await this.rescore(userId)
    if (!r.eligible || !r.tier) throw new HttpError(403, r.reasons.join('; '))
    const held = await currentTier(this.ledger, u.account, this.service.address)
    if (held && held.tier === r.tier) {
      u.tier = held.tier
      u.tierExpiresAt = held.expiresAt
      this.store.save()
      return { tier: held.tier, expiresAt: held.expiresAt, score: r.score!, changed: false }
    }
    const issued = await issueTierCredential(this.ledger, this.service, this.userWallet(u), r.tier)
    u.tier = r.tier
    u.tierExpiresAt = issued.expiresAt
    this.store.save()
    return { tier: r.tier, expiresAt: issued.expiresAt, score: r.score!, changed: true }
  }

  // ------------------------------------------------------------------ credit

  async creditState(userId: string): Promise<CreditState> {
    const u = this.store.user(userId)
    const held = await currentTier(this.ledger, u.account, this.service.address)
    const line = held ? tiers[held.tier].creditLine : 0
    let principalOutstanding = 0
    let principalRepaid = 0
    for (const l of u.loans) {
      const s = await readLoan(this.ledger, l.loanId)
      const out = s ? s.principalOutstanding : 0
      principalOutstanding += out
      principalRepaid += l.principal - out
      l.outstanding = out
      if (!s && !l.closedAt) l.closedAt = nowUnix()
    }
    const spent = u.purchases.reduce((s, p) => s + p.amount, 0)
    const spendOutstanding = Math.max(0, spent - principalRepaid)
    return {
      tier: held?.tier ?? null,
      creditLine: line,
      principalOutstanding,
      spendOutstanding,
      available: Math.max(0, line - Math.max(principalOutstanding, spendOutstanding)),
      utilization: line > 0 ? Math.min(1, spendOutstanding / line) : 0,
      balance: await tokenBalance(this.ledger, this.infra, u.account),
    }
  }

  private pushUtilization(u: UserRecord, cs: CreditState): void {
    u.events.push({ type: 'utilization', ts: nowUnix(), value: cs.utilization })
  }

  /** Draw from the credit line: the broker and the user co-sign a LoanSet. */
  async borrow(userId: string, amount?: number) {
    const u = this.store.user(userId)
    const kya = await kyaStatus(this.ledger, u.account, this.service.address)
    if (!kya.valid) throw new HttpError(403, 'KYA-Verified credential missing or expired')
    const cs = await this.creditState(userId)
    if (!cs.tier) throw new HttpError(403, 'no valid CreditTier credential')
    const principal = amount ?? cs.available
    if (principal <= 0) throw new HttpError(409, 'no credit available')
    if (principal > cs.available) throw new HttpError(409, `requested ${principal} exceeds available credit ${cs.available}`)
    const { loanId, txHash } = await openLoan(this.ledger, this.infra, this.service, this.userWallet(u), principal)
    u.loans.push({ loanId, principal, openedAt: nowUnix(), paymentsMade: 0, outstanding: principal, tx: txHash })
    this.pushUtilization(u, await this.creditState(userId))
    this.store.save()
    return { loanId, principal, txHash }
  }

  // ------------------------------------------------------------------ agents

  /** Demo: name and a spending limit. Creates the profile, identity credential and a default merchant when needed. */
  async addNamedAgent(userId: string | undefined, label: string, limitCents: number, wallet?: string) {
    let id = userId
    if (!id || !this.store.state.users[id]) id = (await this.createUser(id)).id
    const u = this.store.user(id)
    if (!(await kyaStatus(this.ledger, u.account, this.service.address)).valid) {
      await this.verifyOwner(id, { legalName: label, country: 'US', documentId: u.account })
    }
    let merchant = Object.values(this.store.state.merchants)[0]
    if (!merchant) {
      const created = await this.registerMerchant({ name: 'Agent Pay', website: 'https://hackathon.ap4m.build' })
      merchant = this.store.state.merchants[created.id]
    }
    if (wallet && !u.events.length) await this.seedFromWallet(u, wallet)
    const agent = await this.addAgent(id, {
      label,
      mode: 'autonomous',
      maxCents: limitCents,
      budgetCents: limitCents,
      merchantIds: [merchant.id],
      items: [{ id: 'purchase', title: 'Purchase' }],
    })
    return { userId: id, ...agent }
  }

  /**
   * Score a connected wallet's own history (the same QuickNode read as the score preview) and put the matching
   * CreditTier credential on the user's account, so its agents can spend. Best effort: with no history the user
   * simply starts at the bottom tier.
   */
  private async seedFromWallet(u: UserRecord, wallet: string): Promise<void> {
    try {
      const h = await this.d.mainnetHistory.read(wallet)
      u.events.push(...h.events)
      if (h.firstActivityAt) u.accountCreatedAt = Math.min(u.accountCreatedAt, h.firstActivityAt)
      this.store.save()
      await this.syncTier(u.id)
    } catch (e) {
      console.error(`[credit-layer] could not score ${wallet}:`, e instanceof Error ? e.message : e)
    }
  }

  async addAgent(userId: string, input: AgentOptions): Promise<PublicAgent> {
    const u = this.store.user(userId)
    const kya = await kyaStatus(this.ledger, u.account, this.service.address)
    if (!kya.valid) throw new HttpError(403, 'owner must hold a valid KYA-Verified credential before linking agents')
    let merchantIds = input.merchantIds?.length ? input.merchantIds : Object.keys(this.store.state.merchants)
    if (!merchantIds.length) {
      merchantIds = [(await this.registerMerchant({ name: 'Agent Pay', website: 'https://hackathon.ap4m.build' })).id]
    }
    const opts = {
      ...input,
      maxCents: input.maxCents ?? input.budgetCents ?? DEFAULT_LIMIT_CENTS,
      budgetCents: input.budgetCents ?? input.maxCents ?? DEFAULT_LIMIT_CENTS,
      merchantIds,
      items: input.items?.length ? input.items : [{ id: 'purchase', title: 'Purchase' }],
    }
    const merchants = opts.merchantIds.map((id) => this.vim(this.merchant(id)))
    // The two faucet calls dominate the wait, so fund the agent and its spending account together.
    const [wallet, potWallet, viKey] = await Promise.all([this.ledger.fund(), this.ledger.fund(), this.d.vi.keygen()])
    const id = `ag_${randomUUID().slice(0, 8)}`
    const did = didFor(wallet.address)
    const { mastercardAgentId } = await this.d.registry.register({
      ownerDid: u.did, agentDid: did, publicKeyThumbprint: String((viKey.public_jwk as { x?: string }).x ?? ''),
    })

    // The agent pays from its own spending account, never from the user's main account.
    const pot = await createPot(this.ledger, this.infra, this.service, wallet.address, potWallet)
    const agent: AgentRecord = {
      id, label: opts.label, account: wallet.address, seed: wallet.seed!, did, kid: id, viKey, mastercardAgentId,
      pot: { account: pot.wallet.address, seed: pot.wallet.seed! },
      mode: opts.mode, status: 'active', maxCents: opts.maxCents, budgetCents: opts.budgetCents, spentCents: 0,
      merchants, items: opts.items, createdAt: nowUnix(),
    }
    if (opts.mode === 'autonomous') {
      agent.l2 = await this.d.vi.autonomousMandate({
        l1: u.l1!, user: u.viUserKey, agentPublicJwk: viKey.public_jwk, agentKid: id,
        merchants, items: opts.items, maxCents: opts.maxCents, summary: `${opts.label}: up to $${cents(opts.maxCents)} per purchase`,
      })
    }
    u.agents[id] = agent
    await publishDid(this.ledger, wallet, `${this.base}/did/${wallet.address}`, agentDocument(u, agent))
    await this.publishUserDid(u)
    this.store.save()
    this.onWatch?.(pot.wallet.address)
    return publicAgent(agent)
  }

  /**
   * Revoke instantly: remove the delegation, delete the pot's payer credential (merchants then refuse it even if
   * the delegation lingered), sweep the pot back to the user and drop the Mastercard registration. Purchases the
   * agent still had in flight are marked stranded for review. History stays in the score.
   */
  async revokeAgent(agentId: string): Promise<{ txHash: string; txHashes: string[] }> {
    const { user, agent } = this.agentOf(agentId)
    const hashes = await freezePot(this.ledger, this.infra, this.service, Wallet.fromSeed(agent.pot.seed), agent.account, user.account)
    await this.d.registry.revoke(agent.mastercardAgentId)
    agent.status = 'revoked'
    agent.revokedAt = nowUnix()
    for (const p of user.pending) {
      if (p.agentId === agent.id && p.state !== 'paid') {
        p.state = 'stranded'
        p.error = 'agent revoked before the purchase completed'
      }
    }
    await this.publishUserDid(user)
    this.store.save()
    return { txHash: hashes[0]!, txHashes: hashes }
  }

  // ------------------------------------------------------------------ spending

  /** Build the VI chain an agent would present for an order. In production the agent does this itself. */
  async buildChain(agentId: string, order: { merchantId: string; item: Item; amountCents: number }): Promise<ViChain> {
    const { user, agent } = this.agentOf(agentId)
    const m = this.merchant(order.merchantId)
    if (agent.mode === 'immediate') {
      const l2 = await this.d.vi.immediateMandate({
        l1: user.l1!, user: user.viUserKey, merchant: this.vim(m), item: order.item, amountCents: order.amountCents,
        merchantKey: this.infra.viMerchant,
      })
      return { l1: user.l1!, l2 }
    }
    const l3 = await this.d.vi.autonomousPurchase({
      l2: agent.l2!, agent: agent.viKey, agentKid: agent.kid, merchant: this.vim(m), item: order.item,
      amountCents: order.amountCents, merchantKey: this.infra.viMerchant,
    })
    return { l1: user.l1!, l2: agent.l2!, l3a: l3.l3a, l2Payment: l3.l2Payment }
  }

  private refuse(u: UserRecord, agent: AgentRecord, reason: string, status = 422): never {
    u.events.push({ type: 'mandate', ts: nowUnix(), agentId: agent.id, outcome: 'refused' })
    this.store.save()
    throw new HttpError(status, reason)
  }

  /** One settlement at a time per agent: pot funding and payment must not interleave. */
  private async withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(agentId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.locks.set(agentId, run.catch(() => undefined))
    return run
  }

  private pendingCents(u: UserRecord, agentId?: string): number {
    return u.pending
      .filter((p) => p.state !== 'stranded' && p.state !== 'declined' && (!agentId || p.agentId === agentId))
      .reduce((s, p) => s + p.amountCents, 0)
  }

  /**
   * Verify one purchase and settle it. Amount and payee come from the validated chain, never from the request.
   *
   * Settlement is a write-ahead state machine (validated -> authorized -> funded -> paid). The record is saved
   * before each step, the network is asked once (a retry resumes, it never redeems a second voucher), and the
   * purchase scores only after the pot's Payment validates on XRPL with the chain hash in its Memos. If any step
   * after authorization fails the purchase stays pending and `reconcile()` finishes it.
   */
  async settlePurchase(agentId: string, chain: ViChain, prior?: AuthorizationResult) {
    const { user: u, agent } = this.agentOf(agentId)
    if (agent.status !== 'active') throw new HttpError(403, 'agent is revoked')
    if (!(await this.d.registry.isRegistered(agent.mastercardAgentId))) throw new HttpError(403, 'agent is not registered with Mastercard')
    const kya = await kyaStatus(this.ledger, u.account, this.service.address)
    if (!kya.valid) throw new HttpError(403, 'owner KYA-Verified credential missing or expired')

    const viHash = chainHash(chain)
    if (u.purchases.some((p) => p.viHash === viHash)) throw new HttpError(409, 'this Verifiable Intent chain was already settled')

    return this.withLock(agentId, async () => {
      const existing = u.pending.find((p) => p.viHash === viHash)
      if (existing) return this.advance(u, existing)

      const v = await this.d.vi.validate(chain, this.infra.viIssuer.public_jwk)
      if (!v.valid || v.amount_cents === null || !v.payee) this.refuse(u, agent, `Verifiable Intent rejected: ${v.errors.join('; ') || 'invalid chain'}`)
      if (v.mode !== agent.mode) this.refuse(u, agent, `chain mode ${v.mode} does not match agent mode ${agent.mode}`)

      const merchant = this.store.state.merchants[v.payee!.id]
      if (!merchant) this.refuse(u, agent, `unknown payee ${v.payee!.id}`)
      const amountCents = v.amount_cents!
      if (agent.spentCents + this.pendingCents(u, agent.id) + amountCents > agent.budgetCents) this.refuse(u, agent, 'agent budget exceeded')

      let cs = await this.creditState(u.id)
      if (!cs.tier) {
        // The credential may have expired or never been issued; issue it from the current score and look again.
        await this.syncTier(u.id).catch(() => undefined)
        cs = await this.creditState(u.id)
      }
      if (!cs.tier) throw new HttpError(403, 'no valid CreditTier credential')
      const amount = amountCents / 100
      const inFlight = this.pendingCents(u) / 100
      if (cs.spendOutstanding + inFlight + amount > cs.creditLine) throw new HttpError(402, `purchase would exceed the credit line (${cs.creditLine})`)
      if (cs.balance < amount + inFlight) {
        const shortfall = amount + inFlight - cs.balance
        if (!this.d.autoBorrowChunk || cs.available < shortfall) throw new HttpError(402, 'insufficient borrowed balance in the user account')
        // Borrow on demand: draw only what the agent needs (at least one chunk, never past the line).
        await this.borrow(u.id, Math.min(cs.available, Math.max(shortfall, this.d.autoBorrowChunk)))
        cs = await this.creditState(u.id)
      }

      const now = nowUnix()
      const p: PendingPurchase = {
        id: `p_${randomUUID().slice(0, 8)}`, agentId: agent.id, viHash, mode: v.mode!, amountCents, merchantId: merchant!.id,
        merchantAccount: merchant!.account, chain, state: 'validated', attempts: 0, createdAt: now, updatedAt: now,
      }
      // A voucher the agent already redeemed (the 402 client) is reused. Authorizing again would redeem a second one.
      if (prior?.approved && prior.evidence?.claimId) {
        p.state = 'authorized'
        p.authorizationId = prior.authorizationId
        p.evidence = prior.evidence
      }
      u.pending.push(p)
      this.store.save()
      return this.advance(u, p)
    })
  }

  private touch(u: UserRecord, p: PendingPurchase, state?: PendingState): void {
    if (state) p.state = state
    p.updatedAt = nowUnix()
    this.store.save()
  }

  /** Run a pending purchase forward from wherever it stopped. */
  private async advance(u: UserRecord, p: PendingPurchase) {
    const agent = u.agents[p.agentId]!
    if (p.state === 'stranded') throw new HttpError(409, `purchase ${p.id} is stranded: ${p.error ?? 'needs review'}`)
    try {
      if (p.state === 'validated') {
        const auth = await this.d.authorizer.authorize({
          mastercardAgentId: agent.mastercardAgentId, viHash: p.viHash, amountCents: p.amountCents, currency: 'USD',
          merchantId: p.merchantId, mode: p.mode,
        })
        if (!auth.approved) {
          u.pending = u.pending.filter((x) => x !== p)
          this.store.save()
          throw new Declined(`network declined: ${auth.declineReason}`)
        }
        p.authorizationId = auth.authorizationId
        p.evidence = auth.evidence
        this.touch(u, p, 'authorized')
      }
      if (p.state === 'authorized') {
        p.fundTx = (await this.fundForPurchase(u, agent, p)) ?? p.fundTx
        this.touch(u, p, 'funded')
      }
      if (p.state === 'funded') {
        p.payTx = await this.payFromPot(agent, p)
        this.touch(u, p, 'paid')
      }
    } catch (e) {
      if (e instanceof Declined) throw new HttpError(402, e.message)
      p.attempts += 1
      p.error = e instanceof Error ? e.message : String(e)
      this.touch(u, p, p.attempts >= MAX_ATTEMPTS ? 'stranded' : undefined)
      throw new HttpError(202, `purchase ${p.id} is pending at "${p.state}" and will be retried: ${p.error}`)
    }
    return this.finalize(u, p)
  }

  /** Top the agent's pot up to exactly this purchase. Returns the funding tx, or undefined if already funded. */
  private async fundForPurchase(u: UserRecord, agent: AgentRecord, p: PendingPurchase): Promise<string | undefined> {
    const pot = Wallet.fromSeed(agent.pot.seed)
    await ensurePayerCredential(this.ledger, this.service, pot)
    const haveCents = Math.round((await tokenBalance(this.ledger, this.infra, pot.address)) * 100)
    if (haveCents >= p.amountCents) return undefined
    return fundPot(this.ledger, this.infra, this.userWallet(u), pot.address, cents(p.amountCents - haveCents))
  }

  /** Pay the merchant from the pot, signed by the delegated agent key. Safe to call again after a crash. */
  private async payFromPot(agent: AgentRecord, p: PendingPurchase): Promise<string> {
    const pot = Wallet.fromSeed(agent.pot.seed)
    const already = await this.findAnchor(pot.address, p.viHash)
    if (already) return already
    const haveCents = Math.round((await tokenBalance(this.ledger, this.infra, pot.address)) * 100)
    // A missing anchor with a short pot means an earlier submission may still be in flight: wait, never pay twice.
    if (haveCents < p.amountCents) throw new Error('pot balance is below the purchase amount; waiting for an earlier submission to settle')
    const credentialId = await ensurePayerCredential(this.ledger, this.service, pot)
    const tx: any = await this.ledger.client.autofill({
      TransactionType: 'Payment',
      Account: pot.address,
      Delegate: agent.account,
      Destination: p.merchantAccount,
      Amount: tokenAmount(this.infra, cents(p.amountCents)),
      CredentialIDs: [credentialId],
      Memos: [
        { Memo: { MemoType: hex('vi/sha256'), MemoData: p.viHash } },
        { Memo: { MemoType: hex('agent/did'), MemoData: hex(agent.did) } },
        ...(p.evidence?.claimId
          ? [{ Memo: { MemoType: hex('ap4m/claim'), MemoData: hex(`${p.evidence.network}:${p.evidence.claimId}`) } }]
          : []),
      ],
    })
    const res = await this.ledger.submitSigned(this.agentWallet(agent).sign(tx).tx_blob)
    return res.result.hash
  }

  /** Look for an already-validated payment out of the pot carrying this chain hash. */
  private async findAnchor(pot: string, viHash: string): Promise<string | undefined> {
    const r = await this.ledger.client.request({ command: 'account_tx', account: pot, limit: 40, ledger_index_min: -1, ledger_index_max: -1 })
    for (const t of r.result.transactions) {
      const tx = (t.tx_json ?? (t as { tx?: unknown }).tx) as Record<string, unknown> | undefined
      const meta = t.meta as { TransactionResult?: string } | string | undefined
      const ok = typeof meta === 'object' && meta?.TransactionResult === 'tesSUCCESS'
      if (ok && tx?.TransactionType === 'Payment' && tx.Account === pot && viHashOf(tx as never) === viHash) return (t.hash ?? tx.hash) as string
    }
    return undefined
  }

  /** Record a fully settled purchase: it is now evidence for the score. */
  private async finalize(u: UserRecord, p: PendingPurchase) {
    const agent = u.agents[p.agentId]!
    const ts = nowUnix()
    const amount = p.amountCents / 100
    u.purchases.push({
      id: p.id, agentId: agent.id, merchant: p.merchantAccount, amount, mode: p.mode, viHash: p.viHash, txHash: p.payTx!, ts, chain: p.chain,
    })
    u.events.push({ type: 'agent_purchase', ts, merchant: p.merchantAccount, agentId: agent.id, mode: p.mode, viHash: p.viHash, txHash: p.payTx })
    agent.spentCents += p.amountCents
    if (agent.spentCents >= agent.budgetCents * 0.95) u.events.push({ type: 'mandate', ts, agentId: agent.id, outcome: 'clean_stop' })
    u.pending = u.pending.filter((x) => x !== p)
    this.pushUtilization(u, await this.creditState(u.id))
    this.store.save()
    return {
      txHash: p.payTx!, fundTx: p.fundTx, viHash: p.viHash, amount, mode: p.mode, authorizationId: p.authorizationId,
      network: p.evidence, score: (await this.rescore(u.id)).score,
    }
  }

  /**
   * Finish purchases that stopped part-way (a crash, a timeout, a ledger hiccup). Safe to run any time and as
   * often as you like: authorization is idempotent per chain hash and payment checks for an existing anchor first.
   */
  async reconcile(minAgeMs = 30_000): Promise<{ resumed: string[]; stranded: string[] }> {
    const resumed: string[] = []
    const stranded: string[] = []
    const cutoff = nowUnix() - Math.floor(minAgeMs / 1000)
    for (const u of Object.values(this.store.state.users)) {
      for (const p of [...u.pending]) {
        if (p.state === 'stranded') { stranded.push(p.id); continue }
        if (p.updatedAt > cutoff) continue
        try {
          await this.withLock(p.agentId, () => this.advance(u, p))
          resumed.push(p.id)
        } catch (e) {
          if ((p as PendingPurchase).state === 'stranded') stranded.push(p.id)
          void e
        }
      }
    }
    return { resumed, stranded }
  }

  /**
   * Guard for the live feed: a delegated payment out of an agent's pot that matches no approved purchase means
   * the agent key was used outside the service. Revoke the agent at once.
   */
  async guardPotPayment(tx: LedgerPayment): Promise<PotPaymentVerdict | null> {
    for (const u of Object.values(this.store.state.users)) {
      const agent = Object.values(u.agents).find((a) => a.pot?.account === tx.Account)
      if (!agent) continue
      const verdict = judgePotPayment(tx, agent, u.pending, u.purchases)
      if (verdict.kind === 'unexpected' && agent.status === 'active') {
        u.events.push({ type: 'mandate', ts: nowUnix(), agentId: agent.id, outcome: 'refused' })
        this.alerts.push({ ts: nowUnix(), agentId: agent.id, txHash: tx.hash, reason: verdict.reason })
        await this.revokeAgent(agent.id)
      }
      return verdict
    }
    return null
  }

  /** What an agent may do right now; backs the LLM agent's get_mandate tool. */
  agentBrief(agentId: string) {
    const { agent } = this.agentOf(agentId)
    return {
      id: agent.id, label: agent.label, status: agent.status, mode: agent.mode,
      merchants: agent.merchants.map((m) => ({ id: m.id, name: m.name })),
      items: this.openItems(agent) ? ['anything: any goods or services'] : agent.items.map((i) => i.title),
      maxPerPurchaseUsd: agent.maxCents / 100,
      remainingBudgetUsd: (agent.budgetCents - agent.spentCents) / 100,
    }
  }

  /** A mandate whose only item is the generic "Purchase" places no limit on what is bought. */
  private openItems(agent: AgentRecord): boolean {
    return agent.items.length === 1 && agent.items[0]!.id === 'purchase'
  }

  /** The mandate item a described purchase is filed under; open mandates take anything. */
  resolveItem(agentId: string, text: string): Item {
    const { agent } = this.agentOf(agentId)
    if (this.openItems(agent)) return agent.items[0]!
    const t = text.trim().toLowerCase()
    return agent.items.find((i) => i.title.toLowerCase() === t) ?? { id: t.replace(/[^a-z0-9]+/g, '-'), title: text }
  }

  async agentBriefWithCredit(agentId: string) {
    const { user } = this.agentOf(agentId)
    const credit = await this.creditState(user.id)
    return { ...this.agentBrief(agentId), ownerCreditAvailableUsd: credit.available }
  }

  /** Demo path: the agent builds its chain and settles in one call. */
  async purchase(agentId: string, order: { merchantId: string; item: Item; amountCents: number }, prior?: AuthorizationResult) {
    return this.settlePurchase(agentId, await this.buildChain(agentId, order), prior)
  }

  // ------------------------------------------------------------------ repayment

  private async openLoans(u: UserRecord): Promise<LoanState[]> {
    const out: LoanState[] = []
    for (const l of u.loans) {
      const s = await readLoan(this.ledger, l.loanId)
      if (s) out.push(s)
    }
    return out
  }

  /**
   * Repay a loan with LoanPay, then refresh the CreditTier credential in an atomic Batch. (LoanPay itself cannot
   * be batched on the current Devnet build; see submitCredentialRefreshBatch.)
   */
  async repay(userId: string, opts: { full?: boolean; amount?: number } = {}) {
    const u = this.store.user(userId)
    const [loan] = await this.openLoans(u)
    if (!loan) throw new HttpError(409, 'no open loan')
    const record = u.loans.find((l) => l.loanId === loan.loanId)!
    const now = nowUnix()
    const ledgerNow = await this.ledger.ledgerTime()
    const due = loan.nextPaymentDueDate !== undefined ? loan.nextPaymentDueDate + 946_684_800 : undefined
    const full = !!opts.full
    const late = !full && due !== undefined && ledgerNow > due
    const outcome: 'early' | 'on_time' | 'late' = full ? 'early' : late ? 'late' : 'on_time'
    const amount = full ? await payoffAmount(this.ledger, loan.loanId) : (opts.amount ?? Math.ceil(loan.periodicPayment * 1e6) / 1e6)

    const projected = await this.rescore(userId, [{ type: 'repayment', ts: now, outcome }])
    if (!projected.tier) throw new HttpError(403, projected.reasons.join('; '))
    const tier = projected.tier

    const existing = await existingTiers(this.ledger, u.account, this.service.address)
    const refresh = tierRefreshTransactions({ service: this.service.address, user: u.account, tier, existing, now })
    const payRes = await this.ledger.submit(
      {
        TransactionType: 'LoanPay',
        Account: u.account,
        LoanID: loan.loanId,
        Amount: tokenAmount(this.infra, amount.toFixed(6).replace(/\.?0+$/, '')),
        ...(full ? { Flags: TF_LOAN_FULL_PAYMENT } : late ? { Flags: 0x40000 } : {}),
      },
      this.userWallet(u),
    )
    const payHash = payRes.result.hash
    // The repayment is on the ledger: record it before anything else can fail.
    u.events.push({ type: 'repayment', ts: now, outcome, txHash: payHash })
    let refreshHash: string | undefined
    try {
      refreshHash = await submitCredentialRefreshBatch(this.ledger, this.userWallet(u), this.service, {
        serviceTxs: refresh.service, userTxs: refresh.user,
      })
    } catch {
      // Reconciled by the next syncTier(): the score already counts the repayment.
    }
    record.paymentsMade += 1
    const afterRaw = await readLoan(this.ledger, loan.loanId)
    // A fully paid loan can linger on the ledger with nothing outstanding.
    const after = afterRaw && afterRaw.totalValueOutstanding > 1e-6 ? afterRaw : null
    record.outstanding = after?.principalOutstanding ?? 0
    if (!after) record.closedAt = now
    const held = await currentTier(this.ledger, u.account, this.service.address)
    u.tier = held?.tier
    u.tierExpiresAt = held?.expiresAt
    this.pushUtilization(u, await this.creditState(userId))
    this.store.save()
    const rescored = await this.rescore(userId)
    return { txHash: payHash, refreshTxHash: refreshHash, outcome, paid: amount, tier: held?.tier ?? tier, score: rescored.score, loanClosed: !after, credentialRefreshed: !!refreshHash }
  }

  /** Mark installments that are past due plus the grace period as late. Idempotent per due date. */
  async sweepLate(userId: string): Promise<number> {
    const u = this.store.user(userId)
    const t = await this.ledger.ledgerTime()
    let flagged = 0
    for (const l of await this.openLoans(u)) {
      const raw = l.raw as { NextPaymentDueDate?: number; GracePeriod?: number }
      if (raw.NextPaymentDueDate === undefined) continue
      const dueUnix = raw.NextPaymentDueDate + 946_684_800
      if (t > dueUnix + (raw.GracePeriod ?? 0) && !u.lateFlaggedDue.includes(dueUnix)) {
        u.lateFlaggedDue.push(dueUnix)
        u.events.push({ type: 'repayment', ts: nowUnix(), outcome: 'late' })
        flagged++
      }
    }
    if (flagged) this.store.save()
    return flagged
  }

  /** Release the network-side funds (AP4M: RLUSD to the merchant payout wallet) and close the channel. */
  async settleNetwork(opts: { close?: boolean } = {}) {
    const a = this.d.authorizer
    if (!a.settle) return { settled: false as const }
    const settlement = await a.settle()
    const closeTx = opts.close && a.close ? await a.close() : undefined
    return { settled: true as const, ...settlement, closeTx }
  }

  /** Demo only: the user's own income arriving, so they can repay more than the borrowed balance they have left. */
  async demoTopUp(userId: string, amount: number): Promise<string> {
    const u = this.store.user(userId)
    const issuer = this.issuer()
    const res = await this.ledger.submit(
      { TransactionType: 'Payment', Account: issuer.address, Destination: u.account, Amount: tokenAmount(this.infra, amount) },
      issuer,
    )
    return res.result.hash
  }

  // ------------------------------------------------------------------ views

  async profile(userId: string) {
    const u = this.store.user(userId)
    const [score, credit, kya, tierCred] = await Promise.all([
      this.rescore(userId),
      this.creditState(userId),
      kyaStatus(this.ledger, u.account, this.service.address),
      currentTier(this.ledger, u.account, this.service.address),
    ])
    const per = await Promise.all(Object.values(u.agents).map(async (a) => ({
      id: a.id, label: a.label, account: a.account, did: a.did, mode: a.mode, status: a.status,
      spendingAccount: a.pot.account,
      // What a stolen agent key could reach right now: ~0 between purchases.
      spendingBalance: await tokenBalance(this.ledger, this.infra, a.pot.account),
      spentUsd: a.spentCents / 100, budgetUsd: a.budgetCents / 100, maxPerPurchaseUsd: a.maxCents / 100,
      purchases: u.purchases.filter((p) => p.agentId === a.id).length,
    })))
    this.store.save()
    return {
      user: { id: u.id, account: u.account, did: u.did, mainnetAccount: u.mainnetAccount, mainnetVerified: u.mainnetVerified },
      networks: { history: 'mainnet', credit: 'devnet' },
      kya: { valid: kya.valid, expiresAt: kya.expiresAt },
      score: { value: score.score, tier: score.tier, rawTier: score.rawTier, terms: score.terms, reasons: score.reasons, ignored: score.ignored.length },
      credential: tierCred,
      credit,
      agents: per,
      loans: await Promise.all(u.loans.map(async (l) => ({ ...l, state: await readLoan(this.ledger, l.loanId).then((s) => s && { principalOutstanding: s.principalOutstanding, paymentsRemaining: s.paymentsRemaining, nextPaymentDueDate: s.nextPaymentDueDate }) }))),
      purchases: u.purchases.map(({ chain: _c, ...p }) => p),
      pending: u.pending.map(({ chain: _c, ...p }) => p),
      alerts: this.alerts.filter((a) => Object.keys(u.agents).includes(a.agentId)),
      breakdown: score.contributions,
    }
  }

  /** Re-exported helpers used by scripts/tests. */
  issuer() { return issuerWallet(this.infra) }
  serviceAddress() { return this.service.address }
  domains() { return this.infra.domains }
  ripple = ripple
}

export { credentialTypes, tierStatus }
