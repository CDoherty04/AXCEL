import type { Express, Request } from 'express'
import { Paywall, runSlideProof } from '../mastercard/x402.js'

/** HTTP 402 resource, voucher payment, and the three-part settlement proof. */
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
