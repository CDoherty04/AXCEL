import { CreditError } from "./errors.js";

/** Parse a test-dollar string into integer cents. At most two decimal places. */
export function parseDollars(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new CreditError("invalid_amount", `Invalid dollar amount: ${value}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new CreditError("invalid_amount", `Amount is too large: ${value}`);
  }
  return cents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}${dollars}.${remainder.toString().padStart(2, "0")}`;
}
