import { assertScoreAddress, fetchCreditHistory } from "../../lib/quicknode.js";
import { computeScore } from "../../scoring/engine.js";
import { snapshotToHistory } from "../../scoring/quicknodeHistory.js";
import { badRequest, serviceUnavailable } from "../errors.js";
import { parsePositiveInt, sendError, sendJson } from "../http.js";
import type { Route, RouteContext } from "../router.js";

function isRateLimited(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String(err.code) : "";
  const message = err instanceof Error ? err.message : "";
  return code === "rate_limited" || /HTTP 429|\b429\b|too many requests|rate.?limit/i.test(message);
}

function sendHistoryError(res: RouteContext["res"], err: unknown): void {
  if (err instanceof Error && err.message.startsWith("Invalid XRPL")) {
    sendError(res, badRequest(err.message));
    return;
  }
  if (isRateLimited(err)) {
    sendError(res, serviceUnavailable("QuickNode is rate-limiting this address. Retry in a few seconds."));
    return;
  }
  sendError(res, err);
}

export const creditHistoryRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/v1/credit-history/:account",
    owner: "Charlie - QuickNode mainnet backlog",
    async handler(ctx) {
      try {
        const account = ctx.params.account;
        assertScoreAddress(account);

        const limitRaw = ctx.query.get("limit") ?? ctx.query.get("max");
        const snapshot = await fetchCreditHistory({
          account,
          ...(limitRaw ? { maxTransactions: parsePositiveInt(limitRaw, 500, 100_000) } : {}),
          pageSize: parsePositiveInt(ctx.query.get("pageSize") ?? ctx.query.get("page-size"), 100, 400),
        });

        sendJson(ctx.res, 200, snapshot);
      } catch (err) {
        sendHistoryError(ctx.res, err);
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
        assertScoreAddress(account);
        const limitRaw = ctx.query.get("limit");
        const snapshot = await fetchCreditHistory({
          account,
          ...(limitRaw ? { maxTransactions: parsePositiveInt(limitRaw, 500, 100_000) } : {}),
          pageSize: 100,
        });
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
        sendHistoryError(ctx.res, err);
      }
    },
  },
];
