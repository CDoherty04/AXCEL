/**
 * End-to-end demo on Devnet, following the demo script in CLAUDE.md.
 * History is a fixed "Mainnet" fixture (a real run points MAINNET_ACCOUNT at a QuickNode-backed reader).
 */
import { Wallet } from 'xrpl'
import { DAY } from '../src/config.js'
import { createService, StaticHistoryReader } from '../src/bootstrap.js'
import { HttpError } from '../src/store/state.js'

const say = (s: string) => console.log(`\n== ${s}`)
const show = (k: string, v: unknown) => console.log(`   ${k}:`, typeof v === 'string' ? v : JSON.stringify(v))

const mainnetUser = Wallet.generate()
const now = Math.floor(Date.now() / 1000)
const history = new StaticHistoryReader({
  [mainnetUser.address]: {
    firstActivityAt: now - 300 * DAY,
    fundingSource: 'rFundingSourceExampleXXXXXXXXXXXXXXX',
    events: Array.from({ length: 20 }, (_, i) => ({
      type: 'plain_payment' as const,
      ts: now - Math.floor((i + 1) * 2.25 * DAY),
      merchant: `rMainnetPayee${i % 8}`,
      value: 5,
      txHash: `MAINNET-${i}`,
    })),
  },
})

const w = await createService({ mainnetHistory: history, log: (m) => console.log('   ', m) })
const { service } = w

try {
  say('Setup: three merchants accept RLUSD-stand-in (TUSD) on Devnet')
  const shop = await service.registerMerchant({ name: 'Acme Outfitters', website: 'https://acme.example' })
  const api = await service.registerMerchant({ name: 'DataStream API', website: 'https://datastream.example' })
  const cloud = await service.registerMerchant({ name: 'Nimbus Compute', website: 'https://nimbus.example' })

  say('1. Cold start')
  const user = await service.createUser()
  show('user', { id: user.id, account: user.account, did: user.did })
  const ch = service.startLink(user.id, mainnetUser.address)
  service.confirmLink(user.id, service.demoSignLink(user.id, mainnetUser))
  show('ownership', 'both accounts signed the challenge')
  show('kya', await service.verifyOwner(user.id, { legalName: 'Ada Example', country: 'US', documentId: 'P1234567' }))
  const cold = await service.coldStart(user.id)
  show('score', { score: cold.score, tier: cold.tier, P_C: cold.terms.P_C.toFixed(2), reasons: cold.reasons })

  say('2. Borrow')
  const tier = await service.syncTier(user.id)
  show('credential', tier)
  const loan = await service.borrow(user.id)
  show('loan', loan)
  show('credit', await service.creditState(user.id))

  say('3. Link agents')
  const shopper = await service.addAgent(user.id, {
    label: 'Shopping agent (Immediate)', mode: 'immediate', maxCents: 4000, budgetCents: 8000,
    merchantIds: [shop.id], items: [{ id: 'jacket', title: 'Rain jacket' }],
  })
  const buyer = await service.addAgent(user.id, {
    label: 'API-buying agent (Autonomous)', mode: 'autonomous', maxCents: 3000, budgetCents: 6000,
    merchantIds: [api.id, cloud.id], items: [{ id: 'credits', title: 'API credits' }],
  })
  show('agents', [shopper.id, buyer.id])
  show('spending accounts (agents pay from these, never from the user account)', [shopper.pot.account, buyer.pot.account])

  say('4. Spend')
  const p1 = await service.purchase(shopper.id, { merchantId: shop.id, item: { id: 'jacket', title: 'Rain jacket' }, amountCents: 3500 })
  show('immediate purchase', { tx: p1.txHash, amount: p1.amount, score: p1.score })
  const p2 = await service.purchase(buyer.id, { merchantId: api.id, item: { id: 'credits', title: 'API credits' }, amountCents: 2500 })
  show('autonomous purchase', { tx: p2.txHash, amount: p2.amount, score: p2.score })
  const p3 = await service.purchase(buyer.id, { merchantId: cloud.id, item: { id: 'credits', title: 'API credits' }, amountCents: 1800 })
  show('autonomous purchase', { tx: p3.txHash, amount: p3.amount, score: p3.score })

  say('5. Guardrail: out-of-mandate purchase')
  try {
    await service.purchase(buyer.id, { merchantId: api.id, item: { id: 'credits', title: 'API credits' }, amountCents: 9000 })
    throw new Error('expected a refusal')
  } catch (e) {
    if (!(e instanceof HttpError)) throw e
    show('refused', e.message)
  }
  show('credit', await service.creditState(user.id))

  say('6. Repay (Batch: LoanPay + credential refresh)')
  const r1 = await service.repay(user.id)
  show('installment', r1)
  show('income arrives (demo top-up)', await service.demoTopUp(user.id, 150))
  const r2 = await service.repay(user.id, { full: true })
  show('early payoff', r2)

  say('7. Shared credit: tier after repayment, third agent')
  const synced = await service.syncTier(user.id)
  show('credential', synced)
  const loan2 = await service.borrow(user.id)
  show('new loan at the new limit', loan2)
  const third = await service.addAgent(user.id, {
    label: 'Procurement agent (Autonomous)', mode: 'autonomous', maxCents: 20000, budgetCents: 50000,
    merchantIds: [cloud.id], items: [{ id: 'credits', title: 'API credits' }],
  })
  const p4 = await service.purchase(third.id, { merchantId: cloud.id, item: { id: 'credits', title: 'API credits' }, amountCents: 15000 })
  show('third agent, first purchase', { tx: p4.txHash, amount: p4.amount, score: p4.score })

  say('8. Revoke: delegation removed, payer credential deleted, pot swept')
  show('revoke', await service.revokeAgent(buyer.id))
  try {
    await service.purchase(buyer.id, { merchantId: api.id, item: { id: 'credits', title: 'API credits' }, amountCents: 500 })
    throw new Error('expected a refusal')
  } catch (e) {
    if (!(e instanceof HttpError)) throw e
    show('after revoke', e.message)
  }

  say('Dashboard')
  const prof = await service.profile(user.id)
  show('score', prof.score)
  show('credit', prof.credit)
  show('agents', prof.agents.map((a) => `${a.label}: $${a.spentUsd} of $${a.budgetUsd}`))
  void ch
} finally {
  await w.close()
}
