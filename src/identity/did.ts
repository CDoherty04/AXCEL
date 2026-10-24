import { createHash } from 'node:crypto'
import type { Wallet } from 'xrpl'
import { hex, networks, unhex } from '../config.js'
import type { AgentRecord, UserRecord } from '../store/state.js'
import type { Ledger } from '../xrpl/client.js'

export const didFor = (account: string): string => `did:xrpl:${networks.devnet.didChain}:${account}`

export interface DidDocument {
  '@context': string[]
  id: string
  controller?: string
  verificationMethod: { id: string; type: string; controller: string; publicKeyJwk?: unknown; blockchainAccountId: string }[]
  service: { id: string; type: string; serviceEndpoint: string; [k: string]: unknown }[]
}

/** Stable JSON so the on-chain hash is reproducible. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

export const hashDocument = (doc: DidDocument): string => createHash('sha256').update(canonical(doc)).digest('hex').toUpperCase()

/** The user's DID document: their key plus every linked agent account and its Mastercard registration. */
export function userDocument(user: UserRecord): DidDocument {
  const did = didFor(user.account)
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [
      {
        id: `${did}#owner`,
        type: 'EcdsaSecp256k1RecoveryMethod2020',
        controller: did,
        blockchainAccountId: `xrpl:devnet:${user.account}`,
      },
      {
        id: `${did}#vi-user-key`,
        type: 'JsonWebKey2020',
        controller: did,
        publicKeyJwk: user.viUserKey.public_jwk,
        blockchainAccountId: `xrpl:devnet:${user.account}`,
      },
    ],
    service: Object.values(user.agents)
      .filter((a) => a.status === 'active')
      .map((a) => ({
        id: `${did}#agent-${a.id}`,
        type: 'AgentAccount',
        serviceEndpoint: a.did,
        account: a.account,
        mastercardAgentId: a.mastercardAgentId,
        mode: a.mode,
      })),
  }
}

/** An agent's DID document: controlled by the user's DID, carrying the agent's VI key and Mastercard registration. */
export function agentDocument(user: UserRecord, agent: AgentRecord): DidDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: agent.did,
    controller: didFor(user.account),
    verificationMethod: [
      {
        id: `${agent.did}#vi-agent-key`,
        type: 'JsonWebKey2020',
        controller: didFor(user.account),
        publicKeyJwk: agent.viKey.public_jwk,
        blockchainAccountId: `xrpl:devnet:${agent.account}`,
      },
    ],
    service: [
      {
        id: `${agent.did}#mastercard`,
        type: 'MastercardAgentRegistration',
        serviceEndpoint: agent.mastercardAgentId,
        status: agent.status,
      },
    ],
  }
}

/**
 * XRPL DID fields are capped at 256 bytes, so the document lives at a URI and the ledger carries
 * its sha256. A resolver fetches the URI and rejects the document if the hash differs.
 */
export async function publishDid(ledger: Ledger, wallet: Wallet, uri: string, doc: DidDocument): Promise<string> {
  const res = await ledger.submit(
    { TransactionType: 'DIDSet', Account: wallet.address, URI: hex(uri), Data: hashDocument(doc) },
    wallet,
  )
  return res.result.hash
}

export interface ResolvedDid {
  document: DidDocument
  uri: string
  hashMatches: boolean
}

export async function resolveDid(
  ledger: Ledger,
  account: string,
  fetchDoc: (uri: string) => Promise<DidDocument>,
): Promise<ResolvedDid | null> {
  const r = await ledger.client.request({ command: 'ledger_entry', did: account }).catch(() => null)
  const node = r?.result.node as { URI?: string; Data?: string } | undefined
  if (!node?.URI) return null
  const uri = unhex(node.URI)
  const document = await fetchDoc(uri)
  return { document, uri, hashMatches: !!node.Data && node.Data.toUpperCase() === hashDocument(document) }
}
