import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runDemo, seedGood } from "../src/demo.js";
import { CreditError, DAY_MS, LOAN_TERMS, WEEK_MS, createCreditSystem } from "../src/index.js";
import type { CreditSystem } from "../src/system.js";

const NOW = Date.UTC(2026, 9, 24);

function system(): CreditSystem {
  return createCreditSystem({ now: () => NOW });
}

function open(
  credit: CreditSystem,
  userId: string,
  agentId = `${userId}-agent`,
  createdAt = NOW,
  kyaExpiresAt: number | null = NOW + 30 * DAY_MS,
): void {
  credit.registerUser({
    id: userId,
    did: `did:xrpl:${userId}`,
    ownerId: `owner-${userId}`,
    fundingSourceId: `fund-${userId}`,
    address: `r${userId}`,
    createdAt,
    kyaExpiresAt,
  });
  credit.linkAgent({ userId, agentId, did: `did:xrpl:${agentId}` });
}

describe("credit score", () => {
  it("scores an empty verified account at the midpoint, tier C", () => {
    const credit = system();
    open(credit, "new");
    const profile = credit.profile("new-agent");
    assert.equal(profile.score, 575);
    assert.equal(profile.tier, "C");
    assert.equal(profile.creditLimitCents, 5_000);
    assert.equal(profile.availableCents, 5_000);
    assert.equal(profile.denial, null);
  });

  it("decays a purchase by half after 90 days and diminishes merchant repeats", () => {
    const credit = system();
    open(credit, "history");
    credit.record("history", {
      type: "agent_purchase",
      agentId: "history-agent",
      merchantId: "old",
      merchantOwnerId: "owner-old",
      at: NOW - 90 * DAY_MS,
    });
    assert.equal(credit.profile("history-agent").breakdown.inputs.pA, 0.5);

    credit.record("history", {
      type: "agent_purchase",
      agentId: "history-agent",
      merchantId: "shop",
      merchantOwnerId: "owner-shop",
      at: NOW,
    });
    credit.record("history", {
      type: "agent_purchase",
      agentId: "history-agent",
      merchantId: "shop",
      merchantOwnerId: "owner-shop",
      at: NOW,
    });
    const inputs = credit.profile("history-agent").breakdown.inputs;
    assert.ok(Math.abs(inputs.pA - (0.5 + 1.5)) < 1e-9);
  });

  it("ignores self-dealing and caps one merchant", () => {
    const credit = system();
    open(credit, "gamer");
    credit.record("gamer", {
      type: "agent_purchase",
      agentId: "gamer-agent",
      merchantId: "self",
      merchantOwnerId: "owner-gamer",
      at: NOW,
    });
    credit.record("gamer", {
      type: "agent_purchase",
      agentId: "gamer-agent",
      merchantId: "real",
      merchantOwnerId: "owner-real",
      at: NOW,
    });
    credit.record("gamer", {
      type: "agent_purchase",
      agentId: "gamer-agent",
      merchantId: "alias",
      merchantOwnerId: "owner-alias",
      merchantDid: "did:xrpl:gamer",
      at: NOW,
    });
    assert.equal(credit.profile("gamer-agent").breakdown.inputs.pA, 1);

    for (let index = 0; index < 40; index += 1) {
      credit.record("gamer", {
        type: "agent_purchase",
        agentId: "gamer-agent",
        merchantId: "loop",
        merchantOwnerId: "owner-loop",
        at: NOW,
      });
    }
    const capped = credit.profile("gamer-agent").breakdown.inputs.pA;
    assert.ok(Math.abs(capped - 5) < 1e-9);
  });
});

