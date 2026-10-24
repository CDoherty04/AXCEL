import { signLoanSetByCounterparty, signMultiBatch, type Batch, type SubmittableTransaction, type Wallet } from 'xrpl'
import { loanTerms } from '../config.js'
import type { Infra } from '../store/state.js'
import { createdNodes, type Ledger } from '../xrpl/client.js'
import { tokenAmount } from './infra.js'

export const TF_LOAN_OVERPAYMENT = 0x10000
export const TF_LOAN_FULL_PAYMENT = 0x20000
export const TF_INNER_BATCH_TXN = 0x40000000
export const TF_ALL_OR_NOTHING = 0x10000

export interface LoanState {
  loanId: string
  principalOutstanding: number
  totalValueOutstanding: number
  paymentsRemaining: number
  periodicPayment: number
  nextPaymentDueDate?: number
  raw: Record<string, unknown>
}

export async function readLoan(ledger: Ledger, loanId: string): Promise<LoanState | null> {
  const r = await ledger.client.request({ command: 'ledger_entry', index: loanId }).catch(() => null)
  const n = r?.result.node as Record<string, string | number> | undefined
  if (!n || n.LedgerEntryType !== 'Loan') return null
  return {
    loanId,
    principalOutstanding: Number(n.PrincipalOutstanding ?? 0),
    totalValueOutstanding: Number(n.TotalValueOutstanding ?? 0),
    paymentsRemaining: Number(n.PaymentRemaining ?? 0),
    periodicPayment: Number(n.PeriodicPayment ?? 0),
    nextPaymentDueDate: n.NextPaymentDueDate !== undefined ? Number(n.NextPaymentDueDate) : undefined,
    raw: n,
  }
}

async function ensureTrustline(ledger: Ledger, infra: Infra, user: Wallet): Promise<void> {
  const token = tokenAmount(infra, '0')
  const lines = await ledger.client.request({ command: 'account_lines', account: user.address, peer: token.issuer })
  if (lines.result.lines.some((l) => l.currency === token.currency)) return
  await ledger.submit(
    { TransactionType: 'TrustSet', Account: user.address, LimitAmount: { currency: token.currency, issuer: token.issuer, value: '100000000' } },
    user,
  )
}

export async function tokenBalance(ledger: Ledger, infra: Infra, account: string): Promise<number> {
  const token = tokenAmount(infra, '0')
  const lines = await ledger.client.request({ command: 'account_lines', account, peer: token.issuer })
  return Number(lines.result.lines.find((l) => l.currency === token.currency)?.balance ?? 0)
}

/**
 * Open a loan. The loan broker (the service) is the LoanSet Account and the user is the Counterparty, so the
 * underwriting decision (the broker's signature) and the borrower's consent are both on the transaction.
 * The overpayment flag is set so early payoff works.
 */
export async function openLoan(
  ledger: Ledger,
  infra: Infra,
  service: Wallet,
  user: Wallet,
  principal: number,
): Promise<{ loanId: string; txHash: string }> {
  await ensureTrustline(ledger, infra, user)
  const tx = await ledger.client.autofill({
    TransactionType: 'LoanSet',
    Account: service.address,
    Counterparty: user.address,
    LoanBrokerID: infra.brokerId,
    PrincipalRequested: String(principal),
    InterestRate: loanTerms.interestRate,
    PaymentTotal: loanTerms.paymentTotal,
    PaymentInterval: loanTerms.paymentInterval,
    GracePeriod: loanTerms.gracePeriod,
    Flags: TF_LOAN_OVERPAYMENT,
  } as SubmittableTransaction)
  const brokerSigned = service.sign(tx)
  const both = signLoanSetByCounterparty(user, brokerSigned.tx_blob)
  const res = await ledger.submitSigned(both.tx_blob)
  const loan = createdNodes(res, 'Loan')[0]
  if (!loan) throw new Error('LoanSet succeeded but no Loan object was created')
  return { loanId: loan.LedgerIndex as string, txHash: res.result.hash }
}

/** Amount that settles a loan in full right now. */
export async function payoffAmount(ledger: Ledger, loanId: string): Promise<number> {
  const l = await readLoan(ledger, loanId)
  return l ? l.totalValueOutstanding : 0
}

const inner = <T extends SubmittableTransaction>(tx: T): T => ({ ...tx, Flags: TF_INNER_BATCH_TXN, Fee: '0', SigningPubKey: '' }) as T

/**
 * Swap the user's CreditTier credential (delete old, create new, accept) as one atomic Batch, so the user is
 * never left without a credential mid-refresh. The user is the outer account; the service signs as a BatchSigner
 * for the credential transactions it issues.
 *
 * LoanPay cannot go inside the Batch: on the current Devnet build a LoanPay inner transaction is rejected with
 * temINVALID_INNER_BATCH (verified; a credential-only Batch succeeds). Repayment is therefore a LoanPay followed
 * by this Batch, and the service reconciles if the second step ever fails.
 */
export async function submitCredentialRefreshBatch(
  ledger: Ledger,
  user: Wallet,
  service: Wallet,
  parts: { serviceTxs: SubmittableTransaction[]; userTxs: SubmittableTransaction[] },
): Promise<string> {
  const raws = [...parts.serviceTxs, ...parts.userTxs].map((tx) => ({ RawTransaction: inner(tx) }))
  const batch = (await ledger.client.autofill(
    { TransactionType: 'Batch', Account: user.address, Flags: TF_ALL_OR_NOTHING, RawTransactions: raws } as Batch,
    1,
  )) as Batch
  signMultiBatch(service, batch)
  const signed = user.sign(batch)
  const res = await ledger.submitSigned(signed.tx_blob)
  return res.result.hash
}
