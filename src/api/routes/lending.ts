import { notImplemented } from "../errors.js";
import { sendError } from "../http.js";
import type { Route } from "../router.js";

/** Will — XRPL lending protocol (devnet origination flows in src/system.ts) */
export const lendingRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/v1/lending/borrow",
    owner: "Will",
    handler(ctx) {
      sendError(
        ctx.res,
        notImplemented("Borrow request — wire to CreditSystem in src/system.ts"),
      );
    },
  },
  {
    method: "POST",
    pattern: "/api/v1/lending/repay",
    owner: "Will",
    handler(ctx) {
      sendError(ctx.res, notImplemented("Repayment — wire to CreditSystem.recordRepayment"));
    },
  },
];
