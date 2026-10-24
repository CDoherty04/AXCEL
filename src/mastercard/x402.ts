import type { PaymentChannel, RedeemResult } from './channel.js'
import { X402_ASSET } from './channel.js'

/** One purchasable resource. Price is RLUSD in 18-decimal atomic units. */
export interface X402Resource {
  id: string
  description: string
  mimeType: string
  price: bigint
  title: string
  body: string
}

export const X402_RESOURCES: Record<string, X402Resource> = {
  briefing: {
    id: 'briefing',
    description: 'Agent credit briefing',
    mimeType: 'application/json',
    price: 10n ** 17n,
    title: 'Agent credit briefing',
    body: 'Released when the voucher was redeemed. Merchant RLUSD has not been settled yet.',
  },
  archive: {
    id: 'archive',
    description: 'Full archive',
    mimeType: 'application/json',
    price: 5n * 10n ** 18n,
    title: 'Full archive',
    body: 'Released only when a voucher covering this price is redeemed.',
  },
}

export interface PaymentRequirement {
  scheme: 'exact'
  network: string
  /** Atomic RLUSD units, decimal string. */
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra: {
    name: typeof X402_ASSET
    channelId: string
    paymentLedger: string
    channelCap: string
    redeemed: string
    cumulative: true
  }
}

/** The HTTP 402 body. `accepts` is the payment terms an agent pays against. */
export interface PaymentRequirements {
  x402Version: 1
  error: string
  accepts: PaymentRequirement[]
  declineReason?: string
}

export interface PaymentPayload {
  x402Version: 1
  scheme: 'exact'
  network: string
  payload: {
    resource: string
    channelId: string
    claimId: string
    txHash: string
    cumulativeAmount: string
    signature?: string
  }
}

export interface VoucherProof {
  signed: boolean
  signature?: string
  claimId: string
  txHash: string
  cumulativeAmount: string
  channelId: string
}

interface StoredClaim {
  resourceId: string
  channelId: string
  claimId: string
  txHash: string
  cumulative: bigint
  price: bigint
  signature?: string
}

export interface ReleasedResource {
  id: string
  title: string
  body: string
  mimeType: string
  released: true
}

export type AccessResult =
  | { status: 402; body: PaymentRequirements }
  | { status: 200; body: ReleasedResource }
  | { status: 404; body: { error: string } }

export interface PaidAccess {
  status: 200
  body: ReleasedResource
  requirements: PaymentRequirements
  voucher: VoucherProof
  header: string
  /** True when the body was returned before channel settlement. */
  released: true
  settledBeforeRelease: boolean
}

export interface DeclinedAccess {
  status: 402
  body: PaymentRequirements
  declined: true
  reason: string
  redeemedUnchanged: boolean
}

export type PayResult = PaidAccess | DeclinedAccess | { status: 404; body: { error: string } }

export interface SlideProof {
  control: {
    pspAttestedIdentity: boolean
    identity: { agentId: string; address: string; source: 'psp' | 'local' }
    fundedChannelCap: boolean
    channel: { channelId: string; cap: string; redeemed: string; asset: string }
    overCapRejected: boolean
    overCap: { price: string; reason: string; redeemedUnchanged: boolean }
  }
  payment: {
    requirements: PaymentRequirements
    voucher: VoucherProof
    released: true
    settledBeforeRelease: false
    resource: ReleasedResource
  }
  proof: {
    voucherRedeemed: { claimId: string; txHash: string }
    claimPaid: { tx?: string }
    settlementRecorded: { tx?: string }
    receipt: {
      channelId: string
      claimId: string
      payoutTx?: string
      settlementTx?: string
      receiptUrl?: string
    }
  }
}

