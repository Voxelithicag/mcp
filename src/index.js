#!/usr/bin/env node
/**
 * voxelithic-mcp — доступ агента к маршрутизации на Robinhood Chain.
 *
 * Сервер тонкий: вся работа происходит в публичном API, здесь только описания
 * инструментов и разбор ответов. Своей логики котирования тут нет намеренно —
 * иначе агент и сайт считали бы цену по-разному, и расхождение всплыло бы у
 * пользователя, а не у нас.
 *
 * Ключей сервер не принимает и принимать не будет. build_swap возвращает
 * неподписанные байты; подписывает и вещает тот, кто вызвал.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const API = (process.env.VOX_API_URL || "https://voxelithic.xyz/api/v1").replace(/\/+$/, "");
const UA = "voxelithic-mcp";

/** Ответ API отдаём агенту как есть: он структурирован и самодостаточен. */
async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      accept: "application/json",
      "user-agent": UA,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    // 429 стоит отличать: агент должен подождать, а не менять запрос.
    const hint = res.status === 429 ? " Retry after the window resets." : "";
    throw new Error(`${data.error || "request failed"} (HTTP ${res.status}).${hint}`);
  }
  return data;
}

const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const fail = (e) => ({
  content: [{ type: "text", text: String(e?.message || e) }],
  isError: true,
});

const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

const server = new McpServer({ name: "voxelithic", version: "0.3.0" });

/* ─────────────────────────────── справка ─────────────────────────────── */

server.registerTool(
  "health",
  {
    description:
      "Chain head, market phase and the deployed contract addresses. Use it to " +
      "confirm the chain is reachable, and to see whether the equity market is " +
      "open: outside the session the oracles are frozen while the pools keep trading.",
    inputSchema: z.object({}),
  },
  wrap(() => call("/health"))
);

server.registerTool(
  "list_tokens",
  {
    description:
      "The canonical token set. Resolve a ticker through this and nothing else: " +
      "on this chain 39 contracts answer to a stock symbol that is not theirs, so " +
      "searching an indexer for 'NVDA' will eventually hand you the wrong address.",
    inputSchema: z.object({
      symbol: z.string().optional().describe("Return one token instead of the whole set"),
    }),
  },
  wrap(({ symbol }) => call("/tokens" + (symbol ? `?symbol=${encodeURIComponent(symbol)}` : "")))
);

server.registerTool(
  "list_venues",
  {
    description: "The venues the router can execute against, with the AMM family of each.",
    inputSchema: z.object({}),
  },
  wrap(() => call("/venues"))
);

/* ────────────────────────────── торговля ─────────────────────────────── */

server.registerTool(
  "get_quote",
  {
    description:
      "Best executable quote for a pair. Every candidate pool is asked through the " +
      "on-chain quoter rather than modelled, and a pool that cannot take the whole " +
      "size is excluded instead of estimated. Returns amountOut, minOut and the " +
      "route, which build_swap takes unchanged.\n\n" +
      "When the size presses on the price, the answer also carries a split: the same " +
      "order divided across pools of both families, with the legs and how much better " +
      "it is in basis points. To take it, pass that split's legsV3 and legsV4 to " +
      "build_swap instead of route.",
    inputSchema: z.object({
      tokenIn: z.string().describe("Symbol from list_tokens, or a 20 byte address"),
      tokenOut: z.string().describe("Symbol from list_tokens, or a 20 byte address"),
      amountIn: z.string().describe("Human units, for example '10' or '10.5'"),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe("Basis points below the quote to accept. Defaults to 100, meaning one percent"),
    }),
  },
  wrap(({ tokenIn, tokenOut, amountIn, slippageBps }) => {
    const q = new URLSearchParams({ tokenIn, tokenOut, amountIn });
    if (slippageBps != null) q.set("slippageBps", String(slippageBps));
    return call("/quote?" + q.toString());
  })
);

server.registerTool(
  "build_swap",
  {
    description:
      "Build the unsigned transaction for a route from get_quote. Returns calldata " +
      "and the approval it needs. This server holds no keys and cannot sign or " +
      "broadcast: hand the transaction to a wallet. minOut is required and is never " +
      "chosen for you, because that number is the protection against a bad fill.\n\n" +
      "Pass either route, for a single path, or legsV3 together with legsV4 to execute " +
      "a split. A split runs on its own contract and its minOut is checked once against " +
      "the total rather than per leg, so size it against the least liquid pool in the " +
      "route rather than the average.",
    inputSchema: z.object({
      tokenIn: z.string(),
      tokenOut: z.string(),
      amountIn: z.string().optional().describe("Same value passed to get_quote. Not needed for a split: the amount is the sum of the legs"),
      minOut: z.string().describe("Take minOut from the quote, or compute a stricter one"),
      route: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .describe("The route array from get_quote, unchanged. Omit when sending a split"),
      legsV3: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .describe("Split execution: the legsV3 array from the quote's split, unchanged"),
      legsV4: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .describe("Split execution: the legsV4 array from the quote's split, unchanged"),
      deadlineSeconds: z.number().int().min(15).max(3600).optional(),
    }),
  },
  wrap((body) => call("/swap", { method: "POST", body }))
);

server.registerTool(
  "verify_fill",
  {
    description:
      "What a transaction actually did, read from its receipt on chain rather than " +
      "from our records. Reports the amounts that moved, or that the router reverted " +
      "and the input stayed with the sender.",
    inputSchema: z.object({
      tx: z.string().describe("Transaction hash, 32 bytes"),
    }),
  },
  wrap(({ tx }) => call("/verify?tx=" + encodeURIComponent(tx)))
);

server.registerTool(
  "fill_receipt",
  {
    description:
      "What a settled swap paid, against what every other venue on the chain would have " +
      "paid for the same pair and size. The board is re-quoted at the block BEFORE the " +
      "fill, so the order's own footprint is not in the comparison, and it is returned " +
      "whole, losers included. When the route taken was not the best available, the " +
      "verdict says so. Nothing is stored: every number is recomputed from chain state, " +
      "so an archive node reproduces it independently.",
    inputSchema: z.object({
      tx: z.string().describe("Transaction hash of a fill that went through a Voxelithic router, 32 bytes"),
    }),
  },
  wrap(({ tx }) => call("/receipt?tx=" + encodeURIComponent(tx)))
);

/* ─────────────────────────────── запуск ──────────────────────────────── */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Логи только в stderr: stdout занят потоком JSON-RPC.
  console.error(`voxelithic-mcp running on stdio, api ${API}`);
}

main().catch((e) => {
  console.error("failed to start:", e?.message || e);
  process.exit(1);
});
