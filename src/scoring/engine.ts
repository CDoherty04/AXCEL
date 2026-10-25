import { DAY, score as cfg, tierForScore, tierRank, tiers, type Tier } from '../config.js'
import type { EventContribution, ScoreInput, ScoreResult, ScoreTerms } from './types.js'

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/** Exponential decay with a 90-day half-life. */
export function decay(ageSeconds: number, halfLifeDays = cfg.halfLifeDays): number {
  if (ageSeconds <= 0) return 1
  return Math.pow(0.5, ageSeconds / (halfLifeDays * DAY))
}

export { tierForScore }

const DEFAULT_CAP_WINDOW = 180 * DAY

const emptyTerms = (): ScoreTerms => ({ P_A: 0, P_C: 0, R: 0, D: 0, A: 0, C: 0, L: 0, U: 0, M: 0, z: 0 })

/**
 * S = 300 + 550 * sigmoid(bias + w1*log(1 + P_A + lambda*P_C) + w2*R + w3*D + w4*A
 *                         - w5*C - w6*L - w7*U + w8*M)
 */
export function computeScore(input: ScoreInput): ScoreResult {
  const { events, now } = input
  const excluded = input.excludedMerchants ?? new Set<string>()
  const contributions: EventContribution[] = []
  const ignored: { index: number; reason: string }[] = []
  const reasons: string[] = []

  if (!input.kyaValid) {
    return {
      eligible: false, score: null, rawTier: null, tier: null, creditLine: 0,
      reasons: ['KYA-Verified credential missing or expired: a user cannot be scored without it'],
      terms: emptyTerms(), contributions, ignored,
    }
  }

  // Volume: per-merchant diminishing returns, then a per-merchant cap.
  const perMerchant = new Map<string, { idx: number; ts: number; agent: boolean; base: number }[]>()
  events.forEach((e, index) => {
    if (e.type !== 'plain_payment' && e.type !== 'agent_purchase') return
    if (e.ts > now) {
      ignored.push({ index, reason: 'event is in the future' })
      return
    }
    if (excluded.has(e.merchant)) {
      ignored.push({ index, reason: 'self-dealing: merchant shares owner, DID controller or funding source' })
      return
    }
    if (e.type === 'plain_payment' && e.value < cfg.minPlainPaymentValue) {
      ignored.push({ index, reason: 'dust payment' })
      return
    }
    const list = perMerchant.get(e.merchant) ?? []
    list.push({ idx: index, ts: e.ts, agent: e.type === 'agent_purchase', base: decay(now - e.ts) })
    perMerchant.set(e.merchant, list)
  })

  let P_A = 0
  let P_C = 0
  for (const [merchant, list] of perMerchant) {
    list.sort((a, b) => a.ts - b.ts)
    const raw = list.map((x, k) => ({ ...x, w: x.base / (1 + 0.5 * k) }))
    const weighted = raw.reduce((s, x) => s + (x.agent ? x.w : cfg.lambda * x.w), 0)
    const f = weighted > cfg.merchantCap ? cfg.merchantCap / weighted : 1
    for (const x of raw) {
      const unit = (x.agent ? x.w : cfg.lambda * x.w) * f
      if (x.agent) P_A += x.w * f
      else P_C += x.w * f
      const src = events[x.idx]!
      contributions.push({
        index: x.idx,
        type: src.type,
        ts: src.ts,
        merchant,
        agentId: src.type === 'agent_purchase' ? src.agentId : undefined,
        weight: unit,
        note: f < 1 ? `merchant cap applied (x${f.toFixed(2)})` : undefined,
      })
    }
  }

  // Repayment record, late/default penalty, disputes, utilization, mandate adherence.
  let repOk = 0
  let repAll = 0
  let L = 0
  let C = 0
  let uSum = 0
  let uWeight = 0
  let mandate = 0
  let recentDefault = false
  let hasRepayment = false
  events.forEach((e, index) => {
    const d = decay(now - e.ts)
    switch (e.type) {
      case 'repayment':
        hasRepayment = true
        repAll += d
        if (e.outcome === 'on_time' || e.outcome === 'early') repOk += d
        else L += (e.outcome === 'default' ? 3 : 1) * d
        if (e.outcome === 'default' && now - e.ts < DEFAULT_CAP_WINDOW) recentDefault = true
        contributions.push({ index, type: e.type, ts: e.ts, weight: d, note: e.outcome })
        break
      case 'dispute':
        C += d
        contributions.push({ index, type: e.type, ts: e.ts, weight: d, note: e.ref })
        break
      case 'utilization':
        uSum += clamp(e.value, 0, 1) * d
        uWeight += d
        break
      case 'mandate':
        mandate += (e.outcome === 'clean_stop' ? 1 : -2) * d
        contributions.push({ index, type: e.type, ts: e.ts, agentId: e.agentId, weight: d, note: e.outcome })
        break
      default:
    }
  })

  const R = repAll > 0 ? repOk / repAll : 0
  const U = uWeight > 0 ? uSum / uWeight : 0
  const M = clamp(mandate / 5, -1, 1)
  const D = Math.min(1, perMerchant.size / cfg.diversityTarget)
  const ageWeeks = Math.max(0, now - input.accountCreatedAt) / (7 * DAY)
  const A = Math.min(ageWeeks, cfg.ageTargetWeeks) / cfg.ageTargetWeeks

  const w = cfg.w
  const z =
    cfg.bias +
    w.volume * Math.log(1 + P_A + cfg.lambda * P_C) +
    w.repayment * R +
    w.diversity * D +
    w.age * A -
    w.dispute * C -
    w.late * L -
    w.utilization * U +
    w.mandate * M

  const s = Math.round(300 + 550 * sigmoid(z))
  const rawTier = tierForScore(s)
  let tier: Tier = rawTier
  if (!hasRepayment && tierRank[tier] > tierRank.B) {
    tier = 'B'
    reasons.push('Tier capped at B: no repayment history yet')
  }
  if (recentDefault) {
    tier = 'F'
    reasons.push('Tier capped at F: default within the last 180 days')
  }

  return {
    eligible: true,
    score: s,
    rawTier,
    tier,
    creditLine: tiers[tier].creditLine,
    reasons,
    terms: { P_A, P_C, R, D, A, C, L, U, M, z },
    contributions: contributions.sort((a, b) => a.index - b.index),
    ignored,
  }
}
