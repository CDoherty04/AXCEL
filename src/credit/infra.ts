import { Wallet } from 'xrpl'
import { credentialTypes, hex, TIER_ORDER, type Tier } from '../config.js'
import type { Infra, Store } from '../store/state.js'
import { Ledger, createdNodes, toRippleTime } from '../xrpl/client.js'
import { ViBridge } from '../vi/bridge.js'

/** Currency code for the Devnet test dollar that stands in for RLUSD (40-char hex form of "TUSD"). */
export const TEST_DOLLAR = '5455534400000000000000000000000000000000'

export const VAULT_LIQUIDITY = '20000'
export const BROKER_COVER = '1000'
/**
 * Seconds after current ledger close for SubscriptionDate.
 * XRPL rejects 0 (`tecEXPIRED`: date must be strictly in the future) and VaultDeposit must land
 * while still in Subscription. Broker setup after the deposit usually outlasts this, so lending
 * is ready as soon as bootstrap finishes.
 */
export const SUBSCRIPTION_WINDOW_SECONDS = 10
export const REDEMPTION_AFTER_SECONDS = 180 * 86_400

export const issuerWallet = (infra: Infra): Wallet => Wallet.fromSeed(infra.issuerSeed)
export const serviceWallet = (infra: Infra): Wallet => Wallet.fromSeed(infra.serviceSeed)
export const tokenAmount = (infra: Infra, value: string | number) => ({
  currency: infra.currency,
  issuer: issuerWallet(infra).address,
  value: String(value),
})

/** Which credentials a tier's domain accepts: "this tier or better". */
export const domainCredentials = (tier: Tier): Tier[] => TIER_ORDER.slice(0, TIER_ORDER.indexOf(tier) + 1)

/**
 * One-time setup of the lending side on Devnet: test-dollar issuer, tier domains, the private closed-ended
 * vault gated by the "tier F or better" domain (any issued tier), the loan broker, first-loss cover and seed liquidity.
 * Idempotent: returns the stored infra if it already exists.
 */
export async function bootstrapInfra(ledger: Ledger, store: Store, vi: ViBridge): Promise<Infra> {
  if (store.state.infra) return store.state.infra

  const [issuer, service] = await Promise.all([ledger.fund(), ledger.fund()])
  const currency = TEST_DOLLAR
  const token = { currency, issuer: issuer.address }

  await ledger.submit({ TransactionType: 'AccountSet', Account: issuer.address, SetFlag: 8 /* asfDefaultRipple */ }, issuer)
  await ledger.submit({ TransactionType: 'TrustSet', Account: service.address, LimitAmount: { ...token, value: '100000000' } }, service)
  await ledger.submit(
    { TransactionType: 'Payment', Account: issuer.address, Destination: service.address, Amount: { ...token, value: '1000000' } },
    issuer,
  )

  const domains = {} as Record<Tier, string>
  for (const tier of TIER_ORDER) {
    const res = await ledger.submit(
      {
        TransactionType: 'PermissionedDomainSet',
        Account: service.address,
        AcceptedCredentials: domainCredentials(tier).map((t) => ({
          Credential: { Issuer: service.address, CredentialType: hex(credentialTypes.tier[t]) },
        })),
      },
      service,
    )
    domains[tier] = createdNodes(res, 'PermissionedDomain')[0]!.LedgerIndex as string
  }

  const subscription = (await ledger.ledgerTime()) + SUBSCRIPTION_WINDOW_SECONDS
  const vaultRes = await ledger.submit(
    {
      TransactionType: 'VaultCreate',
      Account: service.address,
      Asset: token,
      Flags: 0x10000, // tfVaultPrivate
      DomainID: domains.F,
      AssetsMaximum: '10000000',
      VaultKind: 1, // closed-ended: required for loan brokers
      SubscriptionDate: toRippleTime(subscription),
      RedemptionDate: toRippleTime(subscription + REDEMPTION_AFTER_SECONDS),
    },
    service,
  )
  const vaultId = createdNodes(vaultRes, 'Vault')[0]!.LedgerIndex as string

  await ledger.submit(
    { TransactionType: 'VaultDeposit', Account: service.address, VaultID: vaultId, Amount: { ...token, value: VAULT_LIQUIDITY } },
    service,
  )

  const brokerRes = await ledger.submit(
    {
      TransactionType: 'LoanBrokerSet',
      Account: service.address,
      VaultID: vaultId,
      ManagementFeeRate: 1000, // 1%
      DebtMaximum: '100000',
      CoverRateMinimum: 1000,
      CoverRateLiquidation: 500,
    },
    service,
  )
  const brokerId = createdNodes(brokerRes, 'LoanBroker')[0]!.LedgerIndex as string
  await ledger.submit(
    { TransactionType: 'LoanBrokerCoverDeposit', Account: service.address, LoanBrokerID: brokerId, Amount: { ...token, value: BROKER_COVER } },
    service,
  )

  const [viIssuer, viMerchant] = await Promise.all([vi.keygen(), vi.keygen()])
  const infra: Infra = {
    issuerSeed: issuer.seed!,
    serviceSeed: service.seed!,
    currency,
    domains,
    vaultId,
    brokerId,
    viIssuer,
    viMerchant,
    vaultSubscriptionDate: subscription,
  }
  store.state.infra = infra
  store.save()
  return infra
}

/** Resolves once the vault's subscription window has closed and loans can be written. */
export async function waitForLending(ledger: Ledger, infra: Infra, log: (m: string) => void = () => {}): Promise<void> {
  for (;;) {
    const t = await ledger.ledgerTime()
    if (t > infra.vaultSubscriptionDate) return
    log(`vault subscription window closes in ${Math.ceil(infra.vaultSubscriptionDate - t)}s`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
}
