import { hex } from './config.js'
import type { AgentRecord, PendingPurchase, PurchaseRecord } from './store/state.js'

/** A validated Payment as seen on the ledger (subset of fields the guard needs). */
export interface LedgerPayment {
  hash: string
  Account: string
  Delegate?: string
  Destination: string
  Amount: unknown
  Memos?: { Memo: { MemoType?: string; MemoData?: string } }[]
}

const VI_MEMO_TYPE = hex('vi/sha256')

export function viHashOf(tx: Pick<LedgerPayment, 'Memos'>): string | undefined {
  return tx.Memos?.find((m) => m.Memo.MemoType?.toUpperCase() === VI_MEMO_TYPE)?.Memo.MemoData?.toUpperCase()
}

const amountValue = (a: unknown): number => (typeof a === 'object' && a !== null && 'value' in a ? Number((a as { value: string }).value) : NaN)

export type PotPaymentVerdict =
  | { kind: 'expected'; viHash: string }
  | { kind: 'sweep' }
  | { kind: 'unexpected'; reason: string }

/**
 * Decide whether a payment out of an agent's spending account is one the service asked for.
 * Delegated payments are expected only when a purchase in flight (or already settled) has the same Verifiable
 * Intent hash, the same destination and the same amount. A payment signed by the pot's own key (no Delegate) is
 * the service sweeping the pot. Anything else means the agent key was used outside the service: revoke it.
 */
export function judgePotPayment(
  tx: LedgerPayment,
  agent: Pick<AgentRecord, 'id' | 'account'>,
  pending: readonly PendingPurchase[],
  settled: readonly PurchaseRecord[],
): PotPaymentVerdict {
  if (!tx.Delegate) return { kind: 'sweep' }
  if (tx.Delegate !== agent.account) return { kind: 'unexpected', reason: `delegate ${tx.Delegate} is not the agent` }
  const viHash = viHashOf(tx)
  if (!viHash) return { kind: 'unexpected', reason: 'payment carries no Verifiable Intent hash' }
  const paid = amountValue(tx.Amount)
  const p = pending.find((x) => x.viHash === viHash && x.agentId === agent.id)
  if (p) {
    if (tx.Destination !== p.merchantAccount) return { kind: 'unexpected', reason: 'destination differs from the approved purchase' }
    if (Math.abs(paid - p.amountCents / 100) > 1e-9) return { kind: 'unexpected', reason: 'amount differs from the approved purchase' }
    return { kind: 'expected', viHash }
  }
  const s = settled.find((x) => x.viHash === viHash && x.agentId === agent.id)
  if (s && s.txHash === tx.hash) return { kind: 'expected', viHash }
  return { kind: 'unexpected', reason: 'no approved purchase matches this payment' }
}
