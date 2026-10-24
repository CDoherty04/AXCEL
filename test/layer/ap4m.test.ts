import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Ap4mAgentRegistry, Ap4mNetworkAuthorizer, Ap4mNotConfigured, ap4mConfigFromEnv } from '../../src/mastercard/ap4m.js'

describe('Agent Pay for Machines adapter', () => {
  let server: Server
  let base = ''
  const seen: { path: string; auth?: string; body: any }[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {}
        seen.push({ path: req.url!, auth: req.headers.authorization, body })
        res.setHeader('content-type', 'application/json')
        if (req.url === '/agents') return void res.end(JSON.stringify({ agentId: 'agt_real_1' }))
        if (req.url === '/authorize') {
          return void res.end(JSON.stringify(body.amount.value === '99.00' ? { approved: false, id: 'a2', declineReason: 'limit' } : { approved: true, id: 'a1' }))
        }
        res.end('{}')
      })
    }).listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => void server.close())

  const cfg = () => ap4mConfigFromEnv({
    AP4M_BASE_URL: base, AP4M_API_KEY: 'k', AP4M_PATH_REGISTER_AGENT: '/agents', AP4M_PATH_REVOKE_AGENT: '/agents/revoke',
    AP4M_PATH_AUTHORIZE: '/authorize', AP4M_SETTLEMENT_NETWORK: 'xrpl-devnet',
  } as NodeJS.ProcessEnv)

  it('refuses to start unconfigured instead of silently mocking', () => {
    expect(() => ap4mConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(Ap4mNotConfigured)
  })

  it('registers an agent and returns the Mastercard agent id', async () => {
    const r = await new Ap4mAgentRegistry(cfg()).register({ ownerDid: 'did:o', agentDid: 'did:a', publicKeyThumbprint: 't' })
    expect(r.mastercardAgentId).toBe('agt_real_1')
    expect(seen.at(-1)).toMatchObject({ path: '/agents', auth: 'Bearer k' })
  })

  it('sends the VI hash and settlement rail, and maps approve and decline', async () => {
    const a = new Ap4mNetworkAuthorizer(cfg())
    const base = { mastercardAgentId: 'agt', viHash: 'ABC', currency: 'USD' as const, merchantId: 'm', mode: 'autonomous' as const }
    const ok = await a.authorize({ ...base, amountCents: 2500 })
    expect(ok).toMatchObject({ approved: true, authorizationId: 'a1' })
    expect(seen.at(-1)!.body).toMatchObject({ intentHash: 'ABC', amount: { value: '25.00', currency: 'USD' }, settlement: { network: 'xrpl-devnet', asset: 'RLUSD' } })
    expect(await a.authorize({ ...base, amountCents: 9900 })).toMatchObject({ approved: false, declineReason: 'limit' })
  })
})
