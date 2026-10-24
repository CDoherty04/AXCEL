import { CreditError } from "./errors.js";
import { parseDollars } from "./money.js";
import {
  localOriginator,
  type LoanOriginator,
  type OriginationReceipt,
} from "./originator.js";
import {
  applyRepaymentCap,
  DEFAULT_POLICY,
  hasRecentDefault,
  hasRepaymentHistory,
  tierForScore,
  type PolicyOptions,
} from "./policy.js";
import {
  DEFAULT_WEIGHTS,
  scoreSubject,
  storedUtilization,
  type ScoreWeights,
} from "./score.js";
import { MemoryCreditStore, type CreditStore } from "./store.js";
import type {
  Agent,
  AgentProfile,
  BorrowDecision,
  BorrowMode,
  BorrowRequest,
  CreditEvent,
  CreditEventInput,
  DecisionReason,
  Loan,
  RepaymentOutcome,
  UserAccount,
} from "./types.js";

export type CreditSystemOptions = {
  now?: () => number;
  store?: CreditStore;
  originator?: LoanOriginator;
  weights?: ScoreWeights;
  policy?: PolicyOptions;
  brokerAddress?: string;
  loanBrokerId?: string;
};

type Assessment = {
  score: number;
  rawTier: AgentProfile["rawTier"];
  tier: AgentProfile["tier"];
  repaymentCapped: boolean;
  creditLimitCents: number;
  outstandingCents: number;
  denial: DecisionReason | null;
  breakdown: AgentProfile["breakdown"];
};

export class CreditSystem {
  private readonly clock: () => number;
  private readonly store: CreditStore;
  private readonly originator: LoanOriginator;
  private readonly weights: ScoreWeights;
  private readonly policy: PolicyOptions;
  private nextLoanId = 1;

  constructor(options: CreditSystemOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.store = options.store ?? new MemoryCreditStore();
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.originator =
      options.originator ??
      localOriginator({
        brokerAddress: options.brokerAddress,
        loanBrokerId: options.loanBrokerId,
      });
  }

  registerUser(input: {
    id: string;
    did: string;
    ownerId: string;
    fundingSourceId: string;
    address?: string;
    createdAt?: number;
    kyaExpiresAt: number | null;
    mode?: BorrowMode;
    userLimit?: string | null;
  }): void {
    if (this.store.get(input.id)) {
      throw new CreditError("duplicate_user", `User ${input.id} already exists`);
    }
    const user: UserAccount = {
      id: input.id,
      did: input.did,
      ownerId: input.ownerId,
      fundingSourceId: input.fundingSourceId,
      address: input.address ?? "",
      createdAt: input.createdAt ?? this.clock(),
      kyaExpiresAt: input.kyaExpiresAt,
      mode: input.mode ?? "automatic",
      userLimitCents:
        input.userLimit === undefined || input.userLimit === null
          ? null
          : parseDollars(input.userLimit),
      agents: [],
      events: [],
      loans: [],
    };
    this.store.put(user);
  }

  linkAgent(input: { userId: string; agentId: string; did: string }): void {
    const user = this.requireUser(input.userId);
    if (user.agents.some((agent) => agent.id === input.agentId)) {
      throw new CreditError("duplicate_agent", `Agent ${input.agentId} is already linked`);
    }
    user.agents.push({ id: input.agentId, did: input.did, revoked: false });
    this.store.put(user);
  }

  revokeAgent(agentId: string): void {
    const { user, agent } = this.userByAgent(agentId);
    agent.revoked = true;
    this.store.put(user);
  }

  setMode(userId: string, mode: BorrowMode, userLimit?: string | null): void {
    const user = this.requireUser(userId);
    user.mode = mode;
    if (userLimit !== undefined) {
      user.userLimitCents = userLimit === null ? null : parseDollars(userLimit);
    }
    this.store.put(user);
  }

  record(userId: string, event: CreditEventInput): void {
    const user = this.requireUser(userId);
    const stamped = stamp(event, this.clock());
    if (
      (stamped.type === "agent_purchase" || stamped.type === "mandate") &&
      !user.agents.some((agent) => agent.id === stamped.agentId)
    ) {
      throw new CreditError("unknown_agent", `Agent ${stamped.agentId} is not linked to ${userId}`);
    }
    if (stamped.type === "utilization" && (stamped.value < 0 || stamped.value > 1)) {
      throw new CreditError("invalid_event", "Utilization must be between 0 and 1");
    }
    user.events.push(stamped);
    this.store.put(user);
  }

  recordRepayment(input: {
    userId: string;
    loanId: string;
    outcome: RepaymentOutcome;
    amount?: string;
    at?: number;
  }): void {
    const user = this.requireUser(input.userId);
    const loan = user.loans.find((item) => item.id === input.loanId);
    if (!loan) {
      throw new CreditError("unknown_loan", `Unknown loan ${input.loanId}`);
    }
    user.events.push({
      type: "repayment",
      at: input.at ?? this.clock(),
      outcome: input.outcome,
      loanId: input.loanId,
    });
    if (input.outcome === "default") {
      loan.status = "defaulted";
    } else if (input.amount !== undefined) {
      loan.principalCents = Math.max(0, loan.principalCents - parseDollars(input.amount));
      if (loan.principalCents === 0) loan.status = "repaid";
    }
    this.store.put(user);
  }

