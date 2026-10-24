/**
 * @param {string} rpcUrl
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
export async function rippled(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: [params],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const payload = await res.json();
  if (payload.error) {
    throw new Error(`RPC error: ${JSON.stringify(payload.error)}`);
  }
  if (payload.result?.error) {
    throw new Error(`rippled error: ${payload.result.error_message ?? payload.result.error}`);
  }
  return payload.result;
}
