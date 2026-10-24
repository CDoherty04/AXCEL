import { randomUUID } from 'node:crypto'
import type { CreditService } from '../service.js'
import { HttpError } from '../store/state.js'

/** An OpenAI-driven shopping agent. It can only read its mandate and call buy(); the protocol enforces the rest. */

export interface RunStep {
  ts: number
  kind: 'thought' | 'tool' | 'result' | 'error' | 'final'
  text: string
}

export interface AgentRun {
  id: string
  agentId: string
  task: string
  state: 'running' | 'done' | 'failed'
  startedAt: number
  steps: RunStep[]
}

const MAX_TURNS = 8
const model = () => process.env.AGENT_MODEL || 'gpt-4.1'

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_mandate',
      description:
        "Returns what you are allowed to do: merchants you may pay (id and name), items you may buy, the per-purchase cap, your remaining budget and the owner's available credit, all in USD.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy',
      description:
        'Buy one item from a merchant. The purchase is checked against your mandate, authorized by the network and settled on XRPL. Refusals come back as errors; do not retry a refused purchase unchanged.',
      parameters: {
        type: 'object',
        properties: {
          merchant_id: { type: 'string' },
          item: { type: 'string', description: 'One of the items in your mandate' },
          amount_usd: { type: 'number', description: 'Price in USD' },
        },
        required: ['merchant_id', 'item', 'amount_usd'],
      },
    },
  },
]

export class AgentRunner {
  private readonly runs = new Map<string, AgentRun>()
  constructor(private readonly svc: CreditService) {}

  list(agentId: string): AgentRun[] {
    return [...this.runs.values()].filter((r) => r.agentId === agentId).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id)
  }

  start(agentId: string, task: string): AgentRun {
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new HttpError(503, 'OPENAI_API_KEY is not set; add it to .env.local and restart the API')
    if (this.svc.agentBrief(agentId).status !== 'active') throw new HttpError(409, 'agent is revoked')
    if ([...this.runs.values()].some((r) => r.agentId === agentId && r.state === 'running')) {
      throw new HttpError(409, 'this agent is already running a task')
    }
    const run: AgentRun = {
      id: `run_${randomUUID().slice(0, 8)}`, agentId, task, state: 'running', startedAt: Math.floor(Date.now() / 1000), steps: [],
    }
    this.runs.set(run.id, run)
    this.loop(run, key).then(
      () => { run.state = 'done' },
      (e) => { this.push(run, 'error', e instanceof Error ? e.message : String(e)); run.state = 'failed' },
    )
    return run
  }

  private push(run: AgentRun, kind: RunStep['kind'], text: string) {
    run.steps.push({ ts: Math.floor(Date.now() / 1000), kind, text })
  }

  private async loop(run: AgentRun, key: string) {
    const brief = this.svc.agentBrief(run.agentId)
    const system =
      `You are "${brief.label}", a purchasing agent acting for a person who lends you part of their credit line. ` +
      'Complete the task by buying only what is needed, only from your allowed merchants, within your mandate. ' +
      'Call get_mandate first. Prices are not published, so choose a reasonable price for each item that stays under your per-purchase cap and remaining budget. ' +
      'If your mandate lists "anything" as allowed items, buy whatever the task needs and name the real item in the item field. If the task cannot be done inside the mandate, say so instead of trying to get around it. Finish with a one or two sentence summary.'
    const messages: any[] = [
      { role: 'system', content: system },
      { role: 'user', content: run.task },
    ]

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: model(), messages, tools }),
      })
      const data = (await res.json()) as { choices?: { message: any }[]; error?: { message: string } }
      const msg = data.choices?.[0]?.message
      if (!res.ok || !msg) throw new Error(data.error?.message ?? `OpenAI API HTTP ${res.status}`)
      messages.push(msg)

      const calls: any[] = msg.tool_calls ?? []
      if (typeof msg.content === 'string' && msg.content.trim()) this.push(run, calls.length ? 'thought' : 'final', msg.content.trim())
      if (!calls.length) return

      for (const c of calls) {
        let input: any = {}
        try { input = JSON.parse(c.function.arguments || '{}') } catch { /* bad JSON becomes an empty call the tool rejects */ }
        const out = await this.call(run, { name: c.function.name, input })
        messages.push({ role: 'tool', tool_call_id: c.id, content: out.is_error ? `Error: ${out.content}` : out.content })
      }
    }
    this.push(run, 'final', `Stopped after ${MAX_TURNS} steps.`)
  }

  private async call(run: AgentRun, use: { name: string; input: any }): Promise<{ content: string; is_error?: boolean }> {
    if (use.name === 'get_mandate') {
      this.push(run, 'tool', 'get_mandate()')
      return { content: JSON.stringify(await this.svc.agentBriefWithCredit(run.agentId)) }
    }
    if (use.name === 'buy') {
      const { merchant_id: merchantId, item, amount_usd: usd } = use.input ?? {}
      this.push(run, 'tool', `buy(${merchantId}, ${item}, $${usd})`)
      try {
        const amountCents = Math.round(Number(usd) * 100)
        if (!(amountCents > 0)) throw new Error('amount_usd must be positive')
        const r = await this.svc.purchase(run.agentId, { merchantId, item: this.svc.resolveItem(run.agentId, String(item)), amountCents })
        const tx = (r as { txHash?: string }).txHash
        this.push(run, 'result', `Settled on XRPL${tx ? ` (${tx.slice(0, 8)}…${tx.slice(-6)})` : ''}`)
        return { content: JSON.stringify({ ok: true, txHash: tx }) }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const pending = e instanceof HttpError && e.status === 202
        this.push(run, pending ? 'result' : 'error', pending ? `Accepted, still settling: ${msg}` : `Refused: ${msg}`)
        return pending ? { content: JSON.stringify({ ok: true, pending: true }) } : { content: msg, is_error: true }
      }
    }
    return { content: `unknown tool ${use.name}`, is_error: true }
  }
}
