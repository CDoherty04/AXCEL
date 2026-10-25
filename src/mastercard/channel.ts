import { ethers } from 'ethers'
import { Ap4mSession, type Ap4mSdk } from './ap4m.js'

export const X402_NETWORK = 'xrpl-evm-testnet'
export const X402_CHAIN_ID = 1449000
export const X402_ASSET = 'RLUSD'

const VOUCHER_TYPES = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
  ],
}

export interface ChannelState {
  channelId: string
  cap: bigint
  redeemed: bigint
  asset: string
  network: string
  payTo: string
  paymentLedger: string
}

export interface AttestedIdentity {
  agentId: string
  address: string
  /** True when a PSP sign-in returned a registered agent id. The local channel is a stand-in and reports false. */
  attested: boolean
  source: 'psp' | 'local'
}

export type RedeemResult =
  | { approved: false; reason: string }
  | {
      approved: true
      claimId: string
      txHash: string
      signature?: string
      cumulative: bigint
      channelId: string
    }

export interface SettlementProof {
  settlementTx?: string
  payoutTx?: string
  receiptUrl?: string
}

/** The channel a voucher is drawn against. Local for tests and the offline demo; AP4M for the hackathon service. */
export interface PaymentChannel {
  identity(): Promise<AttestedIdentity>
  open(): Promise<ChannelState>
  state(): Promise<ChannelState>
  /** Redeem `additional` RLUSD units. An amount past the cap is refused before a voucher is submitted. */
  redeem(additional: bigint): Promise<RedeemResult>
  settle(): Promise<SettlementProof>
}

const LOCAL_LEDGER = `0x${'22'.repeat(20)}`
const LOCAL_PAYTO = `0x${'33'.repeat(20)}`
const LOCAL_KEY = `0x${'ab'.repeat(32)}`

/** In-process channel with a real EIP-712 voucher signature and the same cap check as the ledger. */
export class LocalPaymentChannel implements PaymentChannel {
  private readonly wallet = new ethers.Wallet(LOCAL_KEY)
  private readonly channelId = ethers.id('bec-demo-channel')
  private redeemed = 0n
  constructor(private readonly cap: bigint = 20n * 10n ** 18n) {}

  async identity(): Promise<AttestedIdentity> {
    return { agentId: this.wallet.address, address: this.wallet.address, attested: false, source: 'local' }
  }

  async open(): Promise<ChannelState> {
    return this.view()
  }

  async state(): Promise<ChannelState> {
    return this.view()
  }

  async redeem(additional: bigint): Promise<RedeemResult> {
    if (additional <= 0n) return { approved: false, reason: 'amount rounds to zero RLUSD' }
    if (this.redeemed + additional > this.cap) {
      return {
        approved: false,
        reason: `channel cap reached (${ethers.formatUnits(this.redeemed, 18)} of ${ethers.formatUnits(this.cap, 18)} RLUSD)`,
      }
    }
    const cumulative = this.redeemed + additional
    const signature = await this.wallet.signTypedData(
      { name: 'AP4M Payment Ledger', version: '1', chainId: X402_CHAIN_ID, verifyingContract: LOCAL_LEDGER },
      VOUCHER_TYPES,
      { channelId: this.channelId, cumulativeAmount: cumulative },
    )
    this.redeemed = cumulative
    const txHash = ethers.keccak256(signature)
    return {
      approved: true,
      claimId: ethers.keccak256(ethers.toUtf8Bytes(`voucher:${signature}`)),
      txHash,
      signature,
      cumulative,
      channelId: this.channelId,
    }
  }

  async settle(): Promise<SettlementProof> {
    return {
      settlementTx: ethers.keccak256(ethers.toUtf8Bytes(`ClaimPaid:${this.channelId}:${this.redeemed}`)),
      payoutTx: ethers.keccak256(ethers.toUtf8Bytes(`SettlementRecorded:${this.channelId}:${this.redeemed}`)),
    }
  }

  private view(): ChannelState {
    return {
      channelId: this.channelId,
      cap: this.cap,
      redeemed: this.redeemed,
      asset: X402_ASSET,
      network: X402_NETWORK,
      payTo: LOCAL_PAYTO,
      paymentLedger: LOCAL_LEDGER,
    }
  }
}

/** Live Agent Pay for Machines channel. Cap checks happen before `redeemVoucher` is submitted. */
export class Ap4mPaymentChannel implements PaymentChannel {
  constructor(private readonly session: Ap4mSession) {}

  async identity(): Promise<AttestedIdentity> {
    const team = await this.session.teamInfo()
    const agentId = String(team.agent_id ?? '')
    return { agentId, address: this.session.wallet.address, attested: agentId.length > 0, source: 'psp' }
  }

  async open(): Promise<ChannelState> {
    await this.session.ensureChannel()
    return this.state()
  }

  async state(): Promise<ChannelState> {
    const { paymentLedger } = await this.session.serviceConfig()
    const channelId = await this.session.ensureChannel()
    const onchain = await this.sdk.getChannelState(await this.session.provider(), paymentLedger, channelId)
    const team = await this.session.teamInfo()
    return {
      channelId,
      cap: onchain.cap,
      redeemed: onchain.redeemed,
      asset: X402_ASSET,
      network: X402_NETWORK,
      payTo: String(team.merchant_id ?? team.payout_wallet ?? this.session.wallet.address),
      paymentLedger,
    }
  }

  async redeem(additional: bigint): Promise<RedeemResult> {
    if (additional <= 0n) return { approved: false, reason: 'amount rounds to zero RLUSD' }
    const current = await this.state()
    if (current.redeemed + additional > current.cap) {
      return {
        approved: false,
        reason: `channel cap reached (${ethers.formatUnits(current.redeemed, 18)} of ${ethers.formatUnits(current.cap, 18)} RLUSD)`,
      }
    }
    const cumulative = current.redeemed + additional
    const { rpcUrl, paymentLedger } = await this.session.serviceConfig()
    const provider = await this.session.provider()
    const signer = this.session.wallet.connect(provider)
    const signature = this.sdk.signVoucher
      ? await this.sdk.signVoucher(signer, paymentLedger, current.channelId, cumulative)
      : undefined
    const redeemed = await this.sdk.redeemVoucher(signer, paymentLedger, rpcUrl, current.channelId, cumulative)
    const recorded = await this.session.recordRedemption(redeemed.txHash)
    return {
      approved: true,
      claimId: recorded.claim_id ?? redeemed.claimId ?? redeemed.txHash,
      txHash: redeemed.txHash,
      signature: redeemed.signature ?? signature,
      cumulative,
      channelId: current.channelId,
    }
  }

  async settle(): Promise<SettlementProof> {
    const token = await this.session.login()
    const channelId = await this.session.ensureChannel()
    const settled = await this.sdk.settle(this.session.cfg.apiUrl, token, channelId)
    return {
      settlementTx: settled.settlement_tx,
      payoutTx: settled.payout_tx,
      receiptUrl: settled.receipt_url ? this.session.cfg.apiUrl + settled.receipt_url : undefined,
    }
  }

  private get sdk(): Ap4mSdk {
    return this.session.sdk
  }
}