  profile(agentId: string): AgentProfile {
    const { user, agent } = this.userByAgent(agentId);
    const assessment = this.assess(user);
    return this.profileFrom(user, agent, assessment);
  }

  /** Price a draw without booking it. */
  quote(request: BorrowRequest): BorrowDecision {
    const { user, agent } = this.userByAgent(request.agentId);
    return this.decide(user, agent, request);
  }

  /** Approve a draw and book a loan when the approved amount is above zero. */
  async borrow(request: BorrowRequest): Promise<BorrowDecision> {
    const { user, agent } = this.userByAgent(request.agentId);
    const decision = this.decide(user, agent, request);
    if (decision.approvedCents <= 0) return decision;

    const loanId = `local-${this.nextLoanId++}`;
    const receipt = await this.originator.originate({
      loanId,
      userId: user.id,
      agentId: agent.id,
      borrowerAddress: user.address,
      principalCents: decision.approvedCents,
    });
    const loan = this.book(user, agent.id, decision.approvedCents, receipt);
    user.loans.push(loan);
    this.store.put(user);
    return { ...decision, loan };
  }

  loans(userId: string): Loan[] {
    return this.requireUser(userId).loans;
  }

  private profileFrom(user: UserAccount, agent: Agent, assessment: Assessment): AgentProfile {
    const line = lineAmounts(user.mode, user.userLimitCents, assessment);
    const denial = agentDenial(agent, assessment, user.mode, user.userLimitCents, line.availableCents);
    return {
      agentId: agent.id,
      userId: user.id,
      mode: user.mode,
      score: assessment.score,
      tier: assessment.denial === "kya_missing" || assessment.denial === "kya_expired" ? null : assessment.tier,
      rawTier: assessment.denial === "kya_missing" || assessment.denial === "kya_expired" ? null : assessment.rawTier,
      repaymentCapped: assessment.repaymentCapped,
      creditLimitCents: line.creditLimitCents,
      userLimitCents: user.userLimitCents,
      effectiveLimitCents: line.effectiveLimitCents,
      outstandingCents: assessment.outstandingCents,
      availableCents: denial ? 0 : line.availableCents,
      denial,
      breakdown: assessment.breakdown,
    };
  }

  private decide(user: UserAccount, agent: Agent, request: BorrowRequest): BorrowDecision {
    const mode = request.mode ?? user.mode;
    const userLimitCents =
      mode === "limited"
        ? request.userLimit !== undefined
          ? parseDollars(request.userLimit)
          : user.userLimitCents
        : user.userLimitCents;
    const amountNeededCents = parseDollars(request.amountNeeded);
    const assessment = this.assess(user);
    const line = lineAmounts(mode, mode === "limited" ? userLimitCents : null, assessment);
    const denial = agentDenial(
      agent,
      assessment,
      mode,
      mode === "limited" ? userLimitCents : null,
      line.availableCents,
      amountNeededCents,
    );

    let outcome: BorrowDecision["outcome"];
    let reason: DecisionReason;
    let approvedCents: number;
    if (denial) {
      outcome = "denied";
      reason = denial;
      approvedCents = 0;
    } else if (amountNeededCents <= line.availableCents) {
      outcome = "approved";
      reason = "approved";
      approvedCents = amountNeededCents;
    } else {
      outcome = "partial";
      approvedCents = line.availableCents;
      const creditRemaining = assessment.creditLimitCents - assessment.outstandingCents;
      const userRemaining =
        mode === "limited" && userLimitCents !== null
          ? userLimitCents - assessment.outstandingCents
          : Number.POSITIVE_INFINITY;
      reason = userRemaining <= creditRemaining ? "user_limit" : "credit_limit";
    }

    const kyaBlocked = assessment.denial === "kya_missing" || assessment.denial === "kya_expired";
    return {
      outcome,
      reason,
      agentId: agent.id,
      userId: user.id,
      mode,
      score: assessment.score,
      tier: kyaBlocked ? null : assessment.tier,
      rawTier: kyaBlocked ? null : assessment.rawTier,
      repaymentCapped: assessment.repaymentCapped,
      creditLimitCents: kyaBlocked ? 0 : assessment.creditLimitCents,
      effectiveLimitCents: kyaBlocked ? 0 : line.effectiveLimitCents,
      outstandingCents: assessment.outstandingCents,
      availableCents: denial ? 0 : line.availableCents,
      amountNeededCents,
      approvedCents,
      breakdown: assessment.breakdown,
      loan: null,
    };
  }

