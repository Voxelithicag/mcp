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
  /* Список закреплён поимённо, а не числом: выпавший инструмент и добавленный
     в одном изменении дали бы прежнее количество и тест бы промолчал. */
  const EXPECTED = [
    "build_swap", "fill_receipt", "get_burn", "get_quote", "health",
    "list_tokens", "list_venues", "verify_fill",
  ];
  check("инструменты перечислены", names.join(",") === EXPECTED.join(","), names.join(", "));
  check("у каждого есть описание", tools.every((t) => (t.description || "").length > 40));
  check("у каждого есть схема входа", tools.every((t) => t.inputSchema));

  /* Ошибочный результат — это тоже результат: пусть станет провалом проверки,
     а не исключением, обрывающим весь прогон на середине. */
  const parse = (r) => {
    const text = r?.content?.[0]?.text ?? "";
    if (r?.isError) return { __error: text };
    try { return JSON.parse(text); } catch { return { __error: text }; }
  };

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

  const ven = await send("tools/call", { name: "list_venues", arguments: {} });
  const vend = parse(ven);
  check("list_venues перечисляет площадки", Array.isArray(vend.venues) && vend.venues.length > 0,
        `${vend.venues?.length} площадок`);

  const rc = await send("tools/call", {
    name: "fill_receipt",
    arguments: { tx: "0x401dac9fe621d30cbf8634f771e4cc6e42ee1c3f353e2f70e769ecf9562b4650" },
  });
  /* Чек пересчитывается от состояния цепи, а узел хранит его не вечно: на
     старом филле честный ответ — ошибка, а не выдуманные числа. */
  check("fill_receipt отвечает или честно признаёт, что состояние ушло",
        rc.isError === true || typeof parse(rc).verdict === "string" || !!parse(rc).fill,
        rc.isError ? "состояние за пределами хранения узла" : "чек посчитан");

  const bn = await send("tools/call", { name: "get_burn", arguments: {} });
  const bnd = parse(bn);
  check("get_burn читает счётчик казны",
        typeof bnd.totalBurned?.voxel === "number" && bnd.feeBps === 30,
        `${Math.round(bnd.totalBurned?.voxel ?? 0)} VOXEL сожжено`);

  /* Регрессия на баг, из-за которого /quote и /swap читали одну и ту же строку
     по-разному: у USDG шесть знаков, и "1000000" молча превращался в 1 доллар
     вместо миллиона. Проверяем обе формы — человеческую и сырую. */
  const bigQ = parse(await send("tools/call", {
    name: "get_quote",
    arguments: { tokenIn: "USDG", tokenOut: "SPY", amountIn: "1000000" },
  }));
  if (bigQ.quote) {
    const human = parse(await send("tools/call", {
      name: "build_swap",
      arguments: { tokenIn: "USDG", tokenOut: "SPY", amountIn: "1000000",
                   minOut: bigQ.quote.minOut, route: bigQ.quote.route },
    }));
    check("миллион USDG не превращается в один доллар",
          String(human.amountIn) === bigQ.amountInRaw,
          `${human.amountIn} против ожидаемых ${bigQ.amountInRaw}`);

    const raw = parse(await send("tools/call", {
      name: "build_swap",
      arguments: { tokenIn: "USDG", tokenOut: "SPY", amountInRaw: bigQ.amountInRaw,
                   minOutRaw: bigQ.quote.minOutRaw, route: bigQ.quote.route },
    }));
    check("сырые поля дают то же число", String(raw.amountIn) === bigQ.amountInRaw);
  }

  /* Нулевой minOut — это согласие на любую цену. Сервер обязан отказать. */
  const zero = await send("tools/call", {
    name: "build_swap",
    arguments: { tokenIn: "USDG", tokenOut: "SPY", amountIn: "10", minOut: "0",
                 route: bigQ.quote?.route ?? [] },
  });
  check("minOut = 0 отвергается", zero.isError === true, zero.content?.[0]?.text?.slice(0, 70));

  /* Сплит — главная фича на крупных ордерах, и до сих пор она не проверялась
     ни одним тестом. Ищем размер, на котором квотер её предлагает. */
  let splitSeen = false;
  for (const amt of ["500000", "2000000"]) {
    const sq = parse(await send("tools/call", {
      name: "get_quote", arguments: { tokenIn: "USDG", tokenOut: "SPY", amountIn: amt },
    }));
    if (!sq.split) continue;
    splitSeen = true;
    const sb = parse(await send("tools/call", {
      name: "build_swap",
      arguments: { tokenIn: "USDG", tokenOut: "SPY",
                   minOutRaw: sq.split.minOutRaw, legsV3: sq.split.legsV3, legsV4: sq.split.legsV4 },
    }));
    check("сплит собирается в транзакцию",
          typeof sb.transaction?.data === "string" && sb.transaction.data.startsWith("0x"),
          sb.__error ? sb.__error.slice(0, 70)
                     : `на $${amt}, ног ${(sq.split.legsV3?.length ?? 0) + (sq.split.legsV4?.length ?? 0)}`);
    break;
  }
  if (!splitSeen) console.log("  --   сплит сейчас не выгоден ни на одном размере, проверка пропущена");

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
