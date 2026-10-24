import { Wallet } from 'xrpl'
import { CREDENTIAL_TTL_SECONDS, credentialTypes, hex } from '../config.js'
import { credentialStatus } from '../identity/kya.js'
import type { Infra } from '../store/state.js'
import { nowUnix, toRippleTime, type Ledger } from '../xrpl/client.js'
import { tokenBalance } from './loans.js'
import { issuerWallet, tokenAmount } from './infra.js'
import { revokeDelegation } from './delegation.js'

/**
 * Per-agent spending accounts ("pots").
 *
 * Delegation limits which transactions an agent may send but not how much, and a delegate on the user's main
 * account can reach everything in it. So each agent pays from its own pot instead:
 *
 *  - the pot is funded just in time with exactly the purchase amount, so it holds ~0 between purchases;
 *  - the agent is delegated Payment on the pot only, never on the user's account;
 *  - the pot holds an AGENT_PAYER credential, and merchants accept funds only from credential holders
 *    (DepositAuth + credential-based DepositPreauth). Deleting the credential freezes the pot's spending even
 *    if the delegation were somehow still in place. Verified on Devnet: no credential -> tecNO_PERMISSION,
 *    deleted credential -> tecBAD_CREDENTIALS.
 */

const payerType = hex(credentialTypes.agentPayer)

export async function credentialIndex(ledger: Ledger, subject: string, issuer: string): Promise<string | null> {
  const r = (await ledger.client
    .request({ command: 'ledger_entry', credential: { subject, issuer, credential_type: payerType } } as never)
    .catch(() => null)) as { result: { index?: string } } | null
  return r?.result.index ?? null
}

/** Create the pot account, give it a trustline, an accepted AGENT_PAYER credential and a Payment-only delegate. */
export async function createPot(
  ledger: Ledger,
  infra: Infra,
  service: Wallet,
  agentAddress: string,
): Promise<{ wallet: Wallet; credentialId: string }> {
  const pot = await ledger.fund()
  await ledger.submit({ TransactionType: 'TrustSet', Account: pot.address, LimitAmount: tokenAmount(infra, '100000000') }, pot)
  await issuePayerCredential(ledger, service, pot)
  await ledger.submit(
    {
      TransactionType: 'DelegateSet',
      Account: pot.address,
      Authorize: agentAddress,
      Permissions: [{ Permission: { PermissionValue: 'Payment' } }],
    },
    pot,
  )
  return { wallet: pot, credentialId: (await credentialIndex(ledger, pot.address, service.address))! }
}

export async function issuePayerCredential(ledger: Ledger, service: Wallet, pot: Wallet): Promise<void> {
  await ledger.submit(
    {
      TransactionType: 'CredentialCreate',
      Account: service.address,
      Subject: pot.address,
      CredentialType: payerType,
      Expiration: toRippleTime(nowUnix() + CREDENTIAL_TTL_SECONDS),
    },
    service,
  )
  await ledger.submit(
    { TransactionType: 'CredentialAccept', Account: pot.address, Issuer: service.address, CredentialType: payerType },
    pot,
  )
}

/** The pot's credential id, re-issuing it first if it has expired or been removed. */
export async function ensurePayerCredential(ledger: Ledger, service: Wallet, pot: Wallet): Promise<string> {
  const s = await credentialStatus(ledger, pot.address, service.address, credentialTypes.agentPayer)
  if (!s.valid) {
    if (s.exists) {
      await ledger.submit(
        { TransactionType: 'CredentialDelete', Account: service.address, Subject: pot.address, Issuer: service.address, CredentialType: payerType },
        service,
      )
    }
    await issuePayerCredential(ledger, service, pot)
  }
  return (await credentialIndex(ledger, pot.address, service.address))!
}

/** Move `amount` test dollars from the user's account into the pot. */
export async function fundPot(ledger: Ledger, infra: Infra, user: Wallet, pot: string, amount: string): Promise<string> {
  const res = await ledger.submit(
    { TransactionType: 'Payment', Account: user.address, Destination: pot, Amount: tokenAmount(infra, amount) },
    user,
  )
  return res.result.hash
}

/** Return whatever is left in the pot to the user. */
export async function sweepPot(ledger: Ledger, infra: Infra, pot: Wallet, user: string): Promise<number> {
  const left = await tokenBalance(ledger, infra, pot.address)
  if (left <= 0) return 0
  await ledger.submit(
    { TransactionType: 'Payment', Account: pot.address, Destination: user, Amount: tokenAmount(infra, String(left)) },
    pot,
  )
  return left
}

/** Freeze the pot: remove the delegation, delete the credential, sweep the balance back to the user. */
export async function freezePot(ledger: Ledger, infra: Infra, service: Wallet, pot: Wallet, agent: string, user: string): Promise<string[]> {
  const hashes = [await revokeDelegation(ledger, pot, agent)]
  const s = await credentialStatus(ledger, pot.address, service.address, credentialTypes.agentPayer)
  if (s.exists) {
    const r = await ledger.submit(
      { TransactionType: 'CredentialDelete', Account: service.address, Subject: pot.address, Issuer: service.address, CredentialType: payerType },
      service,
    )
    hashes.push(r.result.hash)
  }
  await sweepPot(ledger, infra, pot, user)
  return hashes
}

/** Merchants accept funds only from accounts holding an AGENT_PAYER credential issued by the service. */
export async function restrictMerchant(ledger: Ledger, service: string, merchant: Wallet): Promise<void> {
  await ledger.submit({ TransactionType: 'AccountSet', Account: merchant.address, SetFlag: 9 /* asfDepositAuth */ }, merchant)
  await ledger.submit(
    {
      TransactionType: 'DepositPreauth',
      Account: merchant.address,
      AuthorizeCredentials: [{ Credential: { Issuer: service, CredentialType: payerType } }],
    } as never,
    merchant,
  )
}

export { issuerWallet }
