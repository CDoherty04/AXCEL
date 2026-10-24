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
}

/**
 * The network authorization step. Keep everything Mastercard-shaped behind this interface so the mock can be
 * swapped for the Agent Pay sandbox/production API without touching the scoring or spend code.
 */
export interface NetworkAuthorizer {
  authorize(req: AuthorizationRequest): Promise<AuthorizationResult>
}

export class MockAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<string, boolean>()

  async register(): Promise<{ mastercardAgentId: string }> {
    const id = `agt_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    this.agents.set(id, true)
    return { mastercardAgentId: id }
  }

  async isRegistered(id: string): Promise<boolean> {
    return this.agents.get(id) === true
  }

  async revoke(id: string): Promise<void> {
    this.agents.set(id, false)
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
