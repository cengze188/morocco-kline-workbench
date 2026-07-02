import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiBase = "https://api.casablanca-bourse.com";
const port = Number(process.env.PORT || 8787);
const cache = { time: 0, rows: [] };
const sectorOverrides = { TGC: "Bâtiment et Matériaux de Construction" };

function toNumber(value) {
  if (value === null || value === undefined || value === "-") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanCode(code) {
  return String(code || "").split("-")[0].toUpperCase();
}

async function fetchJson(url, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getMarketRows() {
  if (Date.now() - cache.time < 600000 && cache.rows.length) return cache.rows;
  const rows = [];
  try {
    for (let offset = 0; offset < 300; offset += 50) {
      const url = `${apiBase}/api/bourse_data/last_market_watches/action?page%5Boffset%5D=${offset}`;
      const data = await fetchJson(url);
      const items = data?.data?.data || [];
      if (!items.length) break;
      for (const item of items) {
        const a = item.attributes || {};
        const symbol = cleanCode(a.code);
        if (!symbol) continue;
        rows.push({
          symbol,
          rawCode: a.code,
          marketWatchId: item.id,
          name: null,
          sector: null,
          isin: null,
          shares: null,
          introDate: null,
          introPrice: null,
          price: toNumber(a.coursCourant),
          lastPrice: toNumber(a.lastTradedPrice),
          open: toNumber(a.openingPrice),
          high: toNumber(a.highPrice),
          low: toNumber(a.lowPrice),
          referencePrice: toNumber(a.staticReferencePrice),
          change: toNumber(a.difference),
          changePct: toNumber(a.varVeille),
          ytdPct: toNumber(a.instrumentVarYear),
          marketCap: toNumber(a.capitalisation),
          volumeMAD: toNumber(a.cumulVolumeEchange),
          tradedShares: toNumber(a.cumulTitresEchanges),
          trades: a.totalTrades,
          bestBid: toNumber(a.bestBidPrice),
          bestAsk: toNumber(a.bestAskPrice),
          state: a.etatCotVal,
          timestamp: a.transactTime,
          symbolUrl: item.relationships?.symbol?.links?.related?.href,
          source: "Bourse de Casablanca"
        });
      }
      if (items.length < 50) break;
    }
    cache.rows = rows;
    cache.time = Date.now();
    return rows;
  } catch (err) {
    if (cache.rows.length) return cache.rows;
    throw err;
  }
}

async function getStockDetail(symbol) {
  const rows = await getMarketRows();
  const row = rows.find(item => item.symbol === String(symbol || "").toUpperCase());
  if (!row) return null;
  try {
    if (row.symbolUrl) {
      const sym = await fetchJson(row.symbolUrl, 30000);
      const attr = sym?.data?.attributes || {};
      row.name = attr.libelleFR;
      row.isin = attr.codeISIN;
      row.shares = toNumber(attr.nombreTitres);
      row.introDate = attr.dateIntroduction;
      row.introPrice = toNumber(attr.coursIntroduction);
      const sectorUrl = sym?.data?.relationships?.codeSousSecteur?.links?.related?.href;
      if (sectorUrl) {
        const sector = await fetchJson(sectorUrl, 30000);
        row.sector = sector?.data?.attributes?.name || row.sector;
      }
    }
  } catch (err) {
    row.detailWarning = err.message;
  }
  if (sectorOverrides[row.symbol]) {
    row.sector = sectorOverrides[row.symbol];
    row.sectorOverride = true;
  }
  const ranked = rows
    .filter(item => Number(item.marketCap) > 0)
    .sort((a, b) => b.marketCap - a.marketCap);
  const rank = ranked.findIndex(item => item.symbol === row.symbol) + 1;
  if (rank > 0) {
    row.marketCapRank = rank;
    row.marketCapRankTotal = ranked.length;
    row.marketCapTier = rank <= 5 ? "top5" : rank <= 10 ? "top10" : rank <= 20 ? "top20" : "listed";
  }
  return row;
}

function sendJson(res, body, status = 200) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(json);
}

async function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
  const data = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS") return sendJson(res, { ok: true });
    if (url.pathname === "/health") {
      return sendJson(res, { ok: true, time: new Date().toISOString(), cachedRows: cache.rows.length });
    }
    if (url.pathname === "/api/stocks") {
      const rows = (await getMarketRows()).slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
      return sendJson(res, {
        ok: true,
        count: rows.length,
        updatedAt: new Date().toISOString(),
        source: `${apiBase}/api/bourse_data/last_market_watches/action`,
        data: rows
      });
    }
    const stockMatch = url.pathname.match(/^\/api\/stock\/([^/]+)$/);
    if (stockMatch) {
      const symbol = decodeURIComponent(stockMatch[1]).toUpperCase();
      const detail = await getStockDetail(symbol);
      if (!detail) return sendJson(res, { ok: false, error: `Symbol not found: ${symbol}` }, 404);
      return sendJson(res, {
        ok: true,
        data: detail,
        source: "Bourse de Casablanca official API",
        updatedAt: new Date().toISOString()
      });
    }
    const requested = url.pathname === "/" ? "/kline-tech-analyzer-v3.html" : url.pathname;
    const filePath = path.join(__dirname, requested.replace(/^\/+/, ""));
    if (!filePath.startsWith(__dirname) || !existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    return await sendFile(res, filePath);
  } catch (err) {
    return sendJson(res, { ok: false, error: err.message }, 500);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Morocco K-line workbench running on port ${port}`);
});
