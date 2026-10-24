import { notImplemented } from "../errors.js";
import { sendError } from "../http.js";
import type { Route } from "../router.js";

/** Caleb — KYA, credit score, digital identity (XRPL / Mastercard) */
export const kyaRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/v1/kya/:did",
    owner: "Caleb",
    handler(ctx) {
      sendError(
        ctx.res,
        notImplemented(`KYA lookup for ${ctx.params.did} — implement in src/api/routes/kya.ts`),
      );
    },
  },
  {
    method: "POST",
    pattern: "/api/v1/credit/score",
    owner: "Caleb",
    handler(ctx) {
      sendError(
        ctx.res,
        notImplemented("POST body → ScoreBreakdown via src/score.ts — implement in kya routes"),
      );
    },
  },
];
