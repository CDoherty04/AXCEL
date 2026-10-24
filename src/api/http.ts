import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, type ApiErrorBody } from "./errors.js";

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function applyCors(res: ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  applyCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", JSON_CONTENT_TYPE);
  res.end(JSON.stringify(body));
}

export function sendNoContent(res: ServerResponse): void {
  applyCors(res);
  res.statusCode = 204;
  res.end();
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    const body: ApiErrorBody = {
      error: err.message,
      code: err.code,
      details: err.details,
    };
    sendJson(res, err.status, body);
    return;
  }

  console.error(err);
  sendJson(res, 500, { error: "Internal server error", code: "internal_error" });
}

export async function readJsonBody<T = unknown>(req: IncomingMessage, maxBytes = 1_048_576): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      throw new HttpError(413, "Request body too large", { code: "payload_too_large" });
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body", { code: "invalid_json" });
  }
}

export function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpError(400, `Invalid numeric query parameter: ${raw}`, { code: "bad_request" });
  }
  return Math.min(Math.floor(n), max);
}
