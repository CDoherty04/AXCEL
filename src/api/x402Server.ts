import express from 'express'
import { Ap4mSession, ap4mConfigFromEnv } from '../mastercard/ap4m.js'
import { Ap4mPaymentChannel, LocalPaymentChannel } from '../mastercard/channel.js'
import { Paywall } from '../mastercard/x402.js'
import { mountX402 } from './x402Routes.js'

const live = process.env.MASTERCARD_MODE === 'ap4m'
const paywall = new Paywall(live ? new Ap4mPaymentChannel(new Ap4mSession(ap4mConfigFromEnv())) : new LocalPaymentChannel())
const port = Number(process.env.X402_PORT ?? 4020)

const app = express()
app.use(express.json())
mountX402(app, paywall)
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

app.listen(port, () => {
  console.log(`x402 paywall on :${port} (${live ? 'Agent Pay for Machines' : 'local channel'})`)
})
