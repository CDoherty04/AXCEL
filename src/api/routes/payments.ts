import { z } from "zod";
import type { ViChain } from "../../vi/bridge.js";
import { body, json, type RouteFactory } from "./common.js";

const item = z.object({ id: z.string(), title: z.string() });
const chain = z.object({ l1: z.string(), l2: z.string(), l3a: z.string().optional(), l2Payment: z.string().optional() });

export const paymentsRoutes: RouteFactory = (holder) => [
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
              maxCents: z.number().int().positive(),
              budgetCents: z.number().int().positive(),
              merchantIds: z.array(z.string()).min(1),
              items: z.array(item).min(1),
            }),
          ),
        ),
      holder,
      201,
    ),
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
      const b = await body(ctx, z.object({ agentId: z.string(), merchantId: z.string(), item, amountCents: z.number().int().positive() }));
      return svc.purchase(b.agentId, { merchantId: b.merchantId, item: b.item, amountCents: b.amountCents });
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
