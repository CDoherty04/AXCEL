import type { SubmittableTransaction, Wallet } from 'xrpl'
import { CREDENTIAL_TTL_SECONDS, credentialTypes, hex, type Tier } from '../config.js'
import { tierStatus } from '../identity/kya.js'
import type { Ledger } from '../xrpl/client.js'
import { nowUnix, toRippleTime } from '../xrpl/client.js'

const TIERS: Tier[] = ['A', 'B', 'C']

/** Transactions that replace whatever tier credential the user holds with `tier`, expiring in 30 days. */
export function tierRefreshTransactions(args: {
  service: string
  user: string
  tier: Tier
  /** Tier types currently on the ledger for this user; they are deleted first. */
  existing: Tier[]
  now?: number
}): { service: SubmittableTransaction[]; user: SubmittableTransaction[] } {
  const expiration = toRippleTime((args.now ?? nowUnix()) + CREDENTIAL_TTL_SECONDS)
  const del = args.existing.map(
    (t): SubmittableTransaction => ({
      TransactionType: 'CredentialDelete',
      Account: args.service,
      Subject: args.user,
      Issuer: args.service,
      CredentialType: hex(credentialTypes.tier[t]),
    }),
  )
  const create: SubmittableTransaction = {
    TransactionType: 'CredentialCreate',
    Account: args.service,
    Subject: args.user,
    CredentialType: hex(credentialTypes.tier[args.tier]),
    Expiration: expiration,
  }
  const accept: SubmittableTransaction = {
    TransactionType: 'CredentialAccept',
    Account: args.user,
    Issuer: args.service,
    CredentialType: hex(credentialTypes.tier[args.tier]),
  }
  return { service: [...del, create], user: [accept] }
}

/** Tier credentials of any tier currently on the ledger for this user (valid or not). */
export async function existingTiers(ledger: Ledger, user: string, service: string): Promise<Tier[]> {
  const found: Tier[] = []
  for (const t of TIERS) {
    if ((await tierStatus(ledger, user, service, t)).exists) found.push(t)
  }
  return found
}

/** Issue or replace the user's CreditTier credential (non-atomic path, used before the first loan). */
export async function issueTierCredential(
  ledger: Ledger,
  service: Wallet,
  user: Wallet,
  tier: Tier,
): Promise<{ expiresAt: number; txHashes: string[] }> {
  const existing = await existingTiers(ledger, user.address, service.address)
  const ops = tierRefreshTransactions({ service: service.address, user: user.address, tier, existing })
  const hashes: string[] = []
  for (const tx of ops.service) hashes.push((await ledger.submit(tx, service)).result.hash)
  for (const tx of ops.user) hashes.push((await ledger.submit(tx, user)).result.hash)
  const status = await tierStatus(ledger, user.address, service.address, tier)
  return { expiresAt: status.expiresAt ?? nowUnix() + CREDENTIAL_TTL_SECONDS, txHashes: hashes }
}

/** The tier the user currently holds as a valid, accepted, unexpired credential (highest wins). */
export async function currentTier(ledger: Ledger, user: string, service: string): Promise<{ tier: Tier; expiresAt: number } | null> {
  for (const t of TIERS) {
    const s = await tierStatus(ledger, user, service, t)
    if (s.valid) return { tier: t, expiresAt: s.expiresAt! }
  }
  return null
}
