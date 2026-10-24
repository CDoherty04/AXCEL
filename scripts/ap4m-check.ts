/** Readiness check for the real Agent Pay for Machines integration. Read-only: signs in and reads state; never spends. */
import { ethers } from 'ethers'
import { loadQuicknodeEnv } from '../src/lib/quicknode.js'
import { Ap4mSession, ap4mConfigFromEnv } from '../src/mastercard/ap4m.js'

loadQuicknodeEnv()
const s = new Ap4mSession(ap4mConfigFromEnv())
const ok = (m: string) => console.log(`  ok   ${m}`)
const todo = (m: string) => console.log(`  TODO ${m}`)

const token = await s.login()
const team = await s.teamInfo()
const cfg = await s.serviceConfig()
ok(`signed in as team ${String(team.team_name ?? '')} (agent wallet ${s.wallet.address})`)
ok(`service on chain ${cfg.chainId}, PaymentLedger ${cfg.paymentLedger}`)

const me = await (await fetch(`${s.cfg.apiUrl}/public/participant/me`, { headers: { Authorization: `Bearer ${token}` } })).json() as {
  team: { rlusd_allocation: string; merchant_wallet: string }; paymentState: { allocation_status: string; vault_funded: boolean }; channels: unknown[]
}
ok(`RLUSD allocation ${me.team.rlusd_allocation} (${me.paymentState.allocation_status}), vault funded: ${me.paymentState.vault_funded}`)
ok(`merchant payout wallet ${me.team.merchant_wallet}`)

const gas = await (await s.provider()).getBalance(s.wallet.address)
if (gas === 0n) todo(`agent wallet has no gas: fund ${s.wallet.address} at https://faucet.testevm.ripple.com (needed to open a channel and redeem vouchers)`)
else ok(`agent gas ${ethers.formatEther(gas)} XRP`)
console.log(me.channels.length ? `  ok   ${me.channels.length} channel(s) exist` : '  note no channel yet; one opens on the first authorization')
