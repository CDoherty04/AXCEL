import type {
  AgentRegistry, AuthorizationRequest, AuthorizationResult, NetworkAuthorizer,
} from './agentPay.js'

/**
 * Real Mastercard Agent Pay for Machines (AP4M) adapter.
 *
 * STATUS: scaffold. AP4M opened Early Access on 2026-10-20 (buyer- and seller-side APIs, toolkit, sandbox), but its
 * documentation is not public: developer.mastercard.com/mastercard-agent-pay and the Developers MCP both return 404
 * for it. Request paths, the auth scheme and the request/response field names below are therefore PLACEHOLDERS,
 * isolated in this one file so they can be corrected against the Early Access docs without touching the service.
 * Nothing here talks to Mastercard until MASTERCARD_MODE=ap4m and the environment is filled in.
 *
 * Known from public reporting: AP4M builds on x402 (HTTP 402 -> signed payment voucher -> merchant verifies ->
 * vouchers may be batched and redeemed later), with stablecoin rails including XRPL/RLUSD named by Mastercard.
 */

export class Ap4mNotConfigured extends Error {
  constructor(missing: string[]) {
    super(`Agent Pay for Machines is not configured; missing ${missing.join(', ')} (see .env.example)`)
  }
}

export interface Ap4mConfig {
  baseUrl: string
  /** Credential issued with Early Access. */
  apiKey: string
  /** Endpoint paths relative to baseUrl. Confirm against the Early Access docs. */
  paths: { registerAgent: string; revokeAgent: string; authorize: string }
  /** Settlement network label to request (the x402 `network` field), for example the XRPL network id. */
  settlementNetwork: string
  /** Asset to settle in, for example RLUSD. */
  settlementAsset: string
}

export function ap4mConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Ap4mConfig {
  const need = ['AP4M_BASE_URL', 'AP4M_API_KEY', 'AP4M_PATH_REGISTER_AGENT', 'AP4M_PATH_REVOKE_AGENT', 'AP4M_PATH_AUTHORIZE', 'AP4M_SETTLEMENT_NETWORK']
  const missing = need.filter((k) => !env[k])
  if (missing.length) throw new Ap4mNotConfigured(missing)
  return {
    baseUrl: env.AP4M_BASE_URL!.replace(/\/$/, ''),
    apiKey: env.AP4M_API_KEY!,
    paths: { registerAgent: env.AP4M_PATH_REGISTER_AGENT!, revokeAgent: env.AP4M_PATH_REVOKE_AGENT!, authorize: env.AP4M_PATH_AUTHORIZE! },
    settlementNetwork: env.AP4M_SETTLEMENT_NETWORK!,
    settlementAsset: env.AP4M_SETTLEMENT_ASSET ?? 'RLUSD',
  }
}

/** Adds auth headers to a request. Replace if Early Access uses OAuth1.0a (as other Mastercard APIs do) or mTLS. */
export type RequestSigner = (req: { method: string; url: string; body: string }) => Record<string, string> | Promise<Record<string, string>>

export const bearerSigner = (apiKey: string): RequestSigner => () => ({ authorization: `Bearer ${apiKey}` })

class Ap4mHttp {
  constructor(
    readonly cfg: Ap4mConfig,
    private readonly sign: RequestSigner = bearerSigner(cfg.apiKey),
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async post<T>(path: string, payload: unknown): Promise<{ status: number; body: T }> {
    const url = `${this.cfg.baseUrl}${path}`
    const body = JSON.stringify(payload)
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(await this.sign({ method: 'POST', url, body })) },
      body,
    })
    const text = await res.text()
    let parsed: unknown = {}
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      parsed = { raw: text }
    }
    return { status: res.status, body: parsed as T }
  }
}

/** Know Your Agent: register the agent (and its owner's DID) with Mastercard so its purchases are accepted. */
export class Ap4mAgentRegistry implements AgentRegistry {
  private readonly http: Ap4mHttp

  constructor(cfg: Ap4mConfig, sign?: RequestSigner, fetchFn?: typeof fetch) {
    this.http = new Ap4mHttp(cfg, sign, fetchFn)
  }

  async register(input: { ownerDid: string; agentDid: string; publicKeyThumbprint: string }): Promise<{ mastercardAgentId: string }> {
    const { status, body } = await this.http.post<{ agentId?: string }>(this.http.cfg.paths.registerAgent, input)
    if (status >= 300 || !body.agentId) throw new Error(`AP4M agent registration failed (${status}): ${JSON.stringify(body)}`)
    return { mastercardAgentId: body.agentId }
  }

  async isRegistered(mastercardAgentId: string): Promise<boolean> {
    // The Early Access API may expose a lookup; until confirmed, registration state is held by the caller's store
    // and revocation is enforced by the delegation being removed on the ledger.
    return mastercardAgentId.length > 0
  }

  async revoke(mastercardAgentId: string): Promise<void> {
    const { status, body } = await this.http.post(this.http.cfg.paths.revokeAgent, { agentId: mastercardAgentId })
    if (status >= 300) throw new Error(`AP4M agent revocation failed (${status}): ${JSON.stringify(body)}`)
  }
}

/**
 * Asks Mastercard to authorize one purchase against the agent's registered intent. The VI hash identifies the
 * credential chain; the settlement fields tell AP4M which stablecoin rail will carry the payment.
 */
export class Ap4mNetworkAuthorizer implements NetworkAuthorizer {
  private readonly http: Ap4mHttp

  constructor(cfg: Ap4mConfig, sign?: RequestSigner, fetchFn?: typeof fetch) {
    this.http = new Ap4mHttp(cfg, sign, fetchFn)
  }

  async authorize(req: AuthorizationRequest): Promise<AuthorizationResult> {
    const { status, body } = await this.http.post<{ approved?: boolean; authorizationId?: string; declineReason?: string; id?: string }>(
      this.http.cfg.paths.authorize,
      {
        agentId: req.mastercardAgentId,
        intentHash: req.viHash,
        amount: { value: (req.amountCents / 100).toFixed(2), currency: req.currency },
        merchantId: req.merchantId,
        mode: req.mode,
        settlement: { network: this.http.cfg.settlementNetwork, asset: this.http.cfg.settlementAsset },
      },
    )
    if (status >= 500) throw new Error(`AP4M unavailable (${status})`)
    const authorizationId = body.authorizationId ?? body.id ?? ''
    if (status >= 300 || body.approved === false) {
      return { approved: false, authorizationId, declineReason: body.declineReason ?? `HTTP ${status}` }
    }
    return { approved: body.approved === true, authorizationId, declineReason: body.approved === true ? undefined : 'no approval in response' }
  }
}
