import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load `.env.local` from repo root. Does not override existing process.env keys.
 * @param {string} [root=repoRoot]
 */
export function loadEnvLocal(root = repoRoot) {
  const path = join(root, ".env.local");
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** @returns {string | undefined} */
export function rpcUrlFromEnv() {
  return (
    process.env.QUICKNODE_XRP_RPC_URL ??
    process.env.QUICKNODE_XRP_MAINNET_RPC_URL ??
    process.env.XRPL_MAINNET_RPC_URL ??
    process.env.XRPL_RPC_URL
  );
}

/** @param {string} [explicitUrl] */
export function resolveRpcUrl(explicitUrl) {
  const url = explicitUrl ?? rpcUrlFromEnv();
  if (!url) {
    throw new Error(
      "Missing mainnet RPC URL. Set QUICKNODE_XRP_RPC_URL in .env.local or pass rpcUrl.",
    );
  }
  return url;
}

export function maskRpcUrl(rpcUrl) {
  return rpcUrl.replace(/\/[^/]+\/?$/, "/…/");
}
