import { createCreditSystem, type CreditSystem } from "./system.js";
import { DAY_MS, WEEK_MS } from "./score.js";
import { formatCents } from "./money.js";
import type { BorrowDecision } from "./types.js";

export const DEMO_NOW = Date.UTC(2026, 9, 24);

export type DemoResult = {
  goodAutomatic: BorrowDecision;
  badAutomatic: BorrowDecision;
  extreme: BorrowDecision;
  goodLimited: BorrowDecision;
};

export async function runDemo(now = DEMO_NOW): Promise<DemoResult> {
  const credit = createCreditSystem({ now: () => now });
  seedGood(credit, "good", "shopper", now);
  seedBad(credit, "bad", "payer", now);
  seedExtreme(credit, "extreme", "reckless", now);
  seedGood(credit, "capped", "shopper-capped", now);

  const goodAutomatic = await credit.borrow({ agentId: "shopper", amountNeeded: "400" });
  const badAutomatic = await credit.borrow({ agentId: "payer", amountNeeded: "200" });
  const extreme = await credit.borrow({ agentId: "reckless", amountNeeded: "50" });
  const goodLimited = await credit.borrow({
    agentId: "shopper-capped",
    amountNeeded: "400",
    mode: "limited",
    userLimit: "100",
  });
  return { goodAutomatic, badAutomatic, extreme, goodLimited };
}

export function formatDemo(result: DemoResult): string[] {
  return [
    formatLine("good automatic", result.goodAutomatic),
    formatLine("bad automatic", result.badAutomatic),
    formatLine("extreme automatic", result.extreme),
    formatLine("good limited", result.goodLimited),
  ];
}

export function seedGood(credit: CreditSystem, userId: string, agentId: string, now: number): void {
  open(credit, userId, agentId, now, now - 80 * WEEK_MS);
  for (let index = 0; index < 8; index += 1) {
    credit.record(userId, {
      type: "agent_purchase",
      agentId,
      merchantId: `merchant-${index}`,
      merchantOwnerId: `merchant-owner-${index}`,
      at: now,
    });
  }
  credit.record(userId, { type: "repayment", outcome: "on_time", at: now });
  credit.record(userId, { type: "repayment", outcome: "early", at: now });
}

export function seedBad(credit: CreditSystem, userId: string, agentId: string, now: number): void {
  open(credit, userId, agentId, now, now - 20 * WEEK_MS);
  for (const merchantId of ["utility", "transit"]) {
    credit.record(userId, {
      type: "chain_payment",
      merchantId,
      merchantOwnerId: `owner-${merchantId}`,
      at: now,
    });
  }
  credit.record(userId, { type: "repayment", outcome: "late", at: now });
}

export function seedExtreme(credit: CreditSystem, userId: string, agentId: string, now: number): void {
  open(credit, userId, agentId, now, now - 4 * WEEK_MS);
  for (let index = 0; index < 5; index += 1) {
    credit.record(userId, { type: "dispute", at: now });
    credit.record(userId, { type: "repayment", outcome: "late", at: now });
  }
}

function open(credit: CreditSystem, userId: string, agentId: string, now: number, createdAt: number): void {
  credit.registerUser({
    id: userId,
    did: `did:xrpl:${userId}`,
    ownerId: `owner-${userId}`,
    fundingSourceId: `fund-${userId}`,
    address: `r${userId}`,
    createdAt,
    kyaExpiresAt: now + 30 * DAY_MS,
  });
  credit.linkAgent({ userId, agentId, did: `did:xrpl:${agentId}` });
}

function formatLine(label: string, decision: BorrowDecision): string {
  const tier = decision.tier ?? "none";
  return `${label}: score ${decision.score} tier ${tier} need ${formatCents(decision.amountNeededCents)} approved ${formatCents(decision.approvedCents)} (${decision.outcome}, ${decision.reason})`;
}
