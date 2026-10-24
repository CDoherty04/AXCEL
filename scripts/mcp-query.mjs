// Minimal stdio JSON-RPC client for @mastercard/developers-mcp.
// Usage: node scripts/mcp-query.mjs list | node scripts/mcp-query.mjs call <tool> '<json args>'
import { spawn } from 'node:child_process'

const [, , cmd, tool, argsJson] = process.argv
const p = spawn('npx', ['-y', '@mastercard/developers-mcp'], { shell: true, stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const waiting = new Map()
p.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      const m = JSON.parse(line)
      waiting.get(m.id)?.(m)
    } catch {}
  }
})
let n = 0
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++n
    waiting.set(id, resolve)
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bec', version: '0.1' } })
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const out = cmd === 'list' ? await rpc('tools/list', {}) : await rpc('tools/call', { name: tool, arguments: JSON.parse(argsJson ?? '{}') })
console.log(JSON.stringify(out.result ?? out.error, null, 1))
p.kill()
process.exit(0)
