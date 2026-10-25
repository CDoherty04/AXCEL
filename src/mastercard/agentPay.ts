import { randomUUID } from 'node:crypto'

/** Know Your Agent: registers an agent with the Acceptance Framework so its purchases count. */
export interface AgentRegistry {
  register(input: { ownerDid: string; agentDid: string; publicKeyThumbprint: string }): Promise<{ mastercardAgentId: string }>
  isRegistered(mastercardAgentId: string): Promise<boolean>
  revoke(mastercardAgentId: string): Promise<void>
}

export interface AuthorizationRequest {
  mastercardAgentId: string
  viHash: string
  amountCents: number
  currency: 'USD'
  merchantId: string
  mode: 'immediate' | 'autonomous'
}

export interface AuthorizationResult {
  approved: boolean
  authorizationId: string
  declineReason?: string
  /** Network-side proof of the authorization (for example the AP4M redemption), linked into the XRPL anchor memo. */
  evidence?: { network: string; channelId?: string; redeemTx?: string; claimId?: string; rlusd?: string }
}

export interface SettlementResult {
  settlementTx?: string
  payoutTx?: string
  receiptUrl?: string
}

/**
 * The network authorization step. Keep everything Mastercard-shaped behind this interface so the mock can be
 * swapped for the Agent Pay sandbox/production API without touching the scoring or spend code.
 */
export interface NetworkAuthorizer {
  authorize(req: AuthorizationRequest): Promise<AuthorizationResult>
  /** Release redeemed funds to the merchant and return the receipt. Optional: card rails settle on their own. */
  settle?(): Promise<SettlementResult>
  /** Close the spending channel. Optional. */
  close?(): Promise<string | undefined>
}

export class MockAgentRegistry implements AgentRegistry {
  // Only revocations are remembered: agents persist in the store across API restarts, but this registry does not,
  // so an unknown ID is a previously registered agent, not an unregistered one.
  private readonly revoked = new Set<string>()

  async register(): Promise<{ mastercardAgentId: string }> {
    return { mastercardAgentId: `agt_${randomUUID().replace(/-/g, '').slice(0, 20)}` }
  }

  async isRegistered(id: string): Promise<boolean> {
    return id.length > 0 && !this.revoked.has(id)
  }

  async revoke(id: string): Promise<void> {
    this.revoked.add(id)
  }
}

/** Approves anything from a registered agent. Hook `decline` to simulate network declines in tests. */
export class MockNetworkAuthorizer implements NetworkAuthorizer {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly decline: (r: AuthorizationRequest) => string | undefined = () => undefined,
  ) {}

  async authorize(req: AuthorizationRequest): Promise<AuthorizationResult> {
    const authorizationId = `auth_${randomUUID().slice(0, 12)}`
    if (!(await this.registry.isRegistered(req.mastercardAgentId))) {
      return { approved: false, authorizationId, declineReason: 'agent not registered (Know Your Agent)' }
    }
    const reason = this.decline(req)
    return reason ? { approved: false, authorizationId, declineReason: reason } : { approved: true, authorizationId }
  }
}
