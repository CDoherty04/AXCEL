import { describe, expect, it } from 'vitest'
import { DAY } from '../src/config.js'
import { computeScore, decay } from '../src/scoring/engine.js'
import type { ScoreEvent } from '../src/scoring/types.js'

const now = 1_800_000_000
const base = { kyaValid: true, accountCreatedAt: now - 365 * DAY, now }

const plain = (n: number, merchants = 8): ScoreEvent[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'plain_payment', ts: now - (i + 1) * DAY, merchant: `rM${i % merchants}`, value: 5 }))

const agent = (n: number, merchants = 8): ScoreEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    type: 'agent_purchase', ts: now - (i + 1) * DAY, merchant: `rM${i % merchants}`, agentId: 'a1', mode: i % 2 ? 'immediate' : 'autonomous', viHash: `h${i}`,
  }))

const repay = (n: number, outcome: 'on_time' | 'early' | 'late' | 'default' = 'on_time'): ScoreEvent[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'repayment', ts: now - (i + 1) * DAY, outcome }))

describe('computeScore', () => {
  it('refuses to score without a KYA credential', () => {
    const r = computeScore({ ...base, kyaValid: false, events: plain(30) })
    expect(r.eligible).toBe(false)
    expect(r.score).toBeNull()
  })

  it('keeps the score on the 300-850 range', () => {
    const lo = computeScore({ ...base, events: [] })
    const hi = computeScore({ ...base, events: [...agent(400, 40), ...repay(20)] })
    expect(lo.score!).toBeGreaterThanOrEqual(300)
    expect(hi.score!).toBeLessThanOrEqual(850)
  })

  it('gives a cold-start user with real history a mid score (tier B)', () => {
    const r = computeScore({ ...base, events: plain(24) })
    expect(r.score!).toBeGreaterThanOrEqual(580)
    expect(r.score!).toBeLessThan(700)
    expect(r.tier).toBe('B')
  })

  it('weights an agent purchase 4x a plain payment', () => {
    const a = computeScore({ ...base, events: agent(1) })
    expect(a.terms.P_A).toBeCloseTo(decay(DAY), 5)
    const p = computeScore({ ...base, events: plain(1) })
    // P_C is the raw count; lambda is applied inside the formula.
    expect(p.terms.P_C).toBeCloseTo(decay(DAY), 5)
    expect(p.contributions[0]!.weight).toBeCloseTo(a.contributions[0]!.weight * 0.25, 5)
  })

  it('counts Immediate and Autonomous purchases identically', () => {
    const mk = (mode: 'immediate' | 'autonomous'): ScoreEvent[] => [
      { type: 'agent_purchase', ts: now - DAY, merchant: 'rM', agentId: 'a', mode, viHash: 'h' },
    ]
    expect(computeScore({ ...base, events: mk('immediate') }).score).toBe(computeScore({ ...base, events: mk('autonomous') }).score)
  })

  it('caps the tier at B without repayment history, however much volume', () => {
    const r = computeScore({ ...base, events: agent(300, 40) })
    expect(r.rawTier).toBe('A')
    expect(r.tier).toBe('B')
    expect(r.reasons.join(' ')).toMatch(/no repayment history/)
  })

  it('reaches tier A with agent purchases plus on-time repayments', () => {
    const r = computeScore({ ...base, events: [...agent(30), ...repay(4, 'early')] })
    expect(r.tier).toBe('A')
    expect(r.creditLine).toBe(1000)
  })

  it('ignores self-dealing merchants', () => {
    const events = agent(30, 1)
    const clean = computeScore({ ...base, events })
    const filtered = computeScore({ ...base, events, excludedMerchants: new Set(['rM0']) })
    expect(filtered.score!).toBeLessThan(clean.score!)
    expect(filtered.ignored).toHaveLength(30)
  })

  it('caps what one merchant can add', () => {
    const one = computeScore({ ...base, events: agent(500, 1) })
    expect(one.terms.P_A).toBeLessThanOrEqual(5.0001)
  })

  it('decays old events', () => {
    const fresh = computeScore({ ...base, events: agent(10) })
    const old = computeScore({ ...base, events: agent(10).map((e) => ({ ...e, ts: e.ts - 270 * DAY })) })
    expect(old.score!).toBeLessThan(fresh.score!)
  })

  it('penalizes late payments, disputes and refused attempts', () => {
    const good = computeScore({ ...base, events: [...agent(20), ...repay(3)] })
    const late = computeScore({ ...base, events: [...agent(20), ...repay(3, 'late')] })
    const dispute = computeScore({ ...base, events: [...agent(20), ...repay(3), { type: 'dispute', ts: now - DAY, ref: 'd1' }] })
    const refused = computeScore({ ...base, events: [...agent(20), ...repay(3), { type: 'mandate', ts: now - DAY, agentId: 'a', outcome: 'refused' }] })
    expect(late.score!).toBeLessThan(good.score!)
    expect(dispute.score!).toBeLessThan(good.score!)
    expect(refused.score!).toBeLessThan(good.score!)
  })

  it('rewards clean stops', () => {
    const e = [...agent(10), ...repay(1)]
    const stop = computeScore({ ...base, events: [...e, { type: 'mandate', ts: now - DAY, agentId: 'a', outcome: 'clean_stop' }] })
    expect(stop.score!).toBeGreaterThan(computeScore({ ...base, events: e }).score!)
  })

  it('drops to tier C after a recent default', () => {
    const r = computeScore({ ...base, events: [...agent(30), ...repay(3), ...repay(1, 'default')] })
    expect(r.tier).toBe('C')
  })

  it('lowers the score under sustained high utilization', () => {
    const events = [...agent(20), ...repay(2)]
    const high = computeScore({ ...base, events: [...events, { type: 'utilization', ts: now - DAY, value: 0.95 }] })
    expect(high.score!).toBeLessThan(computeScore({ ...base, events }).score!)
  })
})
