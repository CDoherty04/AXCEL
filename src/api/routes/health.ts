import type { Route } from "../router.js";
import { sendJson } from "../http.js";

export const healthRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/v1/health",
    handler(ctx) {
      sendJson(ctx.res, 200, {
        ok: true,
        service: "bec-api",
        version: "0.1.0",
      });
    },
  },
];
