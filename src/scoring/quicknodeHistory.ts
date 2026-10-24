import { fetchCreditHistory, type CreditHistorySnapshot } from '../lib/quicknode.js'
import type { ScoreEvent } from './types.js'
import type { AccountHistory, HistoryReader } from './history.js'

/**
 * Convert the QuickNode credit-history snapshot (lib/credit-history.mjs) into score inputs. Only successful,
 * validated outgoing payments to other accounts become plain-payment events (no Verifiable Intent chain behind
 * them); the first incoming payment's sender is the account's funding source for the self-dealing check.
 */
export function snapshotToHistory(snap: CreditHistorySnapshot): AccountHistory {
  const events: ScoreEvent[] = []
  let fundingSource: string | undefined
  const chronological = [...snap.transactions].sort((a, b) => a.ledgerIndex - b.ledgerIndex)
  for (const t of chronological) {
    if (t.type !== 'Payment' || t.result !== 'tesSUCCESS' || !t.validated || !t.counterparty) continue
    if (t.direction === 'in' && !fundingSource) fundingSource = t.counterparty
    if (t.direction !== 'out') continue
    events.push({
      type: 'plain_payment',
      ts: Math.floor(Date.parse(t.timestamp) / 1000),
      merchant: t.counterparty,
      value: t.amount ? Number(t.amount.value) : 0,
      txHash: t.hash,
    })
  }
  return {
    account: snap.account,
    network: 'mainnet',
    firstActivityAt: snap.summary.firstActivityAt ? Math.floor(Date.parse(snap.summary.firstActivityAt) / 1000) : undefined,
    events,
    fundingSource,
    truncated: snap.partial,
  }
}

/** Mainnet cold start through QuickNode's archive (QUICKNODE_XRP_RPC_URL in .env.local). */
export class QuickNodeHistoryReader implements HistoryReader {
  constructor(private readonly opts: { maxTransactions?: number } = {}) {}

  async read(account: string): Promise<AccountHistory> {
    return snapshotToHistory(await fetchCreditHistory({ account, maxTransactions: this.opts.maxTransactions ?? 2000 }))
  }
}
