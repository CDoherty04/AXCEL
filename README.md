# AXCEL
Agentic XRPL Credit Exchange Layer

## QuickNode Mainnet Backlog

XRPL `account_tx` backlog for an account (default: `rUjfTQpvBr6wsGGxMw6sRmRQGG76nvp8Ln`).

Put your QuickNode HTTP URL in `.env.local` (see `.env.example`), then:

```bash
npm run axcel -- history rAddress…
npm run axcel -- history rAddress… --json --limit 1000
npm run axcel -- score rAddress…
```
