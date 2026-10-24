import { randomBytes } from 'node:crypto'
import { deriveAddress, sign as kpSign, verify as kpVerify } from 'ripple-keypairs'
import type { Wallet } from 'xrpl'

export const CHALLENGE_TTL_SECONDS = 600

/**
 * The message binds the nonce to BOTH addresses: the Mainnet account (history source) and the Devnet account
 * (credit account). The user signs it with each key, so a single signed message can't be replayed to link a
 * different pair of accounts.
 */
export function createChallenge(mainnetAccount: string, devnetAccount: string, now: number): { message: string; expiresAt: number } {
  const expiresAt = now + CHALLENGE_TTL_SECONDS
  const message = [
    'AXCEL credit layer: account link',
    `nonce:${randomBytes(16).toString('hex')}`,
    `mainnet:${mainnetAccount}`,
    `devnet:${devnetAccount}`,
    `expires:${expiresAt}`,
  ].join('\n')
  return { message, expiresAt }
}

const toHex = (s: string): string => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

export function signChallenge(wallet: Pick<Wallet, 'privateKey'>, message: string): string {
  return kpSign(toHex(message), wallet.privateKey)
}

/** True if `signature` over `message` was made by the master key of `account`. */
export function verifyChallenge(message: string, signature: string, publicKey: string, account: string): boolean {
  try {
    return deriveAddress(publicKey) === account && kpVerify(toHex(message), signature, publicKey)
  } catch {
    return false
  }
}
