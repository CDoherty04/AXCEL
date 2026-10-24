import { Client } from 'xrpl'
import { networks, RIPPLE_EPOCH_OFFSET, type NetworkName } from '../config.js'
import type { ScoreEvent } from './types.js'

export interface AccountHistory {
  account: string
  network: NetworkName
  /** Unix seconds of the earliest transaction seen, or undefined for an account with no history. */
  firstActivityAt?: number
  /** Outgoing payments to other accounts, as plain (no-VI) payment events. */
  events: ScoreEvent[]
  /** The account that sent the first incoming payment: the funding source, used for self-dealing checks. */
  fundingSource?: string
  truncated: boolean
}

export interface HistoryReader {
  read(account: string): Promise<AccountHistory>
}

/** USD-ish value of an amount: XRP is not priced, so each XRP is counted at a flat 1 unit; IOUs at face value. */
function valueOf(amount: unknown): number {
  if (typeof amount === 'string') return Number(amount) / 1_000_000
  if (amount && typeof amount === 'object' && 'value' in amount) return Number((amount as { value: string }).value)
  return 0
}

/**
 * Reads account_tx from a full-history server (QuickNode archive for Mainnet). Pages through results up to
 * `maxTransactions`. Only the user's outgoing Payments to other accounts become plain-payment events.
 */
export class XrplHistoryReader implements HistoryReader {
  constructor(
    private readonly network: NetworkName,
    private readonly maxTransactions = 2000,
  ) {}

  async read(account: string): Promise<AccountHistory> {
    const client = new Client(networks[this.network].url, { timeout: 60_000 })
    await client.connect()
    try {
      const events: ScoreEvent[] = []
      let firstActivityAt: number | undefined
      let fundingSource: string | undefined
      let marker: unknown
      let seen = 0
      let truncated = false

      // Newest first for the bulk of the data; the oldest page is fetched separately for age and funding source.
      do {
        const res = await client.request({
          command: 'account_tx',
          account,
          limit: 400,
          ledger_index_min: -1,
          ledger_index_max: -1,
          marker: marker as never,
        })
        for (const t of res.result.transactions) {
          seen++
          const tx = (t.tx_json ?? (t as { tx?: unknown }).tx) as Record<string, unknown> | undefined
          const meta = t.meta
          if (!tx || typeof meta !== 'object' || (meta as { TransactionResult?: string }).TransactionResult !== 'tesSUCCESS') continue
          if (tx.TransactionType !== 'Payment' || tx.Account !== account || typeof tx.Destination !== 'string' || tx.Destination === account) continue
          const date = (tx.date as number | undefined) ?? (t as { close_time_iso?: string }).close_time_iso
          const ts = typeof date === 'number' ? date + RIPPLE_EPOCH_OFFSET : Math.floor(Date.parse(String(date)) / 1000)
          events.push({
            type: 'plain_payment',
            ts,
            merchant: tx.Destination,
            value: valueOf((meta as { delivered_amount?: unknown }).delivered_amount ?? tx.Amount),
            txHash: (t.hash ?? (tx.hash as string | undefined)) as string | undefined,
          })
        }
        marker = res.result.marker
        if (seen >= this.maxTransactions && marker) {
          truncated = true
          break
        }
      } while (marker)

      // Oldest transaction: forward query, one result.
      const oldest = await client.request({ command: 'account_tx', account, limit: 5, forward: true, ledger_index_min: -1, ledger_index_max: -1 })
      for (const t of oldest.result.transactions) {
        const tx = (t.tx_json ?? (t as { tx?: unknown }).tx) as Record<string, unknown> | undefined
        if (!tx) continue
        const date = tx.date as number | undefined
        if (date !== undefined && firstActivityAt === undefined) firstActivityAt = date + RIPPLE_EPOCH_OFFSET
        if (!fundingSource && tx.TransactionType === 'Payment' && tx.Destination === account && typeof tx.Account === 'string') {
          fundingSource = tx.Account
        }
      }
      return { account, network: this.network, firstActivityAt, events, fundingSource, truncated }
    } finally {
      await client.disconnect()
    }
  }
}

/** Fixed history for demos and tests, keyed by account. */
export class StaticHistoryReader implements HistoryReader {
  constructor(private readonly histories: Record<string, Partial<Omit<AccountHistory, 'account' | 'network'>>>) {}

  async read(account: string): Promise<AccountHistory> {
    const h = this.histories[account]
    return { account, network: 'mainnet', events: [], truncated: false, ...h }
  }
}
