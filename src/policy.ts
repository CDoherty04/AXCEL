import type { CreditEvent, TierName } from "./types.js";
import { DAY_MS } from "./score.js";

export type TierDefinition = {
  tier: TierName;
  minScore: number;
  limitCents: number;
};

/**
 * Tier C starts at 450, not at the bottom of the 300–850 scale.
 * Scores under that floor are an extreme file: lending is not approved.
 * Raise or lower `minScore` on C as the book gets real repayment data.
 */
export const DEFAULT_TIERS: readonly TierDefinition[] = [
  { tier: "A", minScore: 700, limitCents: 100_000 },
  { tier: "B", minScore: 580, limitCents: 25_000 },
  { tier: "C", minScore: 450, limitCents: 5_000 },
];

export const REPAYMENT_CAP_TIER: TierName = "B";

export type PolicyOptions = {
  tiers: readonly TierDefinition[];
  repaymentCapTier: TierName;
  /** A default inside this window blocks a new draw even if the loan object is gone. */
  defaultLockoutDays: number;
};

export const DEFAULT_POLICY: PolicyOptions = {
  tiers: DEFAULT_TIERS,
  repaymentCapTier: REPAYMENT_CAP_TIER,
  defaultLockoutDays: 90,
};

export function tierForScore(score: number, tiers: readonly TierDefinition[]): TierDefinition | null {
  const ordered = [...tiers].sort((left, right) => right.minScore - left.minScore);
  return ordered.find((tier) => score >= tier.minScore) ?? null;
}

export function hasRepaymentHistory(events: CreditEvent[]): boolean {
  return events.some(
    (event) => event.type === "repayment" && (event.outcome === "on_time" || event.outcome === "early"),
  );
}

export function hasRecentDefault(events: CreditEvent[], now: number, lockoutDays: number): boolean {
  const windowMs = lockoutDays * DAY_MS;
  return events.some(
    (event) => event.type === "repayment" && event.outcome === "default" && now - event.at <= windowMs,
  );
}

export function applyRepaymentCap(
  raw: TierDefinition | null,
  repaid: boolean,
  tiers: readonly TierDefinition[],
  capTier: TierName,
): { tier: TierDefinition | null; capped: boolean } {
  if (!raw || repaid) return { tier: raw, capped: false };
  const cap = tiers.find((tier) => tier.tier === capTier);
  if (!cap || raw.minScore <= cap.minScore) return { tier: raw, capped: false };
  return { tier: cap, capped: true };
}
