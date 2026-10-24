import type { IncomingMessage, ServerResponse } from "node:http";
import { notFound } from "./errors.js";
import { sendError, sendNoContent } from "./http.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
};

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

export type Route = {
  method: HttpMethod;
  pattern: string;
  handler: RouteHandler;
  /** Short label for 501 discovery responses */
  owner?: string;
};

type CompiledRoute = Route & {
  segments: string[];
};

function splitPath(pathname: string): string[] {
  return pathname.replace(/\/+$/, "").split("/").filter(Boolean);
}

function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = splitPath(pattern);
  const pathSegments = splitPath(pathname);

  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const pat = patternSegments[i]!;
    const value = decodeURIComponent(pathSegments[i]!);

    if (pat.startsWith(":")) {
      params[pat.slice(1)] = value;
      continue;
    }
    if (pat !== value) {
      return null;
    }
  }

  return params;
}

export function createRouter(routes: Route[]) {
  const compiled: CompiledRoute[] = routes.map((route) => ({
    ...route,
    segments: splitPath(route.pattern),
  }));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawMethod = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");

    if (rawMethod === "OPTIONS") {
      sendNoContent(res);
      return;
    }

    const method = rawMethod as HttpMethod;

    for (const route of compiled) {
      if (route.method !== method) continue;

      const params = matchRoute(route.pattern, url.pathname);
      if (!params) continue;

      await route.handler({
        req,
        res,
        method,
        path: url.pathname,
        params,
        query: url.searchParams,
      });
      return;
    }

    sendError(res, notFound("Route not found"));
  }

  return { handle, routes: compiled };
}
