import { Wallet } from 'xrpl'
import { describe, expect, it } from 'vitest'
import { createChallenge, signChallenge, verifyChallenge } from '../src/identity/challenge.js'
import { hashDocument, userDocument, agentDocument, didFor } from '../src/identity/did.js'
import { findSelfDealing } from '../src/scoring/antiGaming.js'
import type { AgentRecord, UserRecord } from '../src/store/state.js'

describe('ownership challenge', () => {
  const main = Wallet.generate()
  const dev = Wallet.generate()
  const c = createChallenge(main.address, dev.address, 1_000)

  it('accepts signatures from the right keys', () => {
    expect(verifyChallenge(c.message, signChallenge(main, c.message), main.publicKey, main.address)).toBe(true)
    expect(verifyChallenge(c.message, signChallenge(dev, c.message), dev.publicKey, dev.address)).toBe(true)
  })

  it("rejects someone else's key, a swapped account and a tampered message", () => {
    const other = Wallet.generate()
    expect(verifyChallenge(c.message, signChallenge(other, c.message), other.publicKey, main.address)).toBe(false)
    expect(verifyChallenge(c.message, signChallenge(dev, c.message), dev.publicKey, main.address)).toBe(false)
    expect(verifyChallenge(c.message + 'x', signChallenge(main, c.message), main.publicKey, main.address)).toBe(false)
  })

  it('binds both addresses into the message', () => {
    expect(c.message).toContain(main.address)
    expect(c.message).toContain(dev.address)
  })
})

describe('DID documents', () => {
  const agent = { id: 'ag1', account: 'rAgent', did: didFor('rAgent'), status: 'active', mode: 'autonomous', mastercardAgentId: 'agt_1', viKey: { public_jwk: { x: '1' } } } as unknown as AgentRecord
  const user = { account: 'rUser', viUserKey: { public_jwk: { x: '2' } }, agents: { ag1: agent } } as unknown as UserRecord

  it('lists active agents and drops revoked ones', () => {
    expect(userDocument(user).service.map((s) => s.account)).toEqual(['rAgent'])
    agent.status = 'revoked'
    expect(userDocument(user).service).toHaveLength(0)
    agent.status = 'active'
  })

  it('hashes deterministically and detects change', () => {
    const h = hashDocument(userDocument(user))
    expect(hashDocument(userDocument(user))).toBe(h)
    agent.status = 'revoked'
    expect(hashDocument(userDocument(user))).not.toBe(h)
    agent.status = 'active'
  })

  it('names the user as the agent controller', () => {
    expect(agentDocument(user, agent).controller).toBe(didFor('rUser'))
  })
})

describe('self-dealing detection', () => {
  const resolver = {
    fundingSource: async (a: string) => ({ rSibling: 'rFunder', rStranger: 'rOther' } as Record<string, string>)[a],
    didController: async (a: string) => ({ rControlled: 'did:xrpl:3:rUser' } as Record<string, string>)[a],
  }
  it('flags own accounts, shared funding sources and user-controlled DIDs', async () => {
    const out = await findSelfDealing(
      ['rUser', 'rAgent', 'rSibling', 'rControlled', 'rStranger'],
      { ownedAccounts: ['rUser', 'rAgent'], fundingSources: ['rFunder'], didControllers: ['did:xrpl:3:rUser'] },
      resolver,
    )
    expect([...out].sort()).toEqual(['rAgent', 'rControlled', 'rSibling', 'rUser'])
  })
})
