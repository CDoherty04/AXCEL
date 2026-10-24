import type { Wallet } from 'xrpl'
import type { Ledger } from '../xrpl/client.js'

/**
 * Grant an agent the right to send Payment transactions on the user's account, and nothing else.
 * Never delegate PaymentBurn: XRPL docs warn against it until fixCleanup3_4_0 is active.
 * Delegation limits WHICH transactions an agent can send, not HOW MUCH: amount caps live in the L2 mandate
 * and in the scoring service's credit-line check.
 */
export async function delegatePayment(ledger: Ledger, user: Wallet, agent: string): Promise<string> {
  const res = await ledger.submit(
    {
      TransactionType: 'DelegateSet',
      Account: user.address,
      Authorize: agent,
      Permissions: [{ Permission: { PermissionValue: 'Payment' } }],
    },
    user,
  )
  return res.result.hash
}

/** Revoke instantly. An empty permission list deletes the Delegate object. */
export async function revokeDelegation(ledger: Ledger, user: Wallet, agent: string): Promise<string> {
  const res = await ledger.submit(
    { TransactionType: 'DelegateSet', Account: user.address, Authorize: agent, Permissions: [] },
    user,
  )
  return res.result.hash
}

export async function delegationPermissions(ledger: Ledger, user: string, agent: string): Promise<string[]> {
  const r = await ledger.client.request({ command: 'ledger_entry', delegate: { account: user, authorize: agent } }).catch(() => null)
  const node = r?.result.node as { Permissions?: { Permission: { PermissionValue: string } }[] } | undefined
  return node?.Permissions?.map((p) => p.Permission.PermissionValue) ?? []
}
