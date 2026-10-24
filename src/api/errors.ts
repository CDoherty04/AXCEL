export type ApiErrorBody = {
  error: string;
  code?: string;
  details?: unknown;
};

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, options?: { code?: string; details?: unknown }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = options?.code;
    this.details = options?.details;
  }
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, { code: "bad_request", details });
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message, { code: "not_found" });
}

export function notImplemented(message: string): HttpError {
  return new HttpError(501, message, { code: "not_implemented" });
}

export function serviceUnavailable(message: string, details?: unknown): HttpError {
  return new HttpError(503, message, { code: "service_unavailable", details });
}
