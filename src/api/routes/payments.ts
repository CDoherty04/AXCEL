import { notImplemented } from "../errors.js";
import { sendError } from "../http.js";
import type { Route } from "../router.js";

/** Mastercard agentic payments */
export const paymentsRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/v1/payments/agentic",
    owner: "Mastercard",
    handler(ctx) {
      sendError(ctx.res, notImplemented("Agentic payment intent — implement in payments routes"));
    },
  },
];
