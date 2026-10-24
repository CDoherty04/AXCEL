import { describe, expect, it } from 'vitest'
import { chainHash, ViBridge } from '../../src/vi/bridge.js'

const M = { id: 'm-1', name: 'Acme API', website: 'https://acme.example' }
const ITEM = { id: 'credits', title: 'API credits' }

describe('Verifiable Intent bridge (pinned reference implementation)', async () => {
  const vi = new ViBridge()
  const [issuer, user, agent, merchant] = await Promise.all([vi.keygen(), vi.keygen(), vi.keygen(), vi.keygen()])
  const l1 = await vi.issueL1({ issuer, userPublicJwk: user.public_jwk, subject: 'u1' })

  it('validates an Autonomous chain inside its mandate', async () => {
    const l2 = await vi.autonomousMandate({ l1, user, agentPublicJwk: agent.public_jwk, agentKid: 'a1', merchants: [M], items: [ITEM], maxCents: 5000 })
    const p = await vi.autonomousPurchase({ l2, agent, agentKid: 'a1', merchant: M, item: ITEM, amountCents: 2500, merchantKey: merchant })
    const v = await vi.validate({ l1, l2, l3a: p.l3a, l2Payment: p.l2Payment }, issuer.public_jwk)
    expect(v).toMatchObject({ valid: true, mode: 'autonomous', amount_cents: 2500 })
  })

  it('rejects a purchase over the L2 maximum', async () => {
    const l2 = await vi.autonomousMandate({ l1, user, agentPublicJwk: agent.public_jwk, agentKid: 'a1', merchants: [M], items: [ITEM], maxCents: 5000 })
    const p = await vi.autonomousPurchase({ l2, agent, agentKid: 'a1', merchant: M, item: ITEM, amountCents: 9000, merchantKey: merchant })
    const v = await vi.validate({ l1, l2, l3a: p.l3a, l2Payment: p.l2Payment }, issuer.public_jwk)
    expect(v.valid).toBe(false)
    expect(v.errors.join(' ')).toMatch(/exceeds maximum/i)
  })

  it('rejects a chain whose L1 was signed by a different issuer', async () => {
    const fake = await vi.keygen()
    const bad = await vi.issueL1({ issuer: fake, userPublicJwk: user.public_jwk, subject: 'u1' })
    const l2 = await vi.immediateMandate({ l1: bad, user, merchant: M, item: ITEM, amountCents: 1000, merchantKey: merchant })
    expect((await vi.validate({ l1: bad, l2 }, issuer.public_jwk)).valid).toBe(false)
  })

  it('validates an Immediate chain and reads the final amount from L2', async () => {
    const l2 = await vi.immediateMandate({ l1, user, merchant: M, item: ITEM, amountCents: 1200, merchantKey: merchant })
    expect(await vi.validate({ l1, l2 }, issuer.public_jwk)).toMatchObject({ valid: true, mode: 'immediate', amount_cents: 1200 })
  })

  it('hashes the chain deterministically', () => {
    expect(chainHash({ l1: 'a', l2: 'b', l3a: 'c' })).toBe(chainHash({ l1: 'a', l2: 'b', l3a: 'c' }))
    expect(chainHash({ l1: 'a', l2: 'b', l3a: 'c' })).not.toBe(chainHash({ l1: 'a', l2: 'b' }))
  })
})
