/** Separate agent: read the paywall's 402, decide, redeem on the agent's own wallet, retry, settle. */
import { loadQuicknodeEnv } from '../src/lib/quicknode.js'
import { Ap4mPaymentChannel, LocalPaymentChannel } from '../src/mastercard/channel.js'
import { Ap4mSession, ap4mConfigFromEnv } from '../src/mastercard/ap4m.js'
import type { PaymentChannel } from '../src/mastercard/channel.js'
import { agentPay } from '../src/mastercard/x402Agent.js'
import type { SlideProof } from '../src/mastercard/x402.js'

loadQuicknodeEnv()

const base = (process.env.X402_URL ?? 'http://127.0.0.1:4020').replace(/\/$/, '')
const resourceId = process.argv[2] ?? 'briefing'
const live = process.env.MASTERCARD_MODE === 'ap4m'
const channel: PaymentChannel = live
  ? new Ap4mPaymentChannel(new Ap4mSession(ap4mConfigFromEnv()))
  : new LocalPaymentChannel()

if (!live) {
  console.log('MASTERCARD_MODE is not ap4m, so this process cannot redeem on the paywall channel.')
  console.log(`Use POST ${base}/x402/agent instead, or set MASTERCARD_MODE=ap4m.`)
  process.exit(1)
}

const result = await agentPay({
  baseUrl: base,
  resourceId,
  redeem: (amount) => channel.redeem(amount),
  settle: async (claimId) => {
    const res = await fetch(`${base}/x402/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimId }),
    })
    const body = await res.json() as SlideProof['proof'] & { error?: string }
    if (!res.ok) throw new Error(body.error ?? `settle failed (${res.status})`)
    return body
  },
  log: (line) => console.log(line),
})

if (result.declined) {
  console.log(`\nrefused: ${result.declined}`)
  process.exit(0)
}
console.log('\nresource:', result.resource?.title)
console.log('claim:   ', result.voucher?.claimId)
console.log('redeem:  ', result.voucher?.txHash)
console.log('payout:  ', result.settlement?.receipt.payoutTx ?? result.settlement?.receipt.settlementTx ?? '(none)')
console.log('receipt: ', result.settlement?.receipt.receiptUrl ?? '(none)')
