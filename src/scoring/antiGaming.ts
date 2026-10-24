import type { Ledger } from '../xrpl/client.js'
import { resolveDid, type DidDocument } from '../identity/did.js'

export interface MerchantResolver {
  /** Account that funded `account` with its first incoming payment, if known. */
  fundingSource(account: string): Promise<string | undefined>
  /** DID controller of the account's DID, if it has one. */
  didController(account: string): Promise<string | undefined>
}

export interface UserIdentity {
  /** Every account the user owns or controls: user, agents, linked Mainnet account. */
  ownedAccounts: string[]
  fundingSources: string[]
  didControllers: string[]
}

/**
 * Self-dealing check. A merchant is excluded from scoring if it is one of the user's own accounts, was funded
 * by the same source as any of them, or has a DID controlled by the user's DID. This is the wash-loop defense:
 * paying yourself must not build credit.
 */
export async function findSelfDealing(
  merchants: Iterable<string>,
  identity: UserIdentity,
  resolver: MerchantResolver,
): Promise<Set<string>> {
  const owned = new Set(identity.ownedAccounts)
  const sources = new Set(identity.fundingSources)
  const controllers = new Set(identity.didControllers)
  const excluded = new Set<string>()
  for (const m of new Set(merchants)) {
    if (owned.has(m)) {
      excluded.add(m)
      continue
    }
    const [src, ctrl] = await Promise.all([resolver.fundingSource(m), resolver.didController(m)])
    if ((src && (sources.has(src) || owned.has(src))) || (ctrl && controllers.has(ctrl))) excluded.add(m)
  }
  return excluded
}

/** Resolver backed by a ledger (funding source via account_tx, DID controller via the DID object). */
export class LedgerMerchantResolver implements MerchantResolver {
  private readonly cache = new Map<string, { src?: string; ctrl?: string }>()

  constructor(
    private readonly ledger: Ledger,
    private readonly fetchDoc: (uri: string) => Promise<DidDocument>,
  ) {}

  private async load(account: string) {
    const hit = this.cache.get(account)
    if (hit) return hit
    const entry: { src?: string; ctrl?: string } = {}
    try {
      const r = await this.ledger.client.request({ command: 'account_tx', account, limit: 5, forward: true, ledger_index_min: -1, ledger_index_max: -1 })
      for (const t of r.result.transactions) {
        const tx = (t.tx_json ?? (t as { tx?: unknown }).tx) as { TransactionType?: string; Destination?: string; Account?: string } | undefined
        if (tx?.TransactionType === 'Payment' && tx.Destination === account) {
          entry.src = tx.Account
          break
        }
      }
    } catch {
      // unknown account: treat as no funding source
    }
    try {
      entry.ctrl = (await resolveDid(this.ledger, account, this.fetchDoc))?.document.controller
    } catch {
      // no DID or unreachable document
    }
    this.cache.set(account, entry)
    return entry
  }

  async fundingSource(account: string) {
    return (await this.load(account)).src
  }

  async didController(account: string) {
    return (await this.load(account)).ctrl
  }
}
