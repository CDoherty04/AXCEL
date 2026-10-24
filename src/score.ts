import type { CreditEvent, ScoreBreakdown, ScoreInputs } from "./types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

export type ScoreWeights = {
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
  w6: number;
  w7: number;
  /** Published formula has no mandate term. Leave at 0 until it is tuned. */
  w8: number;
  lambda: number;
  halfLifeDays: number;
  /** Decayed, diminishing contribution cap for one merchant. */
  merchantCap: number;
  ageCapWeeks: number;
  /** Distinct merchants at which diversity saturates at 1. */
  diversitySaturation: number;
};

export const DEFAULT_WEIGHTS: ScoreWeights = {
  w1: 0.15,
  w2: 0.9,
  w3: 0.35,
  w4: 0.004,
  w5: 0.45,
  w6: 0.55,
  w7: 0.5,
  w8: 0,
  lambda: 0.25,
  halfLifeDays: 90,
  merchantCap: 4,
  ageCapWeeks: 104,
  diversitySaturation: 10,
};

export type ScoreSubject = {
  did: string;
  ownerId: string;
  fundingSourceId: string;
  createdAt: number;
  events: CreditEvent[];
};

type MerchantEvent = {
  merchantId: string;
  merchantOwnerId: string;
  merchantDid?: string;
  fundingSourceId?: string;
  at: number;
};

export function decayFactor(ageMs: number, halfLifeDays: number): number {
  if (ageMs <= 0) return 1;
  return 2 ** (-ageMs / (halfLifeDays * DAY_MS));
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    return 1 / (1 + Math.exp(-x));
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

export function scoreSubject(
  subject: ScoreSubject,
  now: number,
  utilization: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreBreakdown {
  const purchases = contributed(subject.events, "agent_purchase", subject, now, weights);
  const chain = contributed(subject.events, "chain_payment", subject, now, weights);
  const merchants = new Set([...purchases.merchants, ...chain.merchants]);

  const inputs: ScoreInputs = {
    pA: purchases.total,
    pC: chain.total,
    repaymentRatio: repaymentRatio(subject.events, now, weights.halfLifeDays),
    diversity: Math.min(1, merchants.size / weights.diversitySaturation),
    ageWeeks: Math.min(
      weights.ageCapWeeks,
      Math.max(0, (now - subject.createdAt) / WEEK_MS),
    ),
    disputes: decayedCount(subject.events, now, weights.halfLifeDays, (event) => event.type === "dispute"),
    lates: decayedCount(
      subject.events,
      now,
      weights.halfLifeDays,
      (event) => event.type === "repayment" && (event.outcome === "late" || event.outcome === "default"),
    ),
    utilization: clamp01(utilization),
    mandate: mandateBalance(subject.events, now, weights.halfLifeDays),
  };

  const terms = {
    purchases: weights.w1 * Math.log(1 + inputs.pA + weights.lambda * inputs.pC),
    repayment: weights.w2 * inputs.repaymentRatio,
    diversity: weights.w3 * inputs.diversity,
    age: weights.w4 * inputs.ageWeeks,
    disputes: weights.w5 * inputs.disputes,
    lates: weights.w6 * inputs.lates,
    utilization: weights.w7 * inputs.utilization,
    mandate: weights.w8 * inputs.mandate,
  };

  const x =
    terms.purchases +
    terms.repayment +
    terms.diversity +
    terms.age +
    terms.mandate -
    terms.disputes -
    terms.lates -
    terms.utilization;

  const raw = 300 + 550 * sigmoid(x);
  const score = Math.min(850, Math.max(300, Math.round(raw)));
  return { score, x, inputs, terms };
}

export function storedUtilization(
  events: CreditEvent[],
  now: number,
  halfLifeDays: number,
): { average: number; count: number } {
  let weight = 0;
  let sum = 0;
  let count = 0;
  for (const event of events) {
    if (event.type !== "utilization") continue;
    const factor = decayFactor(now - event.at, halfLifeDays);
    weight += factor;
    sum += factor * clamp01(event.value);
    count += 1;
  }
  return { average: weight === 0 ? 0 : sum / weight, count };
}

function contributed(
  events: CreditEvent[],
  type: "agent_purchase" | "chain_payment",
  subject: ScoreSubject,
  now: number,
  weights: ScoreWeights,
): { total: number; merchants: Set<string> } {
  const grouped = new Map<string, number[]>();
  const merchants = new Set<string>();
  for (const event of events) {
    if (event.type !== type || isSelfDeal(event, subject)) continue;
    const factor = decayFactor(now - event.at, weights.halfLifeDays);
    const existing = grouped.get(event.merchantId) ?? [];
    existing.push(factor);
    grouped.set(event.merchantId, existing);
    merchants.add(event.merchantId);
  }

  let total = 0;
  for (const factors of grouped.values()) {
    // The strongest remaining purchase at a merchant counts in full. Repeats count 1/2, 1/3, ...
    factors.sort((left, right) => right - left);
    let sum = 0;
    factors.forEach((factor, index) => {
      sum += factor / (index + 1);
    });
    total += Math.min(weights.merchantCap, sum);
  }
  return { total, merchants };
}

function isSelfDeal(event: MerchantEvent, subject: ScoreSubject): boolean {
  return (
    event.merchantOwnerId === subject.ownerId ||
    (event.merchantDid !== undefined && event.merchantDid === subject.did) ||
    (event.fundingSourceId !== undefined && event.fundingSourceId === subject.fundingSourceId)
  );
}

function repaymentRatio(events: CreditEvent[], now: number, halfLifeDays: number): number {
  let good = 0;
  let all = 0;
  for (const event of events) {
    if (event.type !== "repayment") continue;
    const factor = decayFactor(now - event.at, halfLifeDays);
    all += factor;
    if (event.outcome === "on_time" || event.outcome === "early") good += factor;
  }
  return all === 0 ? 0 : good / all;
}

function mandateBalance(events: CreditEvent[], now: number, halfLifeDays: number): number {
  let balance = 0;
  for (const event of events) {
    if (event.type !== "mandate") continue;
    const factor = decayFactor(now - event.at, halfLifeDays);
    balance += event.outcome === "clean_stop" ? factor : -factor;
  }
  return balance;
}

function decayedCount(
  events: CreditEvent[],
  now: number,
  halfLifeDays: number,
  include: (event: CreditEvent) => boolean,
): number {
  let total = 0;
  for (const event of events) {
    if (!include(event)) continue;
    total += decayFactor(now - event.at, halfLifeDays);
  }
  return total;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
