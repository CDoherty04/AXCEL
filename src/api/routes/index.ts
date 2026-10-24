import type { Route } from "../router.js";
import type { ServiceHolder } from "./common.js";
import { creditHistoryRoutes } from "./credit-history.js";
import { healthRoutes } from "./health.js";
import { kyaRoutes } from "./kya.js";
import { lendingRoutes } from "./lending.js";
import { paymentsRoutes } from "./payments.js";

/** Register domain routes here as each workstream ships handlers. */
export function allRoutes(holder: ServiceHolder): Route[] {
  return [
    ...healthRoutes,
    ...creditHistoryRoutes,
    ...kyaRoutes(holder),
    ...lendingRoutes(holder),
    ...paymentsRoutes(holder),
  ];
}

export function listRouteCatalog(routes: Route[]) {
  return routes.map((route) => ({
    method: route.method,
    path: route.pattern,
    owner: route.owner ?? null,
  }));
}
