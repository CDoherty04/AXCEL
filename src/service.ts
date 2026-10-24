import { randomUUID } from 'node:crypto'
import { Wallet } from 'xrpl'
import { credentialTypes, hex, publicUrl, tiers, type Tier } from './config.js'
import { issuerWallet, serviceWallet, tokenAmount } from './credit/infra.js'
import { delegatePayment, revokeDelegation } from './credit/delegation.js'
import {
  openLoan, payoffAmount, readLoan, submitCredentialRefreshBatch, tokenBalance, TF_LOAN_FULL_PAYMENT, type LoanState,
} from './credit/loans.js'
import { currentTier, existingTiers, issueTierCredential, tierRefreshTransactions } from './credit/tierCredential.js'
import { createChallenge, signChallenge, verifyChallenge } from './identity/challenge.js'
import { agentDocument, didFor, publishDid, userDocument, type DidDocument } from './identity/did.js'
import { issueKya, kyaStatus, tierStatus, type KycProvider } from './identity/kya.js'
import type { AgentRegistry, NetworkAuthorizer } from './mastercard/agentPay.js'
import { findSelfDealing, type MerchantResolver } from './scoring/antiGaming.js'
import { computeScore } from './scoring/engine.js'
import type { HistoryReader } from './scoring/history.js'
import type { ScoreEvent, ScoreResult } from './scoring/types.js'
import { HttpError, type AgentRecord, type MerchantRecord, type Store, type UserRecord } from './store/state.js'
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
}

export interface AgentOptions {
  label: string
  mode: 'immediate' | 'autonomous'
  /** Per-purchase cap in USD cents. For autonomous agents this is the L2 payment.amount max. */
  maxCents: number
  /** Total this agent may spend, USD cents. */
  budgetCents: number
  merchantIds: string[]
  items: Item[]
}

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
const strip = <T extends { seed?: string }>(o: T): Omit<T, 'seed'> => {
  const { seed: _seed, ...rest } = o
  return rest
}

