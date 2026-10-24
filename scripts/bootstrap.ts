import { bootstrapInfra } from '../src/credit/infra.js'
import { Store } from '../src/store/state.js'
import { ViBridge } from '../src/vi/bridge.js'
import { Ledger } from '../src/xrpl/client.js'

const ledger = await Ledger.connect('devnet')
const store = new Store(process.env.STATE_FILE ?? '.data/state.json')
const infra = await bootstrapInfra(ledger, store, new ViBridge())
console.log(JSON.stringify({ vault: infra.vaultId, broker: infra.brokerId, domains: infra.domains, subscriptionDate: infra.vaultSubscriptionDate }, null, 2))
await ledger.close()
