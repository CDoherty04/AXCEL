import { createRequire } from 'node:module'
import { ethers } from 'ethers'
import type {
  AgentRegistry, AuthorizationRequest, AuthorizationResult, NetworkAuthorizer, SettlementResult,
} from './agentPay.js'

/**
 * Mastercard Agent Pay for Machines (hackathon service at https://hackathon.ap4m.build), built on the SDK in
 * integrations/ap4m/. The service runs on XRPL EVM Testnet (chain 1449000), not on native XRPL Devnet:
 *
 *   sign in (EIP-191 challenge) -> open a payment Channel with an RLUSD cap -> per purchase, sign an EIP-712
 *   cumulative voucher and call redeemVoucher() on the PaymentLedger contract -> POST record-redemption ->
 *   settle (RLUSD released to the merchant payout wallet, receipt) -> close the channel.
 *
 * Mapping to the credit layer: the channel cap is the agent spending limit the credit tier raises (the Agentic
 * Token analogue); one channel serves all of a user's agents, like the single credit line. The native XRPL
 * Devnet Payment that carries the Verifiable Intent hash stays the anchor the score reads; the AP4M claim id is
 * added to its Memos so both legs are linked.
 */

export interface Ap4mSdk {
  signIn(apiUrl: string, teamName: string, wallet: ethers.Wallet): Promise<{ token: string; expiresInSeconds?: number; team?: Record<string, unknown> }>
  requestChannel(apiUrl: string, token: string, wallet: ethers.Wallet, opts: { capRlusd: string; rpcUrl: string; merchantId?: string }): Promise<{ channel_id: string }>
  listChannels(apiUrl: string, token: string): Promise<{ channel_id: string; channel_status: string }[]>
  getChannelState(provider: ethers.Provider, ledger: string, channelId: string): Promise<{ cap: bigint; redeemed: bigint; validBefore: bigint; status: number }>
  redeemVoucher(wallet: ethers.Wallet, ledger: string, rpcUrl: string, channelId: string, cumulative: bigint): Promise<{ claimId: string | null; txHash: string }>
  settle(apiUrl: string, token: string, channelId: string): Promise<{ settlement_tx?: string; payout_tx?: string; receipt_url?: string }>
  closeChannel(apiUrl: string, token: string, wallet: ethers.Wallet, channelId: string): Promise<{ tx_hash?: string }>
}

export class Ap4mNotConfigured extends Error {
  constructor(missing: string[]) {
    super(`Agent Pay for Machines is not configured; missing ${missing.join(', ')} (see .env.example)`)
  }
}

export interface Ap4mConfig {
  apiUrl: string
  teamName: string
  agentPrivateKey: string
  /** Reuse this channel; otherwise an open one is found or a new one is requested. */
  channelId?: string
  /** RLUSD cap when a channel has to be opened. */
  channelCapRlusd: string
  /** Optional merchant id to route the channel to; omit for the team's registered payout wallet. */
  merchantId?: string
  /**
   * RLUSD paid per credit-layer dollar. The demo borrows test dollars (hundreds); a hackathon team has a 20 RLUSD
   * allocation, so 0.01 turns a 35-dollar purchase into 0.35 RLUSD. Use 1 when real amounts fit the allocation.
   */
  amountScale: number
}

export function ap4mConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Ap4mConfig {
  const missing = ['TEAM_NAME', 'AGENT_PRIVATE_KEY'].filter((k) => !env[k])
  if (missing.length) throw new Ap4mNotConfigured(missing)
  const key = env.AGENT_PRIVATE_KEY!.trim()
  return {
    apiUrl: (env.AP4M_API_URL ?? 'https://hackathon.ap4m.build').replace(/\/$/, ''),
    teamName: env.TEAM_NAME!,
    agentPrivateKey: key.startsWith('0x') ? key : `0x${key}`,
    channelId: env.CHANNEL_ID || undefined,
    channelCapRlusd: env.CHANNEL_CAP ?? '5',
    merchantId: env.AP4M_MERCHANT_ID || undefined,
    amountScale: Number(env.AP4M_AMOUNT_SCALE ?? '0.01'),
  }
}