  /**
   * Utilization is measured against the line from the score before this
   * drawdown is applied, so a smaller limit cannot inflate the ratio again.
   */
  private assess(user: UserAccount): Assessment {
    const now = this.clock();
    const outstandingCents = outstandingOf(user);
    const stored = storedUtilization(user.events, now, this.weights.halfLifeDays);
    const base = this.scoreLine(user, now, stored.average);
    const current =
      base.creditLimitCents > 0 ? Math.min(1, outstandingCents / base.creditLimitCents) : stored.average;
    const utilization = stored.count === 0 ? current : (stored.average + current) / 2;
    const scored = utilization === stored.average ? base : this.scoreLine(user, now, utilization);

    const raw = tierForScore(scored.breakdown.score, this.policy.tiers);
    const repaid = hasRepaymentHistory(user.events);
    const capped = applyRepaymentCap(raw, repaid, this.policy.tiers, this.policy.repaymentCapTier);
    const defaulted =
      hasRecentDefault(user.events, now, this.policy.defaultLockoutDays) ||
      user.loans.some((loan) => loan.status === "defaulted");

    let denial: DecisionReason | null = null;
    let tier = capped.tier;
    let creditLimitCents = tier?.limitCents ?? 0;
    if (user.kyaExpiresAt === null) {
      denial = "kya_missing";
      tier = null;
      creditLimitCents = 0;
    } else if (user.kyaExpiresAt <= now) {
      denial = "kya_expired";
      tier = null;
      creditLimitCents = 0;
    } else if (defaulted) {
      denial = "defaulted";
    } else if (!tier) {
      denial = "score_too_low";
      creditLimitCents = 0;
    }

    return {
      score: scored.breakdown.score,
      rawTier: denial === "kya_missing" || denial === "kya_expired" ? null : (raw?.tier ?? null),
      tier: tier?.tier ?? null,
      repaymentCapped: capped.capped && denial !== "kya_missing" && denial !== "kya_expired",
      creditLimitCents,
      outstandingCents,
      denial,
      breakdown: scored.breakdown,
    };
  }

  private scoreLine(user: UserAccount, now: number, utilization: number) {
    const breakdown = scoreSubject(user, now, utilization, this.weights);
    const tier = tierForScore(breakdown.score, this.policy.tiers);
    return { breakdown, creditLimitCents: tier?.limitCents ?? 0 };
  }

  private book(user: UserAccount, agentId: string, principalCents: number, receipt: OriginationReceipt): Loan {
    return {
      id: receipt.loanId,
      userId: user.id,
      agentId,
      principalCents,
      status: "active",
      createdAt: this.clock(),
      settlement: receipt.settlement,
      loanSet: receipt.loanSet,
    };
  }

  private requireUser(userId: string): UserAccount {
    const user = this.store.get(userId);
    if (!user) throw new CreditError("unknown_user", `Unknown user ${userId}`);
    return user;
  }

  private userByAgent(agentId: string): { user: UserAccount; agent: Agent } {
    const user = this.store.getByAgent(agentId);
    if (!user) throw new CreditError("unknown_agent", `Unknown agent ${agentId}`);
    const agent = user.agents.find((item) => item.id === agentId);
    if (!agent) throw new CreditError("unknown_agent", `Unknown agent ${agentId}`);
    return { user, agent };
  }
}

export function createCreditSystem(options?: CreditSystemOptions): CreditSystem {
  return new CreditSystem(options);
}

function outstandingOf(user: UserAccount): number {
  return user.loans
    .filter((loan) => loan.status === "active" || loan.status === "defaulted")
    .reduce((sum, loan) => sum + loan.principalCents, 0);
}

function lineAmounts(
  mode: BorrowMode,
  userLimitCents: number | null,
  assessment: Assessment,
): { creditLimitCents: number; effectiveLimitCents: number; availableCents: number } {
  const creditLimitCents = assessment.creditLimitCents;
  const effectiveLimitCents =
    mode === "limited" && userLimitCents !== null
      ? Math.min(creditLimitCents, userLimitCents)
      : creditLimitCents;
  const availableCents =
    assessment.denial === null ? Math.max(0, effectiveLimitCents - assessment.outstandingCents) : 0;
  return { creditLimitCents, effectiveLimitCents, availableCents };
}

function agentDenial(
  agent: Agent,
  assessment: Assessment,
  mode: BorrowMode,
  userLimitCents: number | null,
  availableCents: number,
  amountNeededCents?: number,
): DecisionReason | null {
  if (agent.revoked) return "revoked";
  if (assessment.denial) return assessment.denial;
  if (mode === "limited" && userLimitCents === null) return "limit_required";
  if (amountNeededCents === 0) return "zero_amount";
  if (availableCents === 0) {
    const creditRemaining = assessment.creditLimitCents - assessment.outstandingCents;
    const userRemaining = userLimitCents === null ? Number.POSITIVE_INFINITY : userLimitCents - assessment.outstandingCents;
    if (mode === "limited" && userRemaining <= 0 && creditRemaining > 0) return "user_limit";
    return "exhausted";
  }
  return null;
}

function stamp(event: CreditEventInput, now: number): CreditEvent {
  return { ...event, at: event.at ?? now };
}
