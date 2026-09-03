#!/usr/bin/env node
/**
 * Поднимает сервер и разговаривает с ним по JSON-RPC поверх stdio — ровно так,
 * как это делает клиент. Проверяется не то, что модуль импортируется, а что
 * рукопожатие проходит, инструменты перечисляются и вызовы возвращают данные.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "../src/index.js");

const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write("  [server] " + d));

let buf = "";
const waiters = new Map();

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let id = 0;
const send = (method, params) =>
  new Promise((res, rej) => {
    const n = ++id;
    waiters.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    setTimeout(() => rej(new Error(`timeout on ${method}`)), 30000);
  });

const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failures++;
};

try {
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check("рукопожатие", !!init?.serverInfo, init?.serverInfo?.name + " " + init?.serverInfo?.version);
  notify("notifications/initialized", {});

  const { tools } = await send("tools/list", {});
  const names = tools.map((t) => t.name).sort();
  check("инструменты перечислены", tools.length === 6, names.join(", "));
  check("у каждого есть описание", tools.every((t) => (t.description || "").length > 40));
  check("у каждого есть схема входа", tools.every((t) => t.inputSchema));

  const parse = (r) => JSON.parse(r.content[0].text);

  const h = await send("tools/call", { name: "health", arguments: {} });
  const hd = parse(h);
  check("health отвечает", hd.ok === true && hd.chainId === 4663, "блок " + hd.blockNumber);

  const t = await send("tools/call", { name: "list_tokens", arguments: { symbol: "NVDA" } });
  const td = parse(t);
  check("list_tokens резолвит тикер", td.tokens?.[0]?.symbol === "NVDA", td.tokens?.[0]?.address);

  const q = await send("tools/call", {
    name: "get_quote",
    arguments: { tokenIn: "USDG", tokenOut: "SPY", amountIn: "10" },
  });
  const qd = parse(q);
  check("get_quote считает", !!qd.quote?.amountOut,
        `${qd.quote?.amountOut} SPY, пулов ${qd.poolsThatCouldFill}/${qd.poolsConsidered}`);

  if (qd.quote) {
    const s = await send("tools/call", {
      name: "build_swap",
      arguments: {
        tokenIn: "USDG", tokenOut: "SPY", amountIn: "10",
        minOut: qd.quote.minOut, route: qd.quote.route,
      },
    });
    const sd = parse(s);
    check("build_swap собирает calldata",
          typeof sd.transaction?.data === "string" && sd.transaction.data.startsWith("0x05b094ac"),
          sd.transaction?.data?.length + " симв");
    check("ключи не запрашиваются", /no keys|unsigned/i.test(sd.signing || ""));
  }

  const v = await send("tools/call", {
    name: "verify_fill",
    arguments: { tx: "0x46fb26583f88e16ea546457d24880637f490c54a61a9438068dec3b947970fe4" },
  });
  const vd = parse(v);
  check("verify_fill читает филл", vd.filled === true, `${vd.fill?.amountIn} -> ${vd.fill?.amountOut}`);

  const bad = await send("tools/call", {
    name: "get_quote",
    arguments: { tokenIn: "USDG", tokenOut: "НЕТТАКОГО", amountIn: "1" },
  });
  check("ошибка помечена как ошибка", bad.isError === true, bad.content?.[0]?.text?.slice(0, 60));
} catch (e) {
  console.error("  СБОЙ:", e.message);
  failures++;
} finally {
  child.kill();
}

console.log(failures ? `\nпровалено проверок: ${failures}` : "\nвсе проверки пройдены");
process.exit(failures ? 1 : 0);
