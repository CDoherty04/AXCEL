import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Jwk, KeyPairJwk } from '../store/state.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface Merchant { id: string; name: string; website: string }
export interface Item { id: string; title: string }
export interface PaymentInstrument { type: string; id: string; description: string }

export interface ValidationResult {
  valid: boolean
  errors: string[]
  mode: 'immediate' | 'autonomous' | null
  amount_cents: number | null
  max_cents?: number | null
  payee: Merchant | null
}

export const DEFAULT_INSTRUMENT: PaymentInstrument = {
  type: 'mastercard.srcDigitalCard',
  id: 'f199c3dd-7106-478b-9b5f-7af9ca725170',
  description: 'Mastercard **** 1234',
}

/** The serialized chain a purchase carries: L1 + L2 (+ L3a for Autonomous mode). */
export interface ViChain {
  l1: string
  l2: string
  l3a?: string
  /** L2 presentation disclosing the payment mandate to the network (Autonomous). */
  l2Payment?: string
}

/** What goes in the XRPL payment memo: sha256 over the serialized chain, so the chain itself stays off-ledger. */
export function chainHash(c: ViChain): string {
  return createHash('sha256')
    .update([c.l1, c.l2, c.l3a ?? ''].join('\n'))
    .digest('hex')
    .toUpperCase()
}

/** Calls the Python bridge in vi_bridge/ which wraps the pinned verifiable-intent reference implementation. */
export class ViBridge {
  private readonly python: string
  private readonly script = join(root, 'vi_bridge', 'bridge.py')

  constructor(python?: string) {
    const venv = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')
    this.python = python ?? process.env.VI_PYTHON ?? (existsSync(venv) ? venv : 'python')
  }

  private call<T>(req: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.python, [this.script], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (err += d))
      p.on('error', reject)
      p.on('close', () => {
        try {
          const res = JSON.parse(out) as { ok: boolean; error?: string } & T
          if (!res.ok) reject(new Error(res.error ?? 'bridge error'))
          else resolve(res)
        } catch {
          reject(new Error(`bridge produced no JSON: ${err || out}`))
        }
      })
      p.stdin.end(JSON.stringify(req))
    })
  }

  keygen(): Promise<KeyPairJwk> {
    return this.call<KeyPairJwk>({ cmd: 'keygen' })
  }

  async issueL1(a: { issuer: KeyPairJwk; userPublicJwk: Jwk; subject: string; email?: string; ttl?: number }): Promise<string> {
    const r = await this.call<{ l1: string }>({
      cmd: 'issue_l1',
      issuer_private_jwk: a.issuer.private_jwk,
      user_public_jwk: a.userPublicJwk,
      subject: a.subject,
      email: a.email,
      ttl: a.ttl,
    })
    return r.l1
  }

  /** The user signs constraints delegating to an agent key (Autonomous mode). */
  async autonomousMandate(a: {
    l1: string
    user: KeyPairJwk
    agentPublicJwk: Jwk
    agentKid: string
    merchants: Merchant[]
    items: Item[]
    maxCents: number
    ttl?: number
    summary?: string
    instrument?: PaymentInstrument
  }): Promise<string> {
    const r = await this.call<{ l2: string }>({
      cmd: 'autonomous_l2',
      l1: a.l1,
      user_private_jwk: a.user.private_jwk,
      agent_public_jwk: a.agentPublicJwk,
      agent_kid: a.agentKid,
      merchants: a.merchants,
      acceptable_items: a.items,
      max_cents: a.maxCents,
      ttl: a.ttl,
      summary: a.summary,
      payment_instrument: a.instrument ?? DEFAULT_INSTRUMENT,
    })
    return r.l2
  }

  /** The agent builds its L3 payment/checkout credentials inside an existing L2 mandate. */
  async autonomousPurchase(a: {
    l2: string
    agent: KeyPairJwk
    agentKid: string
    merchant: Merchant
    item: Item
    amountCents: number
    merchantKey: KeyPairJwk
    instrument?: PaymentInstrument
  }): Promise<{ l3a: string; l3b: string; l2Payment: string; checkoutHash: string }> {
    const r = await this.call<{ l3a: string; l3b: string; l2_payment: string; checkout_hash: string }>({
      cmd: 'autonomous_l3',
      l2: a.l2,
      agent_private_jwk: a.agent.private_jwk,
      agent_kid: a.agentKid,
      merchant: a.merchant,
      item: a.item,
      amount_cents: a.amountCents,
      merchant_private_jwk: a.merchantKey.private_jwk,
      payment_instrument: a.instrument ?? DEFAULT_INSTRUMENT,
    })
    return { l3a: r.l3a, l3b: r.l3b, l2Payment: r.l2_payment, checkoutHash: r.checkout_hash }
  }

  /** The user approves one specific purchase (Immediate mode): L2 carries final values, no delegation. */
  async immediateMandate(a: {
    l1: string
    user: KeyPairJwk
    merchant: Merchant
    item: Item
    amountCents: number
    merchantKey: KeyPairJwk
    summary?: string
    instrument?: PaymentInstrument
  }): Promise<string> {
    const r = await this.call<{ l2: string }>({
      cmd: 'immediate',
      l1: a.l1,
      user_private_jwk: a.user.private_jwk,
      merchant: a.merchant,
      item: a.item,
      amount_cents: a.amountCents,
      merchant_private_jwk: a.merchantKey.private_jwk,
      summary: a.summary,
      payment_instrument: a.instrument ?? DEFAULT_INSTRUMENT,
    })
    return r.l2
  }

  /** Network-side verification: chain signatures and bindings, then STRICT constraint checking. */
  validate(chain: ViChain, issuerPublicJwk: Jwk): Promise<ValidationResult> {
    return this.call<ValidationResult>({
      cmd: 'validate',
      l1: chain.l1,
      l2: chain.l2,
      l3a: chain.l3a,
      l2_payment: chain.l2Payment,
      issuer_public_jwk: issuerPublicJwk,
    })
  }
}