export function encodePayment(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodePayment(header: string): PaymentPayload | undefined {
  try {
    const value = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as PaymentPayload
    if (value?.x402Version !== 1 || !value.payload?.claimId || !value.payload.channelId) return undefined
    return value
  } catch {
    return undefined
  }
}

/**
 * Serves a resource for an HTTP 402 payment.
 * No `X-PAYMENT` header yields the requirements. A redeemed voucher releases the resource immediately.
 * Settlement is a later call and is what produces ClaimPaid and SettlementRecorded.
 */
export class Paywall {
  private readonly claims = new Map<string, StoredClaim>()
  private settled = false

  constructor(readonly channel: PaymentChannel) {}

  /** The 402 body for `resourceId`, using `price` when the caller names an amount (the over-cap attempt). */
  async challenge(resourceId: string, price?: bigint): Promise<PaymentRequirements | { status: 404; body: { error: string } }> {
    const resource = X402_RESOURCES[resourceId]
    if (!resource) return { status: 404, body: { error: `unknown resource ${resourceId}` } }
    const state = await this.channel.open()
    return requirementsFor(resource, state, price ?? resource.price)
  }

  async access(resourceId: string, paymentHeader?: string): Promise<AccessResult> {
    const resource = X402_RESOURCES[resourceId]
    if (!resource) return { status: 404, body: { error: `unknown resource ${resourceId}` } }
    const requirements = await this.challenge(resourceId)
    if ('status' in requirements) return requirements
    if (!paymentHeader) return { status: 402, body: requirements }

    const parsed = decodePayment(paymentHeader)
    const claim = parsed ? this.claims.get(parsed.payload.claimId) : undefined
    const state = await this.channel.state()
    const matches = claim
      && parsed
      && claim.resourceId === resourceId
      && claim.channelId === state.channelId
      && parsed.payload.channelId === state.channelId
      && parsed.payload.resource === resourcePath(resourceId)
      && claim.price === resource.price
    if (!matches) {
      return { status: 402, body: { ...requirements, error: 'X-PAYMENT header is invalid' } }
    }
    return { status: 200, body: release(resource) }
  }

  /** Read the 402 terms, redeem a voucher for that price, and release the resource if the cap allows it. */
  async pay(resourceId: string, price?: bigint): Promise<PayResult> {
    const resource = X402_RESOURCES[resourceId]
    if (!resource) return { status: 404, body: { error: `unknown resource ${resourceId}` } }
    const asked = price ?? resource.price
    const before = await this.channel.state()
    const challenge = await this.challenge(resourceId, asked)
    if ('status' in challenge) return challenge

    const redeemed = await this.channel.redeem(asked)
    if (!redeemed.approved) {
      const after = await this.channel.state()
      return {
        status: 402,
        body: { ...challenge, error: 'payment declined', declineReason: redeemed.reason },
        declined: true,
        reason: redeemed.reason,
        redeemedUnchanged: after.redeemed === before.redeemed,
      }
    }
    return this.accept(resource, challenge, redeemed, asked)
  }

  /**
   * Attempt a voucher for one atomic unit past the remaining cap.
   * The comparison is strict, so this cannot be a successful redeem on a consistent channel.
   */
  async rejectOverCap(): Promise<DeclinedAccess | { status: 404; body: { error: string } }> {
    const state = await this.channel.state()
    const price = state.cap - state.redeemed + 1n
    const result = await this.pay('archive', price)
    if (result.status === 404) return result
    if (result.status === 200) {
      throw new Error('over-cap voucher was redeemed')
    }
    return result
  }

  async settle(claimId: string): Promise<SlideProof['proof']> {
    const claim = this.claims.get(claimId)
    if (!claim) throw new Error(`unknown claim ${claimId}`)
    const settled = await this.channel.settle()
    this.settled = true
    return {
      voucherRedeemed: { claimId: claim.claimId, txHash: claim.txHash },
      claimPaid: { tx: settled.settlementTx },
      settlementRecorded: { tx: settled.payoutTx },
      receipt: {
        channelId: claim.channelId,
        claimId: claim.claimId,
        payoutTx: settled.payoutTx,
        settlementTx: settled.settlementTx,
        receiptUrl: settled.receiptUrl,
      },
    }
  }

  private accept(resource: X402Resource, requirements: PaymentRequirements, redeemed: Extract<RedeemResult, { approved: true }>, price: bigint): PaidAccess {
    const settledBeforeRelease = this.settled
    const claim: StoredClaim = {
      resourceId: resource.id,
      channelId: redeemed.channelId,
      claimId: redeemed.claimId,
      txHash: redeemed.txHash,
      cumulative: redeemed.cumulative,
      price,
      signature: redeemed.signature,
    }
    this.claims.set(claim.claimId, claim)
    const payload: PaymentPayload = {
      x402Version: 1,
      scheme: 'exact',
      network: requirements.accepts[0]?.network ?? 'xrpl-evm-testnet',
      payload: {
        resource: resourcePath(resource.id),
        channelId: redeemed.channelId,
        claimId: redeemed.claimId,
        txHash: redeemed.txHash,
        cumulativeAmount: redeemed.cumulative.toString(),
        signature: redeemed.signature,
      },
    }
    return {
      status: 200,
      body: release(resource),
      requirements,
      voucher: {
        signed: Boolean(redeemed.signature) || Boolean(redeemed.txHash),
        signature: redeemed.signature,
        claimId: redeemed.claimId,
        txHash: redeemed.txHash,
        cumulativeAmount: redeemed.cumulative.toString(),
        channelId: redeemed.channelId,
      },
      header: encodePayment(payload),
      released: true,
      settledBeforeRelease,
    }
  }
}

/** Control, payment, and proof for the hackathon slide. Settlement runs only after the resource is released. */
export async function runSlideProof(paywall: Paywall): Promise<SlideProof> {
  const identity = await paywall.channel.identity()
  const channel = await paywall.channel.open()
  const over = await paywall.rejectOverCap()
  if (over.status !== 402) throw new Error('over-cap attempt was not rejected')

  const paid = await paywall.pay('briefing')
  if (paid.status !== 200) {
    const reason = paid.status === 402 ? paid.reason : paid.body.error
    throw new Error(`briefing was not released: ${reason}`)
  }
  if (paid.settledBeforeRelease) throw new Error('resource was released only after settlement')

  const proof = await paywall.settle(paid.voucher.claimId)
  return {
    control: {
      pspAttestedIdentity: identity.attested,
      identity: { agentId: identity.agentId, address: identity.address, source: identity.source },
      fundedChannelCap: channel.cap > 0n,
      channel: {
        channelId: channel.channelId,
        cap: formatUnits(channel.cap),
        redeemed: formatUnits(channel.redeemed),
        asset: channel.asset,
      },
      overCapRejected: true,
      overCap: { price: formatUnits(channel.cap - channel.redeemed + 1n), reason: over.reason, redeemedUnchanged: over.redeemedUnchanged },
    },
    payment: {
      requirements: paid.requirements,
      voucher: paid.voucher,
      released: true,
      settledBeforeRelease: false,
      resource: paid.body,
    },
    proof,
  }
}

export function resourcePath(id: string): string {
  return `/x402/resources/${id}`
}

function requirementsFor(resource: X402Resource, state: Awaited<ReturnType<PaymentChannel['state']>>, price: bigint): PaymentRequirements {
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [{
      scheme: 'exact',
      network: state.network,
      maxAmountRequired: price.toString(),
      resource: resourcePath(resource.id),
      description: resource.description,
      mimeType: resource.mimeType,
      payTo: state.payTo,
      maxTimeoutSeconds: 60,
      asset: state.asset,
      extra: {
        name: X402_ASSET,
        channelId: state.channelId,
        paymentLedger: state.paymentLedger,
        channelCap: state.cap.toString(),
        redeemed: state.redeemed.toString(),
        cumulative: true,
      },
    }],
  }
}

function release(resource: X402Resource): ReleasedResource {
  return { id: resource.id, title: resource.title, body: resource.body, mimeType: resource.mimeType, released: true }
}

function formatUnits(value: bigint): string {
  const whole = value / 10n ** 18n
  const frac = value % 10n ** 18n
  const digits = frac.toString().padStart(18, '0').replace(/0+$/, '')
  return digits.length === 0 ? whole.toString() : `${whole}.${digits}`
}
