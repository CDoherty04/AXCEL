import { assertClassicAddress, fetchCreditHistory } from "../../lib/quicknode.js";
import { badRequest } from "../errors.js";
import { parsePositiveInt, sendError, sendJson } from "../http.js";
import type { Route } from "../router.js";

export const creditHistoryRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/v1/credit-history/:account",
    owner: "Charlie - QuickNode mainnet backlog",
    async handler(ctx) {
      try {
        const account = ctx.params.account;
        assertClassicAddress(account);

        const limit = parsePositiveInt(ctx.query.get("limit") ?? ctx.query.get("max"), 500, 5_000);
        const pageSize = parsePositiveInt(ctx.query.get("pageSize") ?? ctx.query.get("page-size"), 100, 400);

        const snapshot = await fetchCreditHistory({
          account,
          maxTransactions: limit,
          pageSize,
        });

        sendJson(ctx.res, 200, snapshot);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Invalid XRPL")) {
          sendError(ctx.res, badRequest(err.message));
          return;
        }
        sendError(ctx.res, err);
      }
    },
  },
];
