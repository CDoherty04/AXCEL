import { z } from "zod";
import type { AuthorizationResult } from "../../mastercard/agentPay.js";
import { AgentRunner } from "../../agents/runner.js";
import type { CreditService } from "../../service.js";
import type { ViChain } from "../../vi/bridge.js";
import { notFound } from "../errors.js";
import { body, json, type RouteFactory } from "./common.js";

const networkClaim = z.object({
  claimId: z.string(),
  redeemTx: z.string(),
  channelId: z.string().optional(),
  rlusd: z.string().optional(),
});

function priorAuth(claim: z.infer<typeof networkClaim> | undefined): AuthorizationResult | undefined {
  if (!claim) return undefined;
  return {
    approved: true,
    authorizationId: claim.claimId,
    evidence: {
      network: "xrpl-evm-testnet",
      channelId: claim.channelId,
      redeemTx: claim.redeemTx,
      claimId: claim.claimId,
      rlusd: claim.rlusd,
    },
  };
}

const item = z.object({ id: z.string(), title: z.string() });
const chain = z.object({ l1: z.string(), l2: z.string(), l3a: z.string().optional(), l2Payment: z.string().optional() });

const runners = new WeakMap<CreditService, AgentRunner>();
const runnerFor = (svc: CreditService) => {
  let r = runners.get(svc);
  if (!r) runners.set(svc, (r = new AgentRunner(svc)));
  return r;
};

export const paymentsRoutes: RouteFactory = (holder) => [
  {
    // Start a Claude-driven agent on a task; it buys through the same protocol path as any other purchase.
    method: "POST",
    pattern: "/api/v1/agents/:id/run",
    owner: "Caleb",
    handler: json(async (ctx, svc) => runnerFor(svc).start(ctx.params.id!, (await body(ctx, z.object({ task: z.string().min(1).max(500) }))).task), holder, 202),
  },
  {
    method: "GET",
    pattern: "/api/v1/agents/:id/runs",
    owner: "Caleb",
    handler: json((ctx, svc) => runnerFor(svc).list(ctx.params.id!), holder),
  },
  {
    method: "GET",
    pattern: "/api/v1/runs/:id",
    owner: "Caleb",
    handler: json((ctx, svc) => runnerFor(svc).get(ctx.params.id!) ?? (() => { throw notFound("unknown run"); })(), holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/users/:id/agents",
    owner: "Caleb",
    handler: json(
      async (ctx, svc) =>
        svc.addAgent(
          ctx.params.id!,
          await body(
            ctx,
            z.object({
              label: z.string(),
              mode: z.enum(["immediate", "autonomous"]),
              maxCents: z.number().int().positive().optional(),
              budgetCents: z.number().int().positive().optional(),
              merchantIds: z.array(z.string()).optional(),
              items: z.array(item).optional(),
            }),
          ),
        ),
      holder,
      201,
    ),
  },
  {
    method: "POST",
    pattern: "/api/v1/agents/simple",
    owner: "Caleb",
    handler: json(async (ctx, svc) => {
      const b = await body(ctx, z.object({
        userId: z.string().optional(),
        label: z.string().min(1),
        limitCents: z.number().int().positive(),
        wallet: z.string().optional(),
      }));
      return svc.addNamedAgent(b.userId, b.label, b.limitCents, b.wallet);
    }, holder, 201),
  },
  {
    method: "DELETE",
    pattern: "/api/v1/agents/:id",
    owner: "Caleb",
    handler: json((ctx, svc) => svc.revokeAgent(ctx.params.id!), holder),
  },
  {
    // An external agent presents the Verifiable Intent chain it built. Responds 202 if settlement is still finishing.
    method: "POST",
    pattern: "/api/v1/payments/agentic",
    owner: "Mastercard",
    handler: json(async (ctx, svc) => {
      const b = await body(ctx, z.object({ agentId: z.string(), chain }));
      return svc.settlePurchase(b.agentId, b.chain as ViChain);
    }, holder),
  },
  {
    // Demo: the service plays the agent and builds the chain itself.
    method: "POST",
    pattern: "/api/v1/payments/agentic/demo",
    owner: "Mastercard",
    handler: json(async (ctx, svc) => {
      const b = await body(ctx, z.object({
        agentId: z.string(),
        merchantId: z.string(),
        item,
        amountCents: z.number().int().positive(),
        network: networkClaim.optional(),
      }));
      return svc.purchase(b.agentId, { merchantId: b.merchantId, item: b.item, amountCents: b.amountCents }, priorAuth(b.network));
    }, holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/payments/reconcile",
    owner: "Caleb",
    handler: json((_ctx, svc) => svc.reconcile(0), holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/payments/network/settle",
    owner: "Mastercard",
    handler: json(async (ctx, svc) => svc.settleNetwork(await body(ctx, z.object({ close: z.boolean().optional() }))), holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/merchants",
    owner: "Caleb",
    handler: json(async (ctx, svc) => svc.registerMerchant(await body(ctx, z.object({ name: z.string(), website: z.string() }))), holder, 201),
  },
];
