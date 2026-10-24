import { describe, expect, it } from 'vitest'
import { hex } from '../src/config.js'
import { judgePotPayment, viHashOf, type LedgerPayment } from '../src/settlement.js'
import type { PendingPurchase, PurchaseRecord } from '../src/store/state.js'

const HASH = 'AB'.repeat(32)
const agent = { id: 'ag1', account: 'rAgent' }

const pending = (over: Partial<PendingPurchase> = {}): PendingPurchase => ({
  id: 'p1', agentId: 'ag1', viHash: HASH, mode: 'autonomous', amountCents: 2500, merchantId: 'm1', merchantAccount: 'rMerchant',
  chain: { l1: 'a', l2: 'b' }, state: 'funded', attempts: 0, createdAt: 0, updatedAt: 0, ...over,
})

const pay = (over: Partial<LedgerPayment> = {}): LedgerPayment => ({
  hash: 'TX1', Account: 'rPot', Delegate: 'rAgent', Destination: 'rMerchant',
  Amount: { currency: 'TUSD', issuer: 'rI', value: '25.00' },
  Memos: [{ Memo: { MemoType: hex('vi/sha256'), MemoData: HASH } }], ...over,
})

describe('judgePotPayment', () => {
  it('accepts the payment the service asked for', () => {
    expect(judgePotPayment(pay(), agent, [pending()], [])).toEqual({ kind: 'expected', viHash: HASH })
  })

  it('treats a payment signed by the pot itself (no delegate) as a sweep', () => {
    expect(judgePotPayment(pay({ Delegate: undefined, Memos: undefined }), agent, [], [])).toEqual({ kind: 'sweep' })
  })

  it('flags a different delegate, a missing hash and an unknown hash', () => {
    expect(judgePotPayment(pay({ Delegate: 'rOther' }), agent, [pending()], []).kind).toBe('unexpected')
    expect(judgePotPayment(pay({ Memos: [] }), agent, [pending()], []).kind).toBe('unexpected')
    expect(judgePotPayment(pay(), agent, [], [])).toMatchObject({ kind: 'unexpected', reason: expect.stringMatching(/no approved purchase/) })
  })

  it('flags the right hash sent to the wrong destination or for the wrong amount', () => {
    expect(judgePotPayment(pay({ Destination: 'rThief' }), agent, [pending()], [])).toMatchObject({ kind: 'unexpected', reason: expect.stringMatching(/destination/) })
    expect(judgePotPayment(pay({ Amount: { value: '25.01' } }), agent, [pending()], [])).toMatchObject({ kind: 'unexpected', reason: expect.stringMatching(/amount/) })
  })

  it("does not let another agent's pending purchase excuse this agent's payment", () => {
    expect(judgePotPayment(pay(), agent, [pending({ agentId: 'ag2' })], []).kind).toBe('unexpected')
  })

  it('recognizes an already-settled purchase only for the same transaction', () => {
    const settled = { viHash: HASH, agentId: 'ag1', txHash: 'TX1' } as PurchaseRecord
    expect(judgePotPayment(pay(), agent, [], [settled]).kind).toBe('expected')
    expect(judgePotPayment(pay({ hash: 'TX2' }), agent, [], [settled]).kind).toBe('unexpected')
  })

  it('reads the chain hash from the memo regardless of case', () => {
    expect(viHashOf({ Memos: [{ Memo: { MemoType: hex('vi/sha256').toLowerCase(), MemoData: HASH.toLowerCase() } }] })).toBe(HASH)
  })
})
