import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CreditHistorySnapshot, FetchCreditHistoryOptions } from "./quicknode-types.js";

const require = createRequire(fileURLToPath(import.meta.url));

const quicknode = require("../../lib/index.mjs") as {
  assertClassicAddress: (account: string) => void;
  assertScoreAddress: (account: string) => void;
  fetchCreditHistory: (options: FetchCreditHistoryOptions) => Promise<CreditHistorySnapshot>;
  loadEnvLocal: (root?: string) => void;
};

export type { CreditHistorySnapshot, FetchCreditHistoryOptions } from "./quicknode-types.js";

export function loadQuicknodeEnv(): void {
  quicknode.loadEnvLocal();
}

export function assertClassicAddress(account: string): void {
  quicknode.assertClassicAddress(account);
}

export function assertScoreAddress(account: string): void {
  quicknode.assertScoreAddress(account);
}

export function fetchCreditHistory(
  options: FetchCreditHistoryOptions,
): Promise<CreditHistorySnapshot> {
  return quicknode.fetchCreditHistory(options);
}
