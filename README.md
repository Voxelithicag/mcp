# voxelithic-mcp

An MCP server that lets an agent quote, route and settle tokenized equities on
Robinhood Chain (4663), and verify afterwards what actually happened.

## Install

```json
{
  "mcpServers": {
    "voxelithic": {
      "command": "npx",
      "args": ["-y", "voxelithic-mcp"]
    }
  }
}
```

No key, no account, no configuration. Point it somewhere else with `VOX_API_URL`
if you are running the API yourself.

## Tools

| | |
|---|---|
| `health` | Chain head, market phase, contract addresses |
| `list_tokens` | The canonical token set |
| `list_venues` | Venues the router can execute against |
| `get_quote` | Best executable quote for a pair |
| `build_swap` | Unsigned transaction for a route |
| `verify_fill` | What a transaction actually did |

## It cannot spend your money

`build_swap` returns calldata and the approval it needs. This server holds no
keys, and it cannot sign or broadcast anything. Whatever it hands back has to go
through a wallet you control before it touches the chain.

`minOut` is required and never chosen for you. That number is what makes the
router revert instead of settling short, so picking it on your behalf would mean
deciding how much loss you find acceptable.

## Why an agent needs `list_tokens`

A ticker is not an identifier on this chain. Thirty nine contracts answer to a
stock symbol that is not theirs, and the deepest of them holds more than half a
million dollars of liquidity while trading pennies a day. An agent that resolves
"NVDA" by searching an indexer will eventually send funds to the wrong contract.

These addresses come from the router's own configuration and are re-checked
against the chain on every release.

## Where the prices come from

Not from a pricing engine. Every candidate pool is asked through the on-chain
quoter, and a pool that cannot take the whole size returns less than it was
given and drops out. So a quote is reproducible: an RPC and the quoter address
are enough to get the same number without this server, the API, or us.

## A typical exchange

```
list_tokens  → the canonical address for SPY
get_quote    → 10 USDG buys 0.01306 SPY, six of seven pools could fill
build_swap   → calldata plus the approval it needs
(the wallet signs and broadcasts)
verify_fill  → what settled, read from the receipt
```

## Development

```bash
npm install
npm test      # spawns the server and speaks JSON-RPC to it over stdio
```

The test does the real handshake, lists the tools and calls each one against the
live API, so a broken tool fails the run rather than the user.

## Related

- API and spec: [voxelithic.xyz/api/v1](https://voxelithic.xyz/api/v1)
- TypeScript types and ABIs: [voxelithic-interfaces](https://www.npmjs.com/package/voxelithic-interfaces)
- Contracts and everything else: [github.com/Voxelithicag](https://github.com/Voxelithicag)

## License

MIT
