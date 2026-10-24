import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { createService } from '../bootstrap.js'
import { EventFeed } from '../feed.js'
import { HttpError } from '../store/state.js'
import type { CreditService } from '../service.js'
import type { ViChain } from '../vi/bridge.js'
import { Wallet } from 'xrpl'

const item = z.object({ id: z.string(), title: z.string() })
const chain = z.object({ l1: z.string(), l2: z.string(), l3a: z.string().optional(), l2Payment: z.string().optional() })

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).then((out) => out !== undefined && res.json(out), next)

/**
 * HTTP API. DEMO MODE: the service custodies user and agent keys so a single process can drive the whole flow.
 * Do not expose it publicly: there is no authentication. Production signs client-side and authenticates users.
 */
export function buildApp(service: CreditService) {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  const p = (req: Request, k: string): string => String(req.params[k])

  app.get('/health', (_req, res) => res.json({ ok: true, networks: { history: 'mainnet (QuickNode)', credit: 'devnet' } }))

  // Identity ---------------------------------------------------------------
  app.get('/did/:account', wrap((req) => {
    const doc = service.didDocument(p(req, 'account'))
    if (!doc) throw new HttpError(404, 'unknown DID')
    return doc
  }))
  app.post('/users', wrap((req) => service.createUser(req.body?.id)))
  app.post('/users/:id/link/challenge', wrap((req) => service.startLink(p(req, 'id'), z.object({ mainnetAccount: z.string() }).parse(req.body).mainnetAccount)))
  app.post('/users/:id/link/confirm', wrap((req) => {
    const proof = z.object({ signature: z.string(), publicKey: z.string() })
    service.confirmLink(p(req, 'id'), z.object({ mainnet: proof, devnet: proof }).parse(req.body))
    return { linked: true }
  }))
  app.post('/users/:id/kya', wrap((req) =>
    service.verifyOwner(p(req, 'id'), z.object({ legalName: z.string(), country: z.string(), documentId: z.string() }).parse(req.body))))

  // Score and tier ---------------------------------------------------------
  app.post('/users/:id/cold-start', wrap(async (req) => {
    const r = await service.coldStart(p(req, 'id'))
    return { score: r.score, tier: r.tier, rawTier: r.rawTier, reasons: r.reasons, terms: r.terms }
  }))
  app.get('/users/:id/score', wrap((req) => service.rescore(p(req, 'id'))))
  app.post('/users/:id/tier', wrap((req) => service.syncTier(p(req, 'id'))))

  // Credit -----------------------------------------------------------------
  app.get('/users/:id/credit', wrap((req) => service.creditState(p(req, 'id'))))
  app.post('/users/:id/borrow', wrap((req) => service.borrow(p(req, 'id'), req.body?.amount === undefined ? undefined : z.number().positive().parse(req.body.amount))))
  app.post('/users/:id/repay', wrap((req) => service.repay(p(req, 'id'), z.object({ full: z.boolean().optional(), amount: z.number().positive().optional() }).parse(req.body ?? {}))))
  app.get('/users/:id/profile', wrap((req) => service.profile(p(req, 'id'))))

  // Agents -----------------------------------------------------------------
  app.post('/users/:id/agents', wrap((req) => service.addAgent(p(req, 'id'), z.object({
    label: z.string(),
    mode: z.enum(['immediate', 'autonomous']),
    maxCents: z.number().int().positive(),
    budgetCents: z.number().int().positive(),
    merchantIds: z.array(z.string()).min(1),
    items: z.array(item).min(1),
  }).parse(req.body))))
  app.delete('/agents/:id', wrap((req) => service.revokeAgent(p(req, 'id'))))
  // An external agent presents its own VI chain.
  app.post('/agents/:id/purchases', wrap((req) => service.settlePurchase(p(req, 'id'), chain.parse(req.body) as ViChain)))
  // Demo: the service plays the agent and builds the chain itself.
  app.post('/agents/:id/demo-purchase', wrap((req) => service.purchase(p(req, 'id'), z.object({
    merchantId: z.string(), item, amountCents: z.number().int().positive(),
  }).parse(req.body))))

  // Mock merchants ---------------------------------------------------------
  app.post('/merchants', wrap((req) => service.registerMerchant(z.object({ name: z.string(), website: z.string() }).parse(req.body))))

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message })
    if (err instanceof z.ZodError) return void res.status(400).json({ error: 'invalid request', issues: err.issues })
    const code = (err as { code?: string }).code
    console.error(err)
    res.status(code?.startsWith('tec') ? 422 : 500).json({ error: err instanceof Error ? err.message : String(err), code })
  })
  return app
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const port = Number(process.env.PORT ?? 3000)
  const w = await createService({ log: (m) => console.log(m) })
  const feed = new EventFeed(w.service)
  await feed.start()
  buildApp(w.service).listen(port, () => console.log(`credit layer API on :${port} (demo custody mode, no auth)`))
  void Wallet
}
