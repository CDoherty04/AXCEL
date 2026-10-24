import { type AddressInfo } from 'node:net'
import { ethers } from 'ethers'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { Ap4mSession, type Ap4mSdk, ap4mConfigFromEnv } from '../src/mastercard/ap4m.js'
import { Ap4mPaymentChannel, LocalPaymentChannel, X402_CHAIN_ID } from '../src/mastercard/channel.js'
import { Paywall, X402_RESOURCES, runSlideProof } from '../src/mastercard/x402.js'
import { mountX402 } from '../src/api/x402Routes.js'

const KEY = '0x' + '11'.repeat(32)

function session(sdk: Ap4mSdk) {
  const fetchFn = (async (url: string) => {
    if (String(url).endsWith('/public/config')) {
      return new Response(JSON.stringify({
        network: { rpcUrl: 'http://127.0.0.1:1', chainId: 1449000 },
        contracts: { paymentLedger: '0x' + '22'.repeat(20) },
      }))
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return new Ap4mSession(
    ap4mConfigFromEnv({ TEAM_NAME: 'team', AGENT_PRIVATE_KEY: KEY, AP4M_API_URL: 'https://ap4m.test' } as NodeJS.ProcessEnv),
    sdk,
    fetchFn,
  )
}

describe('HTTP 402 paywall', () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it('proves control, pays from the 402 terms, releases the resource, then settles', async () => {
    const proof = await runSlideProof(new Paywall(new LocalPaymentChannel()))

    expect(proof.control.pspAttestedIdentity).toBe(false)
    expect(proof.control.identity.source).toBe('local')
    expect(proof.control.identity.agentId).toMatch(/^0x/)
    expect(proof.control.fundedChannelCap).toBe(true)
    expect(proof.control.channel.cap).toBe('1')
    expect(proof.control.overCapRejected).toBe(true)
    expect(proof.control.overCap.redeemedUnchanged).toBe(true)

    const terms = proof.payment.requirements
    expect(terms.x402Version).toBe(1)
    expect(terms.error).toBe('X-PAYMENT header is required')
    expect(terms.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'xrpl-evm-testnet',
      asset: 'RLUSD',
      resource: '/x402/resources/briefing',
      maxAmountRequired: X402_RESOURCES.briefing.price.toString(),
    })
    expect(proof.payment.voucher.signed).toBe(true)
    expect(proof.payment.released).toBe(true)
    expect(proof.payment.settledBeforeRelease).toBe(false)
    expect(proof.payment.resource.body).toMatch(/not been settled/)

    const signer = ethers.verifyTypedData(
      { name: 'AP4M Payment Ledger', version: '1', chainId: X402_CHAIN_ID, verifyingContract: `0x${'22'.repeat(20)}` },
      { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint256' }] },
      { channelId: proof.payment.voucher.channelId, cumulativeAmount: BigInt(proof.payment.voucher.cumulativeAmount) },
      proof.payment.voucher.signature!,
    )
    expect(signer).toBe(proof.control.identity.address)

    expect(proof.proof.voucherRedeemed.claimId).toBe(proof.payment.voucher.claimId)
    expect(proof.proof.claimPaid.tx).toMatch(/^0x/)
    expect(proof.proof.settlementRecorded.tx).toMatch(/^0x/)
    expect(proof.proof.receipt).toMatchObject({
      channelId: proof.payment.voucher.channelId,
      claimId: proof.payment.voucher.claimId,
      payoutTx: proof.proof.settlementRecorded.tx,
    })
  })

  it('answers 402 until the voucher header is presented', async () => {
    const app = express()
    app.use(express.json())
    mountX402(app, new Paywall(new LocalPaymentChannel()))
    const server = app.listen(0)
    servers.push({
      close: () => new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => err ? reject(err) : resolve())
      }),
    })
    const port = (server.address() as AddressInfo).port
    const url = `http://127.0.0.1:${port}/x402/resources/briefing`

    const challenge = await fetch(url)
    expect(challenge.status).toBe(402)
    const requirements = await challenge.json() as { accepts: { maxAmountRequired: string }[]; error: string }
    expect(requirements.error).toBe('X-PAYMENT header is required')
    expect(requirements.accepts[0]?.maxAmountRequired).toBe(X402_RESOURCES.briefing.price.toString())

    const paid = await fetch(`${url}/pay`, { method: 'POST' })
    expect(paid.status).toBe(200)
    const body = await paid.json() as { released: boolean; settledBeforeRelease: boolean; paymentHeader: string; resource: { title: string } }
    expect(body.released).toBe(true)
    expect(body.settledBeforeRelease).toBe(false)

    const unlocked = await fetch(url, { headers: { 'X-PAYMENT': body.paymentHeader } })
    expect(unlocked.status).toBe(200)
    expect((await unlocked.json() as { title: string }).title).toBe('Agent credit briefing')
  })

  it('rejects an over-cap AP4M voucher before it is submitted', async () => {
    const calls: string[] = []
    const sdk: Ap4mSdk = {
      signIn: async () => { calls.push('signIn'); return { token: 't', expiresInSeconds: 600, team: { agent_id: '0xpsp-agent' } } },
      listChannels: async () => [{ channel_id: '0xchan', channel_status: 'open' }],
      requestChannel: async () => { throw new Error('channel already open') },
      getChannelState: async () => ({ cap: ethers.parseUnits('1', 18), redeemed: 0n, validBefore: 0n, status: 1 }),
      redeemVoucher: async () => { calls.push('redeem'); return { claimId: '0xclaim', txHash: '0xtx' } },
      settle: async () => ({ settlement_tx: '0xs', payout_tx: '0xp' }),
      closeChannel: async () => ({ tx_hash: '0xclose' }),
    }
    const wall = new Paywall(new Ap4mPaymentChannel(session(sdk)))
    const identity = await wall.channel.identity()
    expect(identity).toMatchObject({ attested: true, source: 'psp', agentId: '0xpsp-agent' })

    const over = await wall.pay('archive')
    expect(over.status).toBe(402)
    if (over.status === 402) {
      expect(over.declined).toBe(true)
      expect(over.redeemedUnchanged).toBe(true)
      expect(over.reason).toMatch(/cap reached/)
    }
    expect(calls).not.toContain('redeem')
  })
})
