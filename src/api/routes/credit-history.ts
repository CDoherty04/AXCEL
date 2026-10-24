import { assertClassicAddress, fetchCreditHistory } from "../../lib/quicknode.js";
import { computeScore } from "../../scoring/engine.js";
import { snapshotToHistory } from "../../scoring/quicknodeHistory.js";
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
  {
    // Preview: the cold-start score for an address before it is linked. Same QuickNode history and the same
    // engine as POST /users/:id/cold-start, but with no KYA check or self-dealing filter (nothing is linked yet),
    // so the linked score can differ.
    method: "GET",
    pattern: "/api/v1/credit-history/:account/score",
    owner: "Charlie - QuickNode mainnet backlog",
    async handler(ctx) {
      try {
        const account = ctx.params.account;
        assertClassicAddress(account);
        const limit = parsePositiveInt(ctx.query.get("limit"), 500, 5_000);
        const snapshot = await fetchCreditHistory({ account, maxTransactions: limit, pageSize: 100 });
        const history = snapshotToHistory(snapshot);
        const now = Math.floor(Date.now() / 1000);
        const result = computeScore({
          events: history.events,
          kyaValid: true,
          accountCreatedAt: history.firstActivityAt ?? now,
          now,
        });
        sendJson(ctx.res, 200, {
          account,
          preview: true,
          score: result.score,
          tier: result.tier,
          rawTier: result.rawTier,
          creditLine: result.creditLine,
          reasons: result.reasons,
          terms: result.terms,
          scoredPayments: history.events.length,
          ignored: result.ignored.length,
          truncated: history.truncated,
        });
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
