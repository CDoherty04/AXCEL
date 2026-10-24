import { MockKycProvider } from './identity/kya.js'
import { MockAgentRegistry, MockNetworkAuthorizer, type AgentRegistry, type NetworkAuthorizer } from './mastercard/agentPay.js'
import { Ap4mAgentRegistry, Ap4mNetworkAuthorizer, Ap4mSession, ap4mConfigFromEnv } from './mastercard/ap4m.js'
import { loadQuicknodeEnv } from './lib/quicknode.js'
import { QuickNodeHistoryReader } from './scoring/quicknodeHistory.js'
import { LedgerMerchantResolver } from './scoring/antiGaming.js'
import { StaticHistoryReader, XrplHistoryReader, type HistoryReader } from './scoring/history.js'
import { CreditService } from './service.js'
import { Store } from './store/state.js'
import { ViBridge } from './vi/bridge.js'
import { Ledger } from './xrpl/client.js'
import { bootstrapInfra, waitForLending } from './credit/infra.js'
import type { DidDocument } from './identity/did.js'

export interface Wiring {
  service: CreditService
  ledger: Ledger
  store: Store
  registry: AgentRegistry
  close(): Promise<void>
}

/** Build a CreditService against Devnet. Mainnet history comes from QuickNode unless a reader is injected. */
export async function createService(opts: {
  stateFile?: string
  mainnetHistory?: HistoryReader
  authorizer?: (registry: MockAgentRegistry) => NetworkAuthorizer
  log?: (m: string) => void
} = {}): Promise<Wiring> {
  loadQuicknodeEnv() // loads .env.local without overriding the shell
  const log = opts.log ?? (() => {})
  const ledger = await Ledger.connect('devnet')
  const store = new Store(opts.stateFile ?? process.env.STATE_FILE ?? '.data/state.json')
  const vi = new ViBridge()
  const infra = await bootstrapInfra(ledger, store, vi)
  await waitForLending(ledger, infra, log)

  // MASTERCARD_MODE=ap4m switches Know Your Agent and authorization to the real Agent Pay for Machines APIs.
  // It fails loudly if unconfigured; it never falls back to the mock.
  let registry: AgentRegistry
  let authorizer: NetworkAuthorizer
  if (process.env.MASTERCARD_MODE === 'ap4m') {
    const session = new Ap4mSession(ap4mConfigFromEnv())
    registry = new Ap4mAgentRegistry(session)
    authorizer = new Ap4mNetworkAuthorizer(session)
    log('Mastercard: Agent Pay for Machines (real)')
  } else {
    const mock = new MockAgentRegistry()
    registry = mock
    authorizer = opts.authorizer?.(mock) ?? new MockNetworkAuthorizer(mock)
    log('Mastercard: mock (set MASTERCARD_MODE=ap4m for the real APIs)')
  }
  // DID documents are served by this service; the resolver reads them straight from the store.
  let service: CreditService
  const fetchDoc = async (uri: string): Promise<DidDocument> => {
    const account = uri.split('/').pop()!
    const doc = service.didDocument(account)
    if (!doc) throw new Error(`no DID document for ${account}`)
    return doc
  }
  service = new CreditService({
    ledger, store, vi, registry, authorizer,
    kyc: new MockKycProvider(),
    mainnetHistory: opts.mainnetHistory ?? (process.env.QUICKNODE_XRP_RPC_URL ? new QuickNodeHistoryReader() : new XrplHistoryReader('mainnet')),
    resolver: new LedgerMerchantResolver(ledger, fetchDoc),
  })
  return { service, ledger, store, registry, close: () => ledger.close() }
}

export { StaticHistoryReader }
