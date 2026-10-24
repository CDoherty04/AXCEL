import { createHash } from 'node:crypto'
import type { Wallet } from 'xrpl'
import { credentialTypes, hex, KYA_TTL_SECONDS, type Tier } from '../config.js'
import type { Ledger } from '../xrpl/client.js'
import { fromRippleTime, nowUnix, toRippleTime } from '../xrpl/client.js'

/** Anything that can vouch that a real person has passed KYC. Mocked in the demo. */
export interface KycProvider {
  verify(subject: { legalName: string; country: string; documentId: string }): Promise<{ verified: boolean; reference: string; reason?: string }>
}

export class MockKycProvider implements KycProvider {
  async verify(s: { legalName: string; country: string; documentId: string }) {
    const reference = `kyc_${createHash('sha256').update(`${s.legalName}|${s.country}|${s.documentId}`).digest('hex').slice(0, 24)}`
    if (/reject|sanction/i.test(s.legalName)) return { verified: false, reference, reason: 'failed screening' }
    return { verified: true, reference }
  }
}

export interface CredentialStatus {
  exists: boolean
  accepted: boolean
  expired: boolean
  expiresAt?: number
  valid: boolean
}

const LSF_ACCEPTED = 0x00010000

/** Read a credential from the ledger. `valid` means accepted by the subject and not expired. */
export async function credentialStatus(
  ledger: Ledger,
  subject: string,
  issuer: string,
  credentialType: string,
  now = nowUnix(),
): Promise<CredentialStatus> {
  const r = (await ledger.client
    .request({ command: 'ledger_entry', credential: { subject, issuer, credential_type: hex(credentialType) } } as never)
    .catch(() => null)) as { result: { node?: { Flags?: number; Expiration?: number } } } | null
  const node = r?.result.node
  if (!node) return { exists: false, accepted: false, expired: false, valid: false }
  const accepted = ((node.Flags ?? 0) & LSF_ACCEPTED) !== 0
  const expiresAt = node.Expiration !== undefined ? fromRippleTime(node.Expiration) : undefined
  const expired = expiresAt !== undefined && expiresAt <= now
  return { exists: true, accepted, expired, expiresAt, valid: accepted && !expired }
}

export const kyaStatus = (ledger: Ledger, subject: string, issuer: string, now?: number) =>
  credentialStatus(ledger, subject, issuer, credentialTypes.kya, now)

export const tierStatus = (ledger: Ledger, subject: string, issuer: string, tier: Tier, now?: number) =>
  credentialStatus(ledger, subject, issuer, credentialTypes.tier[tier], now)

/**
 * Know Your Agent for the owner: KYC the person, then issue a KYA-Verified credential
 * (service -> user) and have the user accept it. The URI carries a hash of the KYC reference,
 * never the personal data.
 */
export async function issueKya(
  ledger: Ledger,
  service: Wallet,
  user: Wallet,
  kyc: KycProvider,
  subject: { legalName: string; country: string; documentId: string },
): Promise<{ expiresAt: number; txHashes: string[]; reference: string }> {
  const result = await kyc.verify(subject)
  if (!result.verified) throw new Error(`KYC failed: ${result.reason ?? 'not verified'}`)

  const expiresAt = nowUnix() + KYA_TTL_SECONDS
  const create = await ledger.submit(
    {
      TransactionType: 'CredentialCreate',
      Account: service.address,
      Subject: user.address,
      CredentialType: hex(credentialTypes.kya),
      Expiration: toRippleTime(expiresAt),
      URI: hex(`sha256:${createHash('sha256').update(result.reference).digest('hex')}`),
    },
    service,
  )
  const accept = await ledger.submit(
    { TransactionType: 'CredentialAccept', Account: user.address, Issuer: service.address, CredentialType: hex(credentialTypes.kya) },
    user,
  )
  return { expiresAt, txHashes: [create.result.hash, accept.result.hash], reference: result.reference }
}
