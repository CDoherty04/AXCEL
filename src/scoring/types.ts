import type { Tier } from '../config.js'

export type PurchaseMode = 'immediate' | 'autonomous'

export type ScoreEvent =
  /** A regular XRPL payment with no Verifiable Intent chain (cold-start history and ongoing activity). */
  | { type: 'plain_payment'; ts: number; merchant: string; value: number; txHash?: string }
  /** A purchase carrying a valid VI chain, inside its L2 mandate, settled on XRPL with the VI hash in Memos. */
  | { type: 'agent_purchase'; ts: number; merchant: string; agentId: string; mode: PurchaseMode; viHash: string; txHash?: string }
  | { type: 'repayment'; ts: number; outcome: 'on_time' | 'early' | 'late' | 'default'; txHash?: string }
  /** clean_stop: an approved purchase exhausted an agent's mandate budget. refused: an attempt beyond the mandate was rejected. */
  | { type: 'mandate'; ts: number; agentId: string; outcome: 'clean_stop' | 'refused' }
  | { type: 'dispute'; ts: number; ref: string }
  /** Sample of borrowed balance in use / credit line, 0..1. */
  | { type: 'utilization'; ts: number; value: number }

export interface ScoreInput {
  events: ScoreEvent[]
  /** KYA-Verified credential present and unexpired. Required to score at all. */
  kyaValid: boolean
  /** Unix seconds of the earliest known activity on the user's accounts. */
  accountCreatedAt: number
  now: number
  /** Merchants that share an owner, DID controller or funding source with the user. Their events are ignored. */
  excludedMerchants?: ReadonlySet<string>
}

export interface EventContribution {
  index: number
  type: ScoreEvent['type']
  ts: number
  merchant?: string
  agentId?: string
  /** Weight after decay, class weight, per-merchant diminishing returns and the merchant cap (in agent-purchase units). */
  weight: number
  note?: string
}

export interface ScoreTerms {
  P_A: number
  P_C: number
  R: number
  D: number
  A: number
  C: number
  L: number
  U: number
  M: number
  /** The sigmoid argument. */
  z: number
}

export interface ScoreResult {
  eligible: boolean
  score: number | null
  /** Tier before the repayment cap. */
  rawTier: Tier | null
  tier: Tier | null
  creditLine: number
  reasons: string[]
  terms: ScoreTerms
  contributions: EventContribution[]
  ignored: { index: number; reason: string }[]
}
