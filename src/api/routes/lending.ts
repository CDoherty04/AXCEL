import { z } from "zod";
import { body, json, type RouteFactory } from "./common.js";

export const lendingRoutes: RouteFactory = (holder) => [
  {
    method: "GET",
    pattern: "/api/v1/users/:id/credit",
    owner: "Will",
    handler: json((ctx, svc) => svc.creditState(ctx.params.id!), holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/lending/borrow",
    owner: "Will",
    handler: json(
      async (ctx, svc) => {
        const b = await body(ctx, z.object({ userId: z.string(), amount: z.number().positive().optional() }));
        return svc.borrow(b.userId, b.amount);
      },
      holder,
      201,
    ),
  },
  {
    method: "POST",
    pattern: "/api/v1/lending/repay",
    owner: "Will",
    handler: json(async (ctx, svc) => {
      const b = await body(
        ctx,
        z.object({ userId: z.string(), full: z.boolean().optional(), amount: z.number().positive().optional() }),
      );
      return svc.repay(b.userId, { full: b.full, amount: b.amount });
    }, holder),
  },
];
