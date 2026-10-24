import { Ap4mPaymentChannel, LocalPaymentChannel } from '../src/mastercard/channel.js'
import { Ap4mSession, ap4mConfigFromEnv } from '../src/mastercard/ap4m.js'
import { Paywall, runSlideProof } from '../src/mastercard/x402.js'

const live = process.env.MASTERCARD_MODE === 'ap4m'
const paywall = new Paywall(live ? new Ap4mPaymentChannel(new Ap4mSession(ap4mConfigFromEnv())) : new LocalPaymentChannel())
const proof = await runSlideProof(paywall)

console.log('\nCONTROL')
console.log(
  '  PSP-attested identity:',
  proof.control.pspAttestedIdentity
    ? proof.control.identity.agentId
    : `${proof.control.identity.address} (local stand-in; MASTERCARD_MODE=ap4m uses the PSP record)`,
)
console.log('  Funded channel cap:   ', proof.control.channel.cap, proof.control.channel.asset)
console.log('  Over-cap rejected:    ', proof.control.overCap.reason)

console.log('\nPAYMENT')
console.log('  HTTP 402 requirements:', proof.payment.requirements.accepts[0]?.resource, proof.payment.requirements.accepts[0]?.maxAmountRequired, 'atomic RLUSD')
console.log('  Agent-signed voucher: ', proof.payment.voucher.claimId)
console.log('  Resource released:    ', proof.payment.resource.title)

console.log('\nPROOF')
console.log('  VoucherRedeemed:      ', proof.proof.voucherRedeemed.claimId)
console.log('  ClaimPaid:            ', proof.proof.claimPaid.tx)
console.log('  SettlementRecorded:   ', proof.proof.settlementRecorded.tx)
console.log('  Receipt:              ', `${proof.proof.receipt.channelId} / ${proof.proof.receipt.claimId} / ${proof.proof.receipt.payoutTx}`)