const RLUSD_DECIMALS = 18

/** Shared connection to AP4M: session token, service config, EVM provider and the team's channel. */
export class Ap4mSession {
  readonly wallet: ethers.Wallet
  private token?: { value: string; expiresAt: number }
  private config?: { rpcUrl: string; paymentLedger: string; chainId: number }
  private channelId?: string
  private team?: Record<string, unknown>
  readonly sdk: Ap4mSdk

  constructor(
    readonly cfg: Ap4mConfig,
    sdk?: Ap4mSdk,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.wallet = new ethers.Wallet(cfg.agentPrivateKey)
    this.sdk = sdk ?? (createRequire(import.meta.url)('../../integrations/ap4m/ap4m-hackathon-sdk.cjs') as Ap4mSdk)
    this.channelId = cfg.channelId
  }

  async login(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value
    const s = await this.sdk.signIn(this.cfg.apiUrl, this.cfg.teamName, this.wallet)
    this.token = { value: s.token, expiresAt: Date.now() + (s.expiresInSeconds ?? 600) * 1000 }
    this.team = s.team
    return s.token
  }

  async serviceConfig() {
    if (!this.config) {
      const r = await this.fetchFn(`${this.cfg.apiUrl}/public/config`)
      const j = (await r.json()) as { network: { rpcUrl: string; chainId: number }; contracts: { paymentLedger: string } }
      if (!r.ok) throw new Error(`AP4M /public/config failed (${r.status})`)
      this.config = { rpcUrl: j.network.rpcUrl, paymentLedger: j.contracts.paymentLedger, chainId: j.network.chainId }
    }
    return this.config
  }

  async provider(): Promise<ethers.JsonRpcProvider> {
    return new ethers.JsonRpcProvider((await this.serviceConfig()).rpcUrl)
  }

  /** The team record from sign-in (agent_id, merchant_id, allocation). */
  async teamInfo(): Promise<Record<string, unknown>> {
    await this.login()
    return this.team ?? {}
  }

  /** Reuse the configured or an already-open channel, else open one with the configured cap. */
  async ensureChannel(): Promise<string> {
    if (this.channelId) return this.channelId
    const token = await this.login()
    const open = (await this.sdk.listChannels(this.cfg.apiUrl, token)).find((c) => c.channel_status === 'open')
    if (open) return (this.channelId = open.channel_id)
    const { rpcUrl } = await this.serviceConfig()
    const ch = await this.sdk.requestChannel(this.cfg.apiUrl, token, this.wallet.connect(await this.provider()), {
      capRlusd: this.cfg.channelCapRlusd, rpcUrl, merchantId: this.cfg.merchantId,
    })
    return (this.channelId = ch.channel_id)
  }

  forgetChannel(): void {
    this.channelId = undefined
  }

  async recordRedemption(txHash: string): Promise<{ claim_id?: string }> {
    const token = await this.login()
    const r = await this.fetchFn(`${this.cfg.apiUrl}/public/participant/record-redemption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tx_hash: txHash }),
    })
    const j = (await r.json()) as { claim_id?: string; error?: string }
    if (!r.ok) throw new Error(`AP4M record-redemption failed (${r.status}): ${j.error ?? JSON.stringify(j)}`)
    return j
  }
}

/** Know Your Agent: the AP4M team's registered agent identity backs every agent of the user. */
export class Ap4mAgentRegistry implements AgentRegistry {
  private readonly revoked = new Set<string>()

  constructor(private readonly session: Ap4mSession) {}

  async register(input: { ownerDid: string; agentDid: string }): Promise<{ mastercardAgentId: string }> {
    const team = await this.session.teamInfo()
    const agentId = String(team.agent_id ?? this.session.wallet.address)
    // Each credit-layer agent gets its own handle under the one registered AP4M agent, so revoking one agent
    // does not disable the others.
    return { mastercardAgentId: `${agentId}#${input.agentDid}` }
  }

  async isRegistered(id: string): Promise<boolean> {
    return id.length > 0 && !this.revoked.has(id)
  }

  async revoke(id: string): Promise<void> {
    this.revoked.add(id)
  }
}

/**
 * Authorizes a purchase by redeeming an EIP-712 voucher on the AP4M channel. The voucher is cumulative, so the
 * channel cap (not any single call) bounds total network spend.
 */
export class Ap4mNetworkAuthorizer implements NetworkAuthorizer {
  /** Serializes redemptions: each voucher builds on the previous cumulative amount. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Idempotency by Verifiable Intent hash: a retried purchase never redeems a second voucher. */
  private readonly done = new Map<string, AuthorizationResult>()
  /** Redeemed on-chain but not yet reported to AP4M; a retry only re-reports. */
  private readonly unreported = new Map<string, { txHash: string; claimId: string | null; channelId: string; rlusd: string }>()

