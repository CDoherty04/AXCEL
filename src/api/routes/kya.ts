import { z } from "zod";
import { body, json, type RouteFactory } from "./common.js";

const proof = z.object({ signature: z.string(), publicKey: z.string() });

/** Identity: users, ownership proof, KYA, DID lookups and the score. Backed by the credit-layer service. */
export const kyaRoutes: RouteFactory = (holder) => [
  {
    method: "POST",
    pattern: "/api/v1/users",
    owner: "Caleb",
    handler: json(async (ctx, svc) => svc.createUser((await body(ctx, z.object({ id: z.string().optional() }))).id), holder, 201),
  },
  {
    method: "POST",
    pattern: "/api/v1/users/:id/link/challenge",
    owner: "Caleb",
    handler: json(
      async (ctx, svc) => svc.startLink(ctx.params.id!, (await body(ctx, z.object({ mainnetAccount: z.string() }))).mainnetAccount),
      holder,
    ),
  },
  {
    method: "POST",
    pattern: "/api/v1/users/:id/link/confirm",
    owner: "Caleb",
    handler: json(async (ctx, svc) => {
      svc.confirmLink(ctx.params.id!, await body(ctx, z.object({ mainnet: proof, devnet: proof })));
      return { linked: true };
    }, holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/users/:id/kya",
    owner: "Caleb",
    handler: json(
      async (ctx, svc) =>
        svc.verifyOwner(ctx.params.id!, await body(ctx, z.object({ legalName: z.string(), country: z.string(), documentId: z.string() }))),
      holder,
    ),
  },
  {
    method: "GET",
    pattern: "/api/v1/kya/:did",
    owner: "Caleb",
    handler: json((ctx, svc) => svc.kyaLookup(ctx.params.did!), holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/users/:id/cold-start",
    owner: "Caleb",
    handler: json(async (ctx, svc) => {
      const r = await svc.coldStart(ctx.params.id!);
      return { score: r.score, tier: r.tier, rawTier: r.rawTier, reasons: r.reasons, terms: r.terms };
    }, holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/credit/score",
    owner: "Caleb",
    handler: json(async (ctx, svc) => svc.rescore((await body(ctx, z.object({ userId: z.string() }))).userId), holder),
  },
  {
    method: "POST",
    pattern: "/api/v1/users/:id/tier",
    owner: "Caleb",
    handler: json((ctx, svc) => svc.syncTier(ctx.params.id!), holder),
  },
  {
    method: "GET",
    pattern: "/api/v1/users/:id/profile",
    owner: "Caleb",
    handler: json((ctx, svc) => svc.profile(ctx.params.id!), holder),
  },
];
