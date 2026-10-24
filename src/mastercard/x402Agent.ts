import type { RedeemResult } from './channel.js'
import { encodePayment, type PaymentPayload, type PaymentRequirements, type ReleasedResource, type SlideProof, type VoucherProof } from './x402.js'

export interface AgentPayResult {
  resourceId: string
  requirements: PaymentRequirements
  /** Set when the agent refused to pay. Nothing was redeemed. */
  declined?: string
  resource?: ReleasedResource
  voucher?: VoucherProof
  paymentHeader?: string
  rlusd?: string
  settlement?: SlideProof['proof']
}

/**
 * Separate payer: read the 402, pay only when the price fits the channel, redeem, then present the voucher.
 * Redeem is injected so this never calls the merchant's own pay route.
 */
export async function agentPay(opts: {
  baseUrl: string
  resourceId: string
  redeem: (additional: bigint) => Promise<RedeemResult>
  settle?: (claimId: string) => Promise<SlideProof['proof']>
  fetchFn?: typeof fetch
  log?: (line: string) => void
}): Promise<AgentPayResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const base = opts.baseUrl.replace(/\/$/, '')
  const url = `${base}/x402/resources/${opts.resourceId}`
  const log = opts.log ?? (() => {})

  const challenge = await fetchFn(url)
  const body = await challenge.json() as PaymentRequirements | ReleasedResource | { error?: string }
  if (challenge.status === 200 && 'title' in body) {
    return { resourceId: opts.resourceId, requirements: { x402Version: 1, error: '', accepts: [] }, resource: body }
  }
  if (challenge.status !== 402 || !('accepts' in body) || !body.accepts[0]) {
    throw new Error(`expected HTTP 402, got ${challenge.status}`)
  }
  const requirements = body
  const accept = requirements.accepts[0]
  const price = BigInt(accept.maxAmountRequired)
  const redeemed = BigInt(accept.extra.redeemed)
  const cap = BigInt(accept.extra.channelCap)
  log(`402 ${opts.resourceId} ${formatRlusd(price)} RLUSD (${formatRlusd(redeemed)} of ${formatRlusd(cap)} used)`)

  if (redeemed + price > cap) {
    const declined = `price ${formatRlusd(price)} RLUSD would pass the channel cap`
    log(`refused: ${declined}`)
    return { resourceId: opts.resourceId, requirements, declined }
  }
  log('decided to pay')

  const result = await opts.redeem(price)
  if (!result.approved) {
    log(`refused: ${result.reason}`)
    return { resourceId: opts.resourceId, requirements, declined: result.reason }
  }

  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: accept.network,
    payload: {
      resource: accept.resource,
      channelId: result.channelId,
      claimId: result.claimId,
      txHash: result.txHash,
      cumulativeAmount: result.cumulative.toString(),
      signature: result.signature,
    },
  }
  const paymentHeader = encodePayment(payload)
  const voucher: VoucherProof = {
    signed: Boolean(result.signature) || Boolean(result.txHash),
    signature: result.signature,
    claimId: result.claimId,
    txHash: result.txHash,
    cumulativeAmount: result.cumulative.toString(),
    channelId: result.channelId,
  }
  log(`redeemed ${result.claimId} ${result.txHash}`)

  const unlocked = await fetchFn(url, { headers: { 'X-PAYMENT': paymentHeader } })
  const released = await unlocked.json() as ReleasedResource & { error?: string }
  if (unlocked.status !== 200 || !released.title) {
    throw new Error(released.error || `resource stayed locked (${unlocked.status})`)
  }
  log(`released: ${released.title}`)

  const settlement = opts.settle ? await opts.settle(result.claimId) : undefined
  if (settlement) log(`settled ${settlement.receipt.payoutTx ?? settlement.receipt.settlementTx ?? settlement.receipt.claimId}`)
  return {
    resourceId: opts.resourceId,
    requirements,
    resource: released,
    voucher,
    paymentHeader,
    rlusd: formatRlusd(price),
    settlement,
  }
}

function formatRlusd(atomic: bigint): string {
  const whole = atomic / 10n ** 18n
  const frac = (atomic % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}