  constructor(private readonly session: Ap4mSession) {}

  authorize(req: AuthorizationRequest): Promise<AuthorizationResult> {
    const run = this.queue.then(() => this.redeem(req))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async redeem(req: AuthorizationRequest): Promise<AuthorizationResult> {
    const seen = this.done.get(req.viHash)
    if (seen) return seen
    const { cfg, sdk, wallet } = this.session
    // Integer math: cents x scale / 100, so 3500 cents at scale 0.01 is exactly 0.35 RLUSD.
    const amount = (BigInt(req.amountCents) * ethers.parseUnits(String(cfg.amountScale), RLUSD_DECIMALS)) / 100n
    if (amount <= 0n) return { approved: false, authorizationId: '', declineReason: 'amount rounds to zero RLUSD' }

    let pending = this.unreported.get(req.viHash)
    if (!pending) {
      const { rpcUrl, paymentLedger } = await this.session.serviceConfig()
      const channelId = await this.session.ensureChannel()
      const provider = await this.session.provider()
      const state = await sdk.getChannelState(provider, paymentLedger, channelId)
      if (state.redeemed + amount > state.cap) {
        return { approved: false, authorizationId: '', declineReason: `AP4M channel cap reached (${ethers.formatUnits(state.redeemed, RLUSD_DECIMALS)} of ${ethers.formatUnits(state.cap, RLUSD_DECIMALS)} RLUSD)` }
      }
      const { claimId, txHash } = await sdk.redeemVoucher(wallet, paymentLedger, rpcUrl, channelId, state.redeemed + amount)
      pending = { txHash, claimId, channelId, rlusd: ethers.formatUnits(amount, RLUSD_DECIMALS) }
      this.unreported.set(req.viHash, pending)
    }
    const rec = await this.session.recordRedemption(pending.txHash)
    const id = rec.claim_id ?? pending.claimId ?? pending.txHash
    const result: AuthorizationResult = {
      approved: true,
      authorizationId: id,
      evidence: { network: 'xrpl-evm-testnet', channelId: pending.channelId, redeemTx: pending.txHash, claimId: id, rlusd: pending.rlusd },
    }
    this.unreported.delete(req.viHash)
    this.done.set(req.viHash, result)
    return result
  }

  /** Release the redeemed RLUSD to the merchant payout wallet and fetch the receipt. */
  async settle(): Promise<SettlementResult> {
    const token = await this.session.login()
    const channelId = await this.session.ensureChannel()
    const r = await this.session.sdk.settle(this.session.cfg.apiUrl, token, channelId)
    return { settlementTx: r.settlement_tx, payoutTx: r.payout_tx, receiptUrl: r.receipt_url ? this.session.cfg.apiUrl + r.receipt_url : undefined }
  }

  async close(): Promise<string | undefined> {
    const token = await this.session.login()
    const channelId = await this.session.ensureChannel()
    const r = await this.session.sdk.closeChannel(this.session.cfg.apiUrl, token, this.session.wallet, channelId)
    this.session.forgetChannel()
    return r.tx_hash
  }
}