describe("borrowing", () => {
  it("borrows only what the agent needs in automatic mode", async () => {
    const credit = system();
    seedGood(credit, "good", "shopper", NOW);
    const quoted = credit.quote({ agentId: "shopper", amountNeeded: "400" });
    assert.equal(quoted.loan, null);
    assert.equal(credit.loans("good").length, 0);

    const decision = await credit.borrow({ agentId: "shopper", amountNeeded: "400" });
    assert.equal(decision.outcome, "approved");
    assert.equal(decision.tier, "A");
    assert.ok(decision.score >= 700);
    assert.equal(decision.approvedCents, 40_000);
    assert.equal(decision.creditLimitCents, 100_000);
    assert.equal(decision.loan?.loanSet.PrincipalRequested, "400.00");
    assert.equal(decision.loan?.loanSet.Flags, LOAN_TERMS.overpaymentFlag);
    assert.equal(decision.loan?.loanSet.InterestRate, 500);
    assert.equal(decision.loan?.loanSet.Counterparty, "rgood");
    assert.equal(decision.loan?.settlement, "local");
    assert.equal(credit.profile("shopper").outstandingCents, 40_000);
  });

  it("fills a tier C line and stops there", async () => {
    const credit = system();
    open(credit, "thin", "thin-agent", NOW - 20 * WEEK_MS);
    credit.record("thin", {
      type: "chain_payment",
      merchantId: "utility",
      merchantOwnerId: "owner-utility",
      at: NOW,
    });
    credit.record("thin", { type: "repayment", outcome: "late", at: NOW });

    const profile = credit.profile("thin-agent");
    assert.equal(profile.tier, "C");
    assert.ok(profile.score >= 450 && profile.score < 580);

    const decision = await credit.borrow({ agentId: "thin-agent", amountNeeded: "200" });
    assert.equal(decision.outcome, "partial");
    assert.equal(decision.reason, "credit_limit");
    assert.equal(decision.approvedCents, 5_000);
  });

  it("refuses an extreme score, a default, and a missing credential", async () => {
    const extreme = system();
    open(extreme, "bad", "reckless", NOW - 4 * WEEK_MS);
    for (let index = 0; index < 5; index += 1) {
      extreme.record("bad", { type: "dispute", at: NOW });
      extreme.record("bad", { type: "repayment", outcome: "late", at: NOW });
    }
    const denied = await extreme.borrow({ agentId: "reckless", amountNeeded: "50" });
    assert.equal(denied.outcome, "denied");
    assert.equal(denied.reason, "score_too_low");
    assert.equal(denied.tier, null);
    assert.equal(denied.approvedCents, 0);
    assert.equal(denied.loan, null);

    const defaulter = system();
    seedGood(defaulter, "was-good", "was-good-agent", NOW);
    defaulter.record("was-good", { type: "repayment", outcome: "default", at: NOW });
    const blocked = await defaulter.borrow({ agentId: "was-good-agent", amountNeeded: "20" });
    assert.equal(blocked.reason, "defaulted");
    assert.equal(blocked.tier, "A");
    assert.equal(blocked.loan, null);

    const unverified = system();
    open(unverified, "anon", "anon-agent", NOW, null);
    const missing = await unverified.borrow({ agentId: "anon-agent", amountNeeded: "10" });
    assert.equal(missing.reason, "kya_missing");
    assert.equal(missing.creditLimitCents, 0);

    const expired = system();
    open(expired, "old", "old-agent", NOW, NOW);
    assert.equal((await expired.borrow({ agentId: "old-agent", amountNeeded: "10" })).reason, "kya_expired");
  });

  it("caps a strong file at tier B until an on-time or early repayment", async () => {
    const credit = system();
    open(credit, "cold", "cold-agent", NOW - 104 * WEEK_MS);
    for (let index = 0; index < 12; index += 1) {
      credit.record("cold", {
        type: "agent_purchase",
        agentId: "cold-agent",
        merchantId: `m-${index}`,
        merchantOwnerId: `owner-m-${index}`,
        at: NOW,
      });
    }
    const capped = credit.profile("cold-agent");
    assert.equal(capped.rawTier, "A");
    assert.equal(capped.tier, "B");
    assert.equal(capped.repaymentCapped, true);
    assert.equal(capped.creditLimitCents, 25_000);

    credit.record("cold", { type: "repayment", outcome: "early", at: NOW });
    const unlocked = await credit.borrow({ agentId: "cold-agent", amountNeeded: "400" });
    assert.equal(unlocked.tier, "A");
    assert.equal(unlocked.outcome, "approved");
    assert.equal(unlocked.approvedCents, 40_000);
  });

  it("applies a user ceiling in limited mode and still respects the score line", async () => {
    const credit = system();
    seedGood(credit, "capped", "shopper", NOW);
    const limited = await credit.borrow({
      agentId: "shopper",
      amountNeeded: "400",
      mode: "limited",
      userLimit: "100",
    });
    assert.equal(limited.outcome, "partial");
    assert.equal(limited.reason, "user_limit");
    assert.equal(limited.approvedCents, 10_000);
    assert.equal(limited.creditLimitCents, 100_000);

    const thin = system();
    open(thin, "thin");
    const scoreWins = await thin.borrow({
      agentId: "thin-agent",
      amountNeeded: "500",
      mode: "limited",
      userLimit: "500",
    });
    assert.equal(scoreWins.reason, "credit_limit");
    assert.equal(scoreWins.approvedCents, 5_000);

    const unset = system();
    open(unset, "unset");
    unset.setMode("unset", "limited");
    const missing = await unset.borrow({ agentId: "unset-agent", amountNeeded: "10" });
    assert.equal(missing.reason, "limit_required");
    assert.equal(missing.loan, null);
  });

  it("shares one line across agents and blocks a revoked agent", async () => {
    const credit = system();
    seedGood(credit, "user", "shopper", NOW);
    credit.linkAgent({ userId: "user", agentId: "api", did: "did:xrpl:api" });

    const first = await credit.borrow({ agentId: "shopper", amountNeeded: "900" });
    assert.equal(first.outcome, "approved");
    assert.equal(first.tier, "A");

    const second = await credit.borrow({ agentId: "api", amountNeeded: "200" });
    assert.equal(second.outcome, "partial");
    assert.equal(second.reason, "credit_limit");
    assert.equal(second.approvedCents, 10_000);
    assert.equal(credit.profile("shopper").outstandingCents, 100_000);

    credit.revokeAgent("api");
    const revoked = await credit.borrow({ agentId: "api", amountNeeded: "1" });
    assert.equal(revoked.reason, "revoked");
    assert.equal(credit.profile("api").denial, "revoked");
    assert.notEqual(credit.profile("shopper").denial, "revoked");
  });

  it("frees the line when the draw is repaid", async () => {
    const credit = system();
    open(credit, "payer");
    const draw = await credit.borrow({ agentId: "payer-agent", amountNeeded: "50" });
    assert.equal(credit.profile("payer-agent").availableCents, 0);

    credit.recordRepayment({
      userId: "payer",
      loanId: draw.loan!.id,
      outcome: "on_time",
      amount: "50",
    });
    const profile = credit.profile("payer-agent");
    assert.equal(profile.outstandingCents, 0);
    assert.equal(profile.tier, "B");
    assert.equal(profile.availableCents, 25_000);
    assert.equal(credit.loans("payer")[0]?.status, "repaid");
  });

  it("runs the four demo stories", async () => {
    const result = await runDemo(NOW);
    assert.equal(result.goodAutomatic.outcome, "approved");
    assert.equal(result.goodAutomatic.tier, "A");
    assert.equal(result.goodAutomatic.approvedCents, 40_000);
    assert.equal(result.badAutomatic.outcome, "partial");
    assert.equal(result.badAutomatic.tier, "C");
    assert.equal(result.badAutomatic.approvedCents, 5_000);
    assert.equal(result.extreme.outcome, "denied");
    assert.equal(result.extreme.reason, "score_too_low");
    assert.equal(result.goodLimited.outcome, "partial");
    assert.equal(result.goodLimited.reason, "user_limit");
    assert.equal(result.goodLimited.approvedCents, 10_000);
  });

  it("rejects an unknown agent and a zero draw", async () => {
    const credit = system();
    open(credit, "user");
    await assert.rejects(() => credit.borrow({ agentId: "missing", amountNeeded: "1" }), CreditError);
    const zero = await credit.borrow({ agentId: "user-agent", amountNeeded: "0" });
    assert.equal(zero.reason, "zero_amount");
    assert.equal(zero.loan, null);
  });
});
