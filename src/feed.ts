import { unhex } from './config.js'
import type { CreditService } from './service.js'
import { viHashOf, type LedgerPayment } from './settlement.js'
import { nowUnix } from './xrpl/client.js'

interface ValidatedTx {
  hash?: string
  tx_json?: Record<string, unknown>
  transaction?: Record<string, unknown>
  validated?: boolean
  meta?: { TransactionResult?: string }
}

export type FeedResult = 'plain' | 'guarded' | 'ignored'

/**
 * Live event feed. Subscribes to each user's account and to every agent's spending account.
 *
 * - A Payment out of a spending account is checked by the guard: it must match an approved purchase (same chain
 *   hash, destination and amount). Anything else means the agent key was used outside the service, and the agent
 *   is revoked immediately.
 * - A Payment out of the user's own account with no VI memo is a plain payment for the score. Funding a spending
 *   account is the service moving money between the user's own accounts and is not scored.
 * - A Payment carrying a VI memo that matches no settled purchase is not scored: the hash alone proves nothing.
 */
export class EventFeed {
  private readonly watched = new Set<string>()

  constructor(private readonly service: CreditService) {}

  async start(): Promise<void> {
    const client = this.service.ledger.client
    for (const u of Object.values(this.service.store.state.users)) {
      this.watched.add(u.account)
      for (const a of Object.values(u.agents)) if (a.status === 'active' && a.pot) this.watched.add(a.pot.account)
    }
    if (this.watched.size) await client.request({ command: 'subscribe', accounts: [...this.watched] })
    client.on('transaction', (ev: unknown) => void this.ingest(ev as ValidatedTx).catch((e) => console.error('feed:', e)))
    this.service.onWatch = (account) => void this.watch(account).catch((e) => console.error('feed watch:', e))
  }

  async watch(account: string): Promise<void> {
    if (this.watched.has(account)) return
    this.watched.add(account)
    await this.service.ledger.client.request({ command: 'subscribe', accounts: [account] })
  }

  async ingest(ev: ValidatedTx): Promise<FeedResult> {
    const tx = (ev.tx_json ?? ev.transaction) as Record<string, unknown> | undefined
    if (!tx || !ev.validated || ev.meta?.TransactionResult !== 'tesSUCCESS') return 'ignored'
    const hash = (ev.hash ?? tx.hash) as string | undefined
    if (!hash || tx.TransactionType !== 'Payment' || typeof tx.Destination !== 'string') return 'ignored'
    const account = tx.Account as string

    const verdict = await this.service.guardPotPayment({ ...(tx as unknown as LedgerPayment), hash })
    if (verdict) return verdict.kind === 'unexpected' ? 'guarded' : 'ignored'

    const user = this.service.store.userByAccount(account)
    if (!user) return 'ignored'
    if (user.events.some((e) => 'txHash' in e && e.txHash === hash)) return 'ignored'
    if (Object.values(user.agents).some((a) => a.pot.account === tx.Destination)) return 'ignored'
    if (viHashOf(tx as unknown as LedgerPayment)) return 'ignored'
    if (tx.Delegate) return 'ignored'

    const amount = tx.Amount as { value?: string } | string
    const value = typeof amount === 'string' ? Number(amount) / 1e6 : Number(amount.value ?? 0)
    user.events.push({ type: 'plain_payment', ts: nowUnix(), merchant: tx.Destination, value, txHash: hash })
    this.service.store.save()
    return 'plain'
  }
}

/** Re-exported for callers that parse memos themselves. */
export { unhex }
