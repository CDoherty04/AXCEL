/**
 * Live Devnet checks for the two hardening features:
 *   A. a stolen agent key can reach almost nothing, and the feed guard revokes the agent on first misuse;
 *   B. a purchase that stops part-way is finished exactly once by the reconciler (no double redemption, no double payment).
 * Exits non-zero on the first failed expectation.
 */
import { Wallet } from 'xrpl'
import { createService, StaticHistoryReader } from '../src/bootstrap.js'
import { DAY } from '../src/config.js'
import { tokenAmount } from '../src/credit/infra.js'
import { tokenBalance } from '../src/credit/loans.js'
import { EventFeed } from '../src/feed.js'
import { MockNetworkAuthorizer, type AuthorizationRequest, type NetworkAuthorizer } from '../src/mastercard/agentPay.js'
import { HttpError } from '../src/store/state.js'

let failures = 0
const check = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  (${JSON.stringify(detail)})`}`)
  if (!ok) failures++
}
const say = (s: string) => console.log(`\n== ${s}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Counts how many times the network was actually asked, and can be told to decline. */
class CountingAuthorizer implements NetworkAuthorizer {
  calls = 0
  declineNext = false
  constructor(private readonly inner: NetworkAuthorizer) {}
  async authorize(req: AuthorizationRequest) {
    if (this.declineNext) return { approved: false, authorizationId: '', declineReason: 'limit (test)' }
    this.calls++
    return this.inner.authorize(req)
  }
}

const mainnetUser = Wallet.generate()
const now = Math.floor(Date.now() / 1000)
const history = new StaticHistoryReader({
  [mainnetUser.address]: {
    firstActivityAt: now - 300 * DAY,
    events: Array.from({ length: 20 }, (_, i) => ({
      type: 'plain_payment' as const, ts: now - Math.floor((i + 1) * 2.25 * DAY), merchant: `rMainnetPayee${i % 8}`, value: 5, txHash: `MAINNET-${i}`,
    })),
  },
})

let counting!: CountingAuthorizer
const w = await createService({
  mainnetHistory: history,
  authorizer: (registry) => (counting = new CountingAuthorizer(new MockNetworkAuthorizer(registry))),
  log: (m) => console.log('   ', m),
})
const { service, ledger } = w
const infra = service.store.state.infra!
const item = { id: 'credits', title: 'API credits' }

try {
  say('Setup')
  const shop = await service.registerMerchant({ name: 'Acme', website: 'https://acme.example' })
  const user = await service.createUser()
  service.startLink(user.id, mainnetUser.address)
  service.confirmLink(user.id, service.demoSignLink(user.id, mainnetUser))
  await service.verifyOwner(user.id, { legalName: 'Ada Example', country: 'US', documentId: 'P1234567' })
  await service.coldStart(user.id)
  await service.syncTier(user.id)
  await service.borrow(user.id)
  const agent = await service.addAgent(user.id, {
    label: 'Test agent', mode: 'autonomous', maxCents: 5000, budgetCents: 20000, merchantIds: [shop.id], items: [item],
  })
  const rec = service.store.user(user.id).agents[agent.id]!
  const agentWallet = Wallet.fromSeed(rec.seed)
  const merchantAccount = service.store.state.merchants[shop.id]!.account
  const bal = (account: string) => tokenBalance(ledger, infra, account)
  console.log(`   user ${user.account}\n   agent ${agent.account}\n   spending account ${rec.pot.account}`)

  // ------------------------------------------------------------------ A. stolen key
  say('A. A stolen agent key')
  const thief = await ledger.fund()
  const steal = async (from: string, amount: string, label: string) => {
    const tx: any = await ledger.client.autofill({
      TransactionType: 'Payment', Account: from, Delegate: agentWallet.address, Destination: thief.address, Amount: tokenAmount(infra, amount),
    })
    const blob = agentWallet.sign(tx).tx_blob
    const pre: any = await ledger.client.submit(blob).catch((e) => ({ result: { engine_result: String(e.message ?? e).slice(0, 60) } }))
    let code = pre.result.engine_result as string
    if (code === 'tesSUCCESS' || code.startsWith('tec')) {
      // Applied to a ledger: wait for the validated result.
      const r: any = await ledger.client.request({ command: 'tx', transaction: pre.result.tx_json?.hash ?? pre.result.hash }).catch(() => null)
      for (let i = 0; i < 15 && !r?.result?.validated; i++) await sleep(1000)
      const done: any = await ledger.client.request({ command: 'tx', transaction: pre.result.tx_json.hash }).catch(() => null)
      code = done?.result?.meta?.TransactionResult ?? code
    }
    console.log(`   ${label}: ${code}`)
    return code
  }
  await ledger.submit({ TransactionType: 'TrustSet', Account: thief.address, LimitAmount: tokenAmount(infra, '1000') }, thief)

  check((await bal(rec.pot.account)) === 0, 'spending account holds nothing between purchases')
  check((await steal(user.account, '5', 'drain the USER account')) !== 'tesSUCCESS', 'the agent key has no delegation on the user main account')
  check((await steal(rec.pot.account, '5', 'drain the empty spending account')) !== 'tesSUCCESS', 'an empty spending account yields nothing')

  const feed = new EventFeed(service)
  await feed.start()
  // The only window of exposure: money sitting in the pot during a purchase. Simulate it with 2 test dollars.
  await ledger.submit({ TransactionType: 'Payment', Account: user.account, Destination: rec.pot.account, Amount: tokenAmount(infra, '2') } as never, Wallet.fromSeed(service.store.user(user.id).seed))
  const lost = await steal(rec.pot.account, '2', 'drain during the in-flight window')
  check(lost === 'tesSUCCESS', 'worst case: the thief gets only what is in the pot at that moment (2)')
  for (let i = 0; i < 20 && service.store.user(user.id).agents[agent.id]!.status === 'active'; i++) await sleep(1000)
  check(service.store.user(user.id).agents[agent.id]!.status === 'revoked', 'the feed guard revoked the agent after one unexpected payment', service.alerts)
  check(service.alerts.some((a) => /Verifiable Intent hash|no approved purchase/.test(a.reason)), 'an alert names the reason')
  check((await steal(rec.pot.account, '1', 'try again after revocation')) !== 'tesSUCCESS', 'the stolen key is dead after revocation')

  // ------------------------------------------------------------------ B. resilience
  say('B. Purchases that stop part-way')
  const agent2 = await service.addAgent(user.id, {
    label: 'Resilience agent', mode: 'autonomous', maxCents: 5000, budgetCents: 20000, merchantIds: [shop.id], items: [item],
  })
  const rec2 = service.store.user(user.id).agents[agent2.id]!
  const order = (amountCents: number) => ({ merchantId: shop.id, item, amountCents })
  const pendingOf = () => service.store.user(user.id).pending
  const purchasesOf = () => service.store.user(user.id).purchases

  // B1: the payment submission fails after the network already authorized.
  let startMerchant = await bal(merchantAccount)
  const realSubmit = ledger.submitSigned.bind(ledger)
  let mode: 'off' | 'fail-before' | 'fail-after' = 'fail-before'
  ledger.submitSigned = async (blob: string, tx?: unknown) => {
    if (mode === 'fail-before') { mode = 'off'; throw new Error('simulated: ledger unreachable') }
    if (mode === 'fail-after') { mode = 'off'; await realSubmit(blob, tx); throw new Error('simulated: response lost after submit') }
    return realSubmit(blob, tx)
  }

  let status = 0
  const chain1 = await service.buildChain(agent2.id, order(1000))
  await service.settlePurchase(agent2.id, chain1).catch((e) => { status = e instanceof HttpError ? e.status : -1 })
  check(status === 202, 'a failed payment step returns "pending" (202), not an error')
  check(pendingOf().length === 1 && pendingOf()[0]!.state === 'funded', 'the purchase is saved as funded and waiting', pendingOf().map((p) => p.state))
  check(counting.calls === 1, 'the network was asked once')
  check(purchasesOf().length === 0, 'nothing was scored yet')
  const r1 = await service.reconcile(0)
  check(r1.resumed.length === 1 && pendingOf().length === 0, 'the reconciler finished it', r1)
  check(purchasesOf().length === 1, 'the purchase is now scored')
  check(counting.calls === 1, 'the network was still asked only once')
  check(Math.abs((await bal(merchantAccount)) - startMerchant - 10) < 1e-9, 'the merchant received exactly 10')
  check((await bal(rec2.pot.account)) === 0, 'the spending account is empty again')

  // B2: the payment lands but the response is lost.
  startMerchant = await bal(merchantAccount)
  mode = 'fail-after'
  status = 0
  const chain2 = await service.buildChain(agent2.id, order(1500))
  await service.settlePurchase(agent2.id, chain2).catch((e) => { status = e instanceof HttpError ? e.status : -1 })
  check(status === 202, 'a lost response also returns "pending"')
  check(Math.abs((await bal(merchantAccount)) - startMerchant - 15) < 1e-9, 'the payment did land on the ledger (15)')
  const r2 = await service.reconcile(0)
  check(r2.resumed.length === 1 && purchasesOf().length === 2, 'the reconciler recorded it', r2)
  check(Math.abs((await bal(merchantAccount)) - startMerchant - 15) < 1e-9, 'the merchant was NOT paid twice')
  check(counting.calls === 2, 'one network authorization per purchase')

  // B3: retrying a settled chain, and a network decline.
  status = 0
  await service.settlePurchase(agent2.id, chain2).catch((e) => { status = e instanceof HttpError ? e.status : -1 })
  check(status === 409, 'replaying a settled chain is refused (409)')
  counting.declineNext = true
  status = 0
  const before = await bal(rec2.pot.account)
  await service.purchase(agent2.id, order(500)).catch((e) => { status = e instanceof HttpError ? e.status : -1 })
  counting.declineNext = false
  check(status === 402 && pendingOf().length === 0, 'a network decline leaves nothing pending')
  check((await bal(rec2.pot.account)) === before, 'a declined purchase never funds the spending account')
  ledger.submitSigned = realSubmit
} finally {
  await w.close()
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
