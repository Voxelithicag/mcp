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
| `fill_receipt` | What a fill paid, against what every venue would have paid at that block |
| `get_burn` | How much $VOXEL the treasury has bought back and burned, and what is queued |

## It cannot spend your money

`build_swap` returns calldata and the approval it needs. This server holds no
keys, and it cannot sign or broadcast anything. Whatever it hands back has to go
through a wallet you control before it touches the chain.

`minOut` is required and never chosen for you. That number is what makes the
router revert instead of settling short, so picking it on your behalf would mean
deciding how much loss you find acceptable.

## Signing it yourself

"It cannot sign" is not the same as "a human has to click". The key simply stays
on your side. An agent that holds one signs and broadcasts without us, and the
loop is autonomous end to end:

```js
import { createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rh = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});

const account = privateKeyToAccount(process.env.AGENT_KEY);
const wallet = createWalletClient({ account, chain: rh, transport: http() });

// build_swap gave you { transaction, approval }
await wallet.sendTransaction({                 // the approval, once per spender
  to: approval.token,
  data: encodeApprove(approval.spender, approval.amount),
});
const hash = await wallet.sendTransaction(transaction);
```

Then hand the hash back to `verify_fill` to read what actually settled.

Two things worth keeping in the agent's head. The approval only needs sending
when the current allowance is short — check it before spending a transaction on
it. And `minOut` travels inside the calldata you sign, so the protection is
enforced on chain rather than by us behaving: size it per trade and the router
reverts instead of settling short.

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
fill_receipt → and what every other venue would have paid for that size
```

## Development

```bash
npm install
npm test      # spawns the server and speaks JSON-RPC to it over stdio
```

The test does the real handshake, lists the tools by name and calls every one of
them against the live API. It also pins the two things that are easy to break
quietly: that a large round amount is not misread as base units, and that a
`minOut` of zero is refused rather than accepted.

## Related

- API and spec: [voxelithic.xyz/api/v1](https://voxelithic.xyz/api/v1)
- TypeScript types and ABIs: [voxelithic-interfaces](https://www.npmjs.com/package/voxelithic-interfaces)
- Contracts and everything else: [github.com/Voxelithicag](https://github.com/Voxelithicag)

## License

MIT
