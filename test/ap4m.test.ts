import { ethers } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  Ap4mAgentRegistry, Ap4mNetworkAuthorizer, Ap4mNotConfigured, Ap4mSession, ap4mConfigFromEnv, type Ap4mSdk,
} from '../src/mastercard/ap4m.js'

const KEY = '0x' + '11'.repeat(32)
const cfg = () => ap4mConfigFromEnv({ TEAM_NAME: 'team', AGENT_PRIVATE_KEY: KEY, AP4M_API_URL: 'https://ap4m.test', CHANNEL_CAP: '5' } as NodeJS.ProcessEnv)

/** An SDK double that keeps channel state the way the PaymentLedger contract does (cumulative vouchers). */
function fakeSdk(capRlusd = '1') {
  const calls: string[] = []
  const state = { cap: ethers.parseUnits(capRlusd, 18), redeemed: 0n }
  const sdk: Ap4mSdk = {
    signIn: async () => { calls.push('signIn'); return { token: 't', expiresInSeconds: 600, team: { agent_id: '0xagent' } } },
    listChannels: async () => [],
    requestChannel: async (_u, _t, _w, o) => { calls.push(`requestChannel:${o.capRlusd}`); return { channel_id: '0xchan' } },
    getChannelState: async () => ({ cap: state.cap, redeemed: state.redeemed, validBefore: 0n, status: 1 }),
    redeemVoucher: async (_w, _l, _r, _c, cumulative) => { calls.push(`redeem:${ethers.formatUnits(cumulative, 18)}`); state.redeemed = cumulative; return { claimId: '0xclaim' + calls.length, txHash: '0xtx' + calls.length } },
    settle: async () => ({ settlement_tx: '0xs', payout_tx: '0xp', receipt_url: '/receipts/1' }),
    closeChannel: async () => ({ tx_hash: '0xclose' }),
  }
  return { sdk, calls, state }
}

function session(sdk: Ap4mSdk) {
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/public/config')) {
      return new Response(JSON.stringify({ network: { rpcUrl: 'http://127.0.0.1:1', chainId: 1449000 }, contracts: { paymentLedger: '0x' + '22'.repeat(20) } }))
    }
    if (String(url).endsWith('/record-redemption')) return new Response(JSON.stringify({ claim_id: 'claim-' + JSON.parse(String(init?.body)).tx_hash }))
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return new Ap4mSession(cfg(), sdk, fetchFn)
}

let seq = 0
/** Each purchase has its own chain hash; the same hash means the same purchase. */
const req = (amountCents: number, viHash = `H${++seq}`) => ({ mastercardAgentId: 'a', viHash, amountCents, currency: 'USD' as const, merchantId: 'm', mode: 'autonomous' as const })

describe('Agent Pay for Machines adapter', () => {
  it('refuses to start unconfigured instead of silently mocking', () => {
    expect(() => ap4mConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(Ap4mNotConfigured)
  })

  it('opens a channel once, then redeems cumulative vouchers scaled to RLUSD', async () => {
    const { sdk, calls } = fakeSdk('1')
    const auth = new Ap4mNetworkAuthorizer(session(sdk))
    // The fake provider is never reached: state comes from the SDK double.
    const a = await auth.authorize(req(3500))
    const b = await auth.authorize(req(2500))
    expect(a.approved && b.approved).toBe(true)
    expect(calls.filter((c) => c.startsWith('requestChannel'))).toEqual(['requestChannel:5'])
    expect(calls.filter((c) => c.startsWith('redeem'))).toEqual(['redeem:0.35', 'redeem:0.6'])
    expect(a.evidence).toMatchObject({ network: 'xrpl-evm-testnet', channelId: '0xchan', rlusd: '0.35' })
    expect(a.authorizationId).toMatch(/^claim-/)
  })

  it('declines when the channel cap would be exceeded, without redeeming', async () => {
    const { sdk, calls } = fakeSdk('0.5')
    const auth = new Ap4mNetworkAuthorizer(session(sdk))
    expect((await auth.authorize(req(3500))).approved).toBe(true)
    const over = await auth.authorize(req(3500))
    expect(over.approved).toBe(false)
    expect(over.declineReason).toMatch(/cap reached/)
    expect(calls.filter((c) => c.startsWith('redeem'))).toHaveLength(1)
  })

  it('serializes concurrent authorizations so cumulative amounts never collide', async () => {
    const { sdk, calls } = fakeSdk('10')
    const auth = new Ap4mNetworkAuthorizer(session(sdk))
    await Promise.all([auth.authorize(req(1000)), auth.authorize(req(1000)), auth.authorize(req(1000))])
    expect(calls.filter((c) => c.startsWith('redeem'))).toEqual(['redeem:0.1', 'redeem:0.2', 'redeem:0.3'])
  })

  it('settles and closes the channel', async () => {
    const { sdk } = fakeSdk()
    const auth = new Ap4mNetworkAuthorizer(session(sdk))
    await auth.authorize(req(1000))
    expect(await auth.settle()).toMatchObject({ payoutTx: '0xp', receiptUrl: 'https://ap4m.test/receipts/1' })
    expect(await auth.close()).toBe('0xclose')
  })

  it('gives each credit-layer agent its own handle and revokes one without the others', async () => {
    const reg = new Ap4mAgentRegistry(session(fakeSdk().sdk))
    const a = await reg.register({ ownerDid: 'did:o', agentDid: 'did:a1' })
    const b = await reg.register({ ownerDid: 'did:o', agentDid: 'did:a2' })
    expect(a.mastercardAgentId).not.toBe(b.mastercardAgentId)
    await reg.revoke(a.mastercardAgentId)
    expect(await reg.isRegistered(a.mastercardAgentId)).toBe(false)
    expect(await reg.isRegistered(b.mastercardAgentId)).toBe(true)
  })
})

describe('Agent Pay for Machines idempotency', () => {
  it('never redeems a second voucher when the same chain is authorized again', async () => {
    const { sdk, calls } = fakeSdk('10')
    const auth = new Ap4mNetworkAuthorizer(session(sdk))
    const a = await auth.authorize(req(2000, 'SAME'))
    const b = await auth.authorize(req(2000, 'SAME'))
    expect(b).toEqual(a)
    expect(calls.filter((c) => c.startsWith('redeem'))).toHaveLength(1)
  })

  it('re-reports a redemption that was not recorded, without redeeming again', async () => {
    const { sdk, calls } = fakeSdk('10')
    let reports = 0
    const flaky = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/public/config')) {
        return new Response(JSON.stringify({ network: { rpcUrl: 'http://127.0.0.1:1', chainId: 1449000 }, contracts: { paymentLedger: '0x' + '22'.repeat(20) } }))
      }
      if (String(url).endsWith('/record-redemption')) {
        if (++reports === 1) return new Response('{"error":"gateway"}', { status: 502 })
        return new Response(JSON.stringify({ claim_id: 'claim-ok' }))
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const auth = new Ap4mNetworkAuthorizer(new Ap4mSession(cfg(), sdk, flaky))
    await expect(auth.authorize(req(2000, 'RETRY'))).rejects.toThrow(/record-redemption failed/)
    const ok = await auth.authorize(req(2000, 'RETRY'))
    expect(ok).toMatchObject({ approved: true, authorizationId: 'claim-ok' })
    expect(calls.filter((c) => c.startsWith('redeem'))).toHaveLength(1)
  })
})
