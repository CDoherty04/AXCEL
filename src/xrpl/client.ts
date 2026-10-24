import { Client, Wallet, isoTimeToRippleTime, rippleTimeToUnixTime, type SubmittableTransaction, type TxResponse } from 'xrpl'
import { networks, RIPPLE_EPOCH_OFFSET, type NetworkName } from '../config.js'

export class TxFailed extends Error {
  constructor(
    public readonly code: string,
    public readonly tx: unknown,
    public readonly result: unknown,
  ) {
    super(`transaction failed: ${code}`)
  }
}

/** Thin wrapper over xrpl.Client: connect, fund, submit-and-validate. One instance per network. */
export class Ledger {
  readonly client: Client

  private constructor(readonly network: NetworkName) {
    this.client = new Client(networks[network].url, { timeout: 30_000 })
  }

  static async connect(network: NetworkName): Promise<Ledger> {
    const l = new Ledger(network)
    await l.client.connect()
    return l
  }

  async close(): Promise<void> {
    if (this.client.isConnected()) await this.client.disconnect()
  }

  /** Fund a fresh wallet from the Devnet faucet. */
  async fund(): Promise<Wallet> {
    if (this.network !== 'devnet') throw new Error('faucet is only available on devnet')
    const { wallet } = await this.client.fundWallet()
    return wallet
  }

  /** Autofill, sign, submit and wait for validation. Throws TxFailed unless the result is tesSUCCESS. */
  async submit(tx: SubmittableTransaction, wallet: Wallet): Promise<TxResponse<SubmittableTransaction>> {
    const res = await this.client.submitAndWait(tx, { wallet, autofill: true })
    this.assertSuccess(tx, res)
    return res
  }

  /** Submit an already-signed blob. */
  async submitSigned(blob: string, tx?: unknown): Promise<TxResponse<SubmittableTransaction>> {
    const res = await this.client.submitAndWait(blob)
    this.assertSuccess(tx ?? blob, res)
    return res
  }

  private assertSuccess(tx: unknown, res: TxResponse<SubmittableTransaction>): void {
    const meta = res.result.meta
    const code = typeof meta === 'object' && meta !== null ? (meta as { TransactionResult: string }).TransactionResult : 'unknown'
    if (code !== 'tesSUCCESS') throw new TxFailed(code, tx, res.result)
  }

  async ledgerTime(): Promise<number> {
    const r = await this.client.request({ command: 'ledger', ledger_index: 'validated' })
    return rippleTimeToUnixTime(r.result.ledger.close_time) / 1000
  }
}

export const toRippleTime = (unixSeconds: number): number => unixSeconds - RIPPLE_EPOCH_OFFSET
export const fromRippleTime = (rippleSeconds: number): number => rippleSeconds + RIPPLE_EPOCH_OFFSET
export const nowUnix = (): number => Math.floor(Date.now() / 1000)
export { isoTimeToRippleTime }

export function createdNodes(res: TxResponse<SubmittableTransaction>, type: string): Record<string, unknown>[] {
  const meta = res.result.meta
  if (typeof meta !== 'object' || meta === null) return []
  const nodes = (meta as unknown as { AffectedNodes: Record<string, { LedgerEntryType: string; LedgerIndex: string; NewFields?: Record<string, unknown> }>[] }).AffectedNodes
  return nodes
    .map((n) => n.CreatedNode)
    .filter((n): n is NonNullable<typeof n> => !!n && n.LedgerEntryType === type)
    .map((n) => ({ LedgerIndex: n.LedgerIndex, ...n.NewFields }))
}
