import type { Express, Request } from 'express'
import { agentPay } from '../mastercard/x402Agent.js'
import { Paywall, runSlideProof } from '../mastercard/x402.js'

/** HTTP 402 resource, the separate agent payer, and the three-part settlement proof. */
export function mountX402(app: Express, paywall: Paywall): void {
  const id = (req: Request) => String(req.params.id)

  app.get('/x402/resources/:id', async (req, res, next) => {
    try {
      const result = await paywall.access(id(req), req.header('x-payment') ?? undefined)
      res.status(result.status).json(result.body)
    } catch (err) {
      next(err)
    }
  })

  app.post('/x402/resources/:id/pay', async (req, res, next) => {
    try {
      const result = await paywall.pay(id(req))
      if (result.status === 200) {
        res.status(200).json({
          resource: result.body,
          voucher: result.voucher,
          requirements: result.requirements,
          released: result.released,
          settledBeforeRelease: result.settledBeforeRelease,
          paymentHeader: result.header,
        })
        return
      }
      res.status(result.status).json(result.body)
    } catch (err) {
      next(err)
    }
  })

  app.post('/x402/agent', async (req, res, next) => {
    try {
      const resourceId = String(req.body?.resource ?? 'briefing')
      const host = req.get('host')
      if (!host) {
        res.status(400).json({ error: 'missing host' })
        return
      }
      const result = await agentPay({
        baseUrl: `${req.protocol}://${host}`,
        resourceId,
        redeem: (amount) => paywall.channel.redeem(amount),
        settle: (claimId) => paywall.settle(claimId),
        log: (line) => console.log(`[x402-agent] ${line}`),
      })
      res.status(result.declined ? 402 : 200).json(result)
    } catch (err) {
      next(err)
    }
  })

  app.post('/x402/settle', async (req, res, next) => {
    try {
      const claimId = String(req.body?.claimId ?? '')
      if (!claimId) {
        res.status(400).json({ error: 'claimId is required' })
        return
      }
      res.json(await paywall.settle(claimId))
    } catch (err) {
      next(err)
    }
  })

  app.post('/x402/proof', async (_req, res, next) => {
    try {
      res.json(await runSlideProof(paywall))
    } catch (err) {
      next(err)
    }
  })
}
