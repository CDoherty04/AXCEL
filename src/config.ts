/** Single place for endpoints, tier table, score weights and credential types. */

export type NetworkName = 'mainnet' | 'devnet'

export interface NetworkConfig {
  name: NetworkName
  url: string
  /** Segment used in did:xrpl:<chain>:<account>. */
  didChain: string
}

export const networks: Record<NetworkName, NetworkConfig> = {
  // Cold start history. Set QUICKNODE_MAINNET_URL to your QuickNode archive endpoint (wss://...).
  mainnet: {
    name: 'mainnet',
    url: process.env.QUICKNODE_MAINNET_URL ?? 'wss://s2.ripple.com',
    didChain: '1',
  },
  // QuickNode has no Devnet endpoint; everything after cold start runs on the public server.
  devnet: {
    name: 'devnet',
    url: process.env.XRPL_DEVNET_URL ?? 'wss://s.devnet.rippletest.net:51233',
    didChain: '3',
  },
}

export const DAY = 86_400
export const RIPPLE_EPOCH_OFFSET = 946_684_800

export type Tier = 'A' | 'B' | 'C'

/** Credit line per tier, in test dollars (stand-in for RLUSD). Covers all of a user's agents together. */
export const tiers: Record<Tier, { minScore: number; creditLine: number }> = {
  A: { minScore: 450, creditLine: 1000 },
  B: { minScore: 380, creditLine: 100 },
  C: { minScore: 360, creditLine: 10 },
}

export const CREDENTIAL_TTL_SECONDS = 30 * DAY
export const KYA_TTL_SECONDS = 365 * DAY

/** Credential types are hex-encoded strings on the ledger. */
export const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
export const unhex = (h: string): string => Buffer.from(h, 'hex').toString('utf8')

export const credentialTypes = {
  kya: 'KYA_VERIFIED',
  /** Held by an agent's spending account; merchants accept payments only from holders. */
  agentPayer: 'AGENT_PAYER',
  tier: { A: 'CREDIT_TIER_A', B: 'CREDIT_TIER_B', C: 'CREDIT_TIER_C' } as Record<Tier, string>,
}

export const score = {
  /** Weight of a plain payment relative to a verified agent purchase. */
  lambda: 0.25,
  halfLifeDays: 90,
  bias: -2.0,
  w: { volume: 0.9, repayment: 1.5, diversity: 0.8, age: 0.5, dispute: 1.2, late: 1.5, utilization: 0.8, mandate: 0.4 },
  /** Max weighted units any one merchant can add to the volume term. */
  merchantCap: 5,
  /** Distinct merchants at which the diversity term saturates. */
  diversityTarget: 8,
  /** Account age (weeks) at which the age term saturates. */
  ageTargetWeeks: 104,
  /** Plain payments below this many USD-equivalent units are treated as dust and ignored. */
  minPlainPaymentValue: 1,
}

export const loanTerms = {
  /** 1/10 basis points: 5000 = 5%. */
  interestRate: 5000,
  paymentTotal: 4,
  /** Seconds between installments (XRPL minimum is 60). */
  paymentInterval: 3600,
  gracePeriod: 3600,
}

/** Where this service is reachable; DID documents are served from `${publicUrl}/did/<account>`. */
export const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3000'