export class CreditService {
  readonly ledger: Ledger
  readonly store: Store
  private readonly base: string

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
    const m: MerchantRecord = { id: `m_${randomUUID().slice(0, 8)}`, ...input, account: wallet.address, seed: wallet.seed! }
    this.store.state.merchants[m.id] = m
    this.store.save()
    return strip(m)
  }

  // ------------------------------------------------------------------ users and identity

  /** Create the user's Devnet account, VI keys, Mastercard L1 credential and an XRPL DID. */
  async createUser(id: string = `u_${randomUUID().slice(0, 8)}`): Promise<Omit<UserRecord, 'seed'>> {
    if (this.store.state.users[id]) throw new HttpError(409, `user ${id} exists`)
    const wallet = await this.ledger.fund()
    const viUserKey = await this.d.vi.keygen()
    const did = didFor(wallet.address)
    const l1 = await this.d.vi.issueL1({ issuer: this.infra.viIssuer, userPublicJwk: viUserKey.public_jwk, subject: did })
    const user: UserRecord = {
      id, account: wallet.address, seed: wallet.seed!, mainnetVerified: false, did, viUserKey, l1,
      accountCreatedAt: nowUnix(), agents: {}, events: [], loans: [], purchases: [], excludedMerchants: [],
      fundingSources: [], lateFlaggedDue: [],
    }
    this.store.state.users[id] = user
    await this.publishUserDid(user)
    this.store.save()
    return strip(user)
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
      ownedAccounts: [u.account, ...(u.mainnetAccount ? [u.mainnetAccount] : []), ...Object.values(u.agents).map((a) => a.account)],
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

  async addAgent(userId: string, opts: AgentOptions): Promise<Omit<AgentRecord, 'seed'>> {
    const u = this.store.user(userId)
    const kya = await kyaStatus(this.ledger, u.account, this.service.address)
    if (!kya.valid) throw new HttpError(403, 'owner must hold a valid KYA-Verified credential before linking agents')
    const merchants = opts.merchantIds.map((id) => this.vim(this.merchant(id)))
    const wallet = await this.ledger.fund()
    const viKey = await this.d.vi.keygen()
    const id = `ag_${randomUUID().slice(0, 8)}`
    const did = didFor(wallet.address)
    const { mastercardAgentId } = await this.d.registry.register({
      ownerDid: u.did, agentDid: did, publicKeyThumbprint: String((viKey.public_jwk as { x?: string }).x ?? ''),
    })

    const agent: AgentRecord = {
      id, label: opts.label, account: wallet.address, seed: wallet.seed!, did, kid: id, viKey, mastercardAgentId,
      mode: opts.mode, status: 'active', maxCents: opts.maxCents, budgetCents: opts.budgetCents, spentCents: 0,
      merchants, items: opts.items, createdAt: nowUnix(),
    }
    await delegatePayment(this.ledger, this.userWallet(u), wallet.address)
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
    return strip(agent)
  }

  /** Revoke instantly: remove the delegation and the Mastercard registration. History stays in the score. */
  async revokeAgent(agentId: string): Promise<{ txHash: string }> {
    const { user, agent } = this.agentOf(agentId)
    const txHash = await revokeDelegation(this.ledger, this.userWallet(user), agent.account)
    await this.d.registry.revoke(agent.mastercardAgentId)
    agent.status = 'revoked'
    agent.revokedAt = nowUnix()
    await this.publishUserDid(user)
    this.store.save()
    return { txHash }
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

  /**
   * Verify and settle one purchase. The amount and payee come from the validated chain, never from the request.
   * A purchase scores only after the delegated Payment is validated on XRPL with the chain hash in its Memos.
   */
  async settlePurchase(agentId: string, chain: ViChain) {
    const { user: u, agent } = this.agentOf(agentId)
    if (agent.status !== 'active') throw new HttpError(403, 'agent is revoked')
    if (!(await this.d.registry.isRegistered(agent.mastercardAgentId))) throw new HttpError(403, 'agent is not registered with Mastercard')
    const kya = await kyaStatus(this.ledger, u.account, this.service.address)
    if (!kya.valid) throw new HttpError(403, 'owner KYA-Verified credential missing or expired')

    const viHash = chainHash(chain)
    if (u.purchases.some((p) => p.viHash === viHash)) throw new HttpError(409, 'this Verifiable Intent chain was already settled')

    const v = await this.d.vi.validate(chain, this.infra.viIssuer.public_jwk)
    if (!v.valid || v.amount_cents === null || !v.payee) this.refuse(u, agent, `Verifiable Intent rejected: ${v.errors.join('; ') || 'invalid chain'}`)
    if (v.mode !== agent.mode) this.refuse(u, agent, `chain mode ${v.mode} does not match agent mode ${agent.mode}`)

    const merchant = this.store.state.merchants[v.payee!.id]
    if (!merchant) this.refuse(u, agent, `unknown payee ${v.payee!.id}`)
    const amountCents = v.amount_cents!
    if (agent.spentCents + amountCents > agent.budgetCents) this.refuse(u, agent, 'agent budget exceeded')

    const cs = await this.creditState(u.id)
    if (!cs.tier) throw new HttpError(403, 'no valid CreditTier credential')
    const amount = amountCents / 100
    if (cs.spendOutstanding + amount > cs.creditLine) throw new HttpError(402, `purchase would exceed the credit line (${cs.creditLine})`)
    if (cs.balance < amount) throw new HttpError(402, 'insufficient borrowed balance in the user account')

    const auth = await this.d.authorizer.authorize({
      mastercardAgentId: agent.mastercardAgentId, viHash, amountCents, currency: 'USD', merchantId: merchant!.id, mode: v.mode!,
    })
    if (!auth.approved) throw new HttpError(402, `network declined: ${auth.declineReason}`)

    const tx: any = await this.ledger.client.autofill({
      TransactionType: 'Payment',
      Account: u.account,
      Delegate: agent.account,
      Destination: merchant!.account,
      Amount: tokenAmount(this.infra, cents(amountCents)),
      Memos: [
        { Memo: { MemoType: hex('vi/sha256'), MemoData: viHash } },
        { Memo: { MemoType: hex('agent/did'), MemoData: hex(agent.did) } },
      ],
    })
    const signed = this.agentWallet(agent).sign(tx)
    const res = await this.ledger.submitSigned(signed.tx_blob)
    const txHash = res.result.hash

    const ts = nowUnix()
    u.purchases.push({ id: `p_${randomUUID().slice(0, 8)}`, agentId: agent.id, merchant: merchant!.account, amount, mode: v.mode!, viHash, txHash, ts, chain })
    u.events.push({ type: 'agent_purchase', ts, merchant: merchant!.account, agentId: agent.id, mode: v.mode!, viHash, txHash })
    agent.spentCents += amountCents
    if (agent.spentCents >= agent.budgetCents * 0.95) u.events.push({ type: 'mandate', ts, agentId: agent.id, outcome: 'clean_stop' })
    this.pushUtilization(u, await this.creditState(u.id))
    this.store.save()
    return { txHash, viHash, amount, mode: v.mode!, authorizationId: auth.authorizationId, score: (await this.rescore(u.id)).score }
  }

  /** Demo path: the agent builds its chain and settles in one call. */
  async purchase(agentId: string, order: { merchantId: string; item: Item; amountCents: number }) {
    return this.settlePurchase(agentId, await this.buildChain(agentId, order))
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
    const per = Object.values(u.agents).map((a) => ({
      id: a.id, label: a.label, account: a.account, did: a.did, mode: a.mode, status: a.status,
      spentUsd: a.spentCents / 100, budgetUsd: a.budgetCents / 100, maxPerPurchaseUsd: a.maxCents / 100,
      purchases: u.purchases.filter((p) => p.agentId === a.id).length,
    }))
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
