import { unhex } from './config.js'
import type { CreditService } from './service.js'
import { nowUnix } from './xrpl/client.js'

interface ValidatedTx {
  hash?: string
  tx_json?: Record<string, unknown>
  transaction?: Record<string, unknown>
  validated?: boolean
  meta?: { TransactionResult?: string }
}

/**
 * Live event feed: subscribes to each user's account and folds validated transactions the API did not
 * initiate into the score. Purchases settled through the API are already recorded (deduped by tx hash).
 *
 * - A Payment out of the user's account with no VI memo is a plain payment.
 * - A Payment carrying a VI memo that matches no settled purchase is NOT scored: the hash alone proves nothing.
 * - A LoanPay from the user's account is a repayment, classified against the loan's due date.
 */
export class EventFeed {
  private readonly watched = new Set<string>()

  constructor(private readonly service: CreditService) {}

  async start(): Promise<void> {
    const client = this.service.ledger.client
    for (const u of Object.values(this.service.store.state.users)) this.watched.add(u.account)
    if (this.watched.size) await client.request({ command: 'subscribe', accounts: [...this.watched] })
    client.on('transaction', (ev: unknown) => void this.ingest(ev as ValidatedTx).catch(() => {}))
  }

  async watch(account: string): Promise<void> {
    if (this.watched.has(account)) return
    this.watched.add(account)
    await this.service.ledger.client.request({ command: 'subscribe', accounts: [account] })
  }

  async ingest(ev: ValidatedTx): Promise<'plain' | 'repayment' | 'ignored'> {
    const tx = (ev.tx_json ?? ev.transaction) as Record<string, unknown> | undefined
    if (!tx || !ev.validated || ev.meta?.TransactionResult !== 'tesSUCCESS') return 'ignored'
    const hash = (ev.hash ?? tx.hash) as string | undefined
    const account = tx.Account as string
    const user = this.service.store.userByAccount(account)
    if (!user || !hash) return 'ignored'
    if (user.events.some((e) => 'txHash' in e && e.txHash === hash)) return 'ignored'

    if (tx.TransactionType === 'Payment' && typeof tx.Destination === 'string' && !tx.Delegate) {
      const memos = (tx.Memos as { Memo: { MemoType?: string } }[] | undefined) ?? []
      if (memos.some((m) => m.Memo.MemoType && unhex(m.Memo.MemoType) === 'vi/sha256')) return 'ignored'
      const amount = tx.Amount as { value?: string } | string
      const value = typeof amount === 'string' ? Number(amount) / 1e6 : Number(amount.value ?? 0)
      user.events.push({ type: 'plain_payment', ts: nowUnix(), merchant: tx.Destination, value, txHash: hash })
      this.service.store.save()
      return 'plain'
    }
    return 'ignored'
  }
}
