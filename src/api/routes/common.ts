import { z, ZodError } from "zod";
import type { CreditService } from "../../service.js";
import { HttpError as StoreHttpError } from "../../store/state.js";
import { TxFailed } from "../../xrpl/client.js";
import { badRequest, HttpError } from "../errors.js";
import { readJsonBody, sendError, sendJson } from "../http.js";
import type { Route, RouteContext } from "../router.js";

/** The credit-layer service is created asynchronously (it bootstraps Devnet); routes resolve it per request. */
export interface ServiceHolder {
  get(): CreditService;
}

export const staticHolder = (svc: CreditService | null, reason = "credit-layer service is not running"): ServiceHolder => ({
  get() {
    if (!svc) throw new HttpError(503, reason, { code: "service_unavailable" });
    return svc;
  },
});

function toApiError(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  if (err instanceof StoreHttpError) return new HttpError(err.status, err.message);
  if (err instanceof ZodError) return badRequest("Invalid request", err.issues);
  if (err instanceof TxFailed) return new HttpError(422, `XRPL transaction failed: ${err.code}`, { code: err.code });
  return err;
}

/** Run a handler, convert service, ledger and validation errors into API errors, and send JSON. */
export function json<T>(
  fn: (ctx: RouteContext, svc: CreditService) => Promise<T> | T,
  holder: ServiceHolder,
  status = 200,
): (ctx: RouteContext) => Promise<void> {
  return async (ctx) => {
    try {
      sendJson(ctx.res, status, await fn(ctx, holder.get()));
    } catch (err) {
      const e = toApiError(err);
      // 202: accepted but still settling (a purchase that stopped part-way and will be retried).
      if (e instanceof HttpError && e.status === 202) return sendJson(ctx.res, 202, { pending: true, message: e.message });
      sendError(ctx.res, e);
    }
  };
}

export async function body<S extends z.ZodType>(ctx: RouteContext, schema: S): Promise<z.infer<S>> {
  return schema.parse(await readJsonBody(ctx.req));
}

export type RouteFactory = (holder: ServiceHolder) => Route[];
