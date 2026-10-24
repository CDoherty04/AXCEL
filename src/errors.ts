export type CreditErrorCode =
  | "invalid_amount"
  | "invalid_event"
  | "unknown_user"
  | "unknown_agent"
  | "unknown_loan"
  | "duplicate_user"
  | "duplicate_agent";

export class CreditError extends Error {
  readonly code: CreditErrorCode;

  constructor(code: CreditErrorCode, message: string) {
    super(message);
    this.name = "CreditError";
    this.code = code;
  }
}
