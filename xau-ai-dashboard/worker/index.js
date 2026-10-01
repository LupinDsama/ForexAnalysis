const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const D1_FREE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // ~5 GB
const MAX_MEMORIES = 500;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function byteLen(s) {
  return new TextEncoder().encode(s || "").length;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/xauusd") {
      return getXAUUSD(env, url.searchParams.get("interval"));
    }

    if (url.pathname === "/api/chat") {
      return chatWithAI(request, env);
    }

    if (url.pathname === "/api/memory" && request.method === "POST") {
      return saveMemory(request, env);
    }

    if (url.pathname === "/api/storage") {
      return storageInfoResponse(env);
    }

    // Live gold price proxy (Yahoo COMEX futures, no key needed).
    // Cached 30s server-side; browsers can't call Yahoo directly (no CORS).
    if (url.pathname === "/api/live") {
      return livePrice(env);
    }

    if (url.pathname === "/api/storage/clean" && request.method === "POST") {
      return storageClean(request, env);
    }

    if (url.pathname === "/api/news") {      if (!env.DB) return json({ error: "Missing DB binding" }, 500);
      await ensureSchema(env.DB);
      if (url.searchParams.get("refresh") === "1") {
        try {
          return json(await refreshMacroNews(env.DB));
        } catch (e) {
          return json({ error: e.message }, 502);
        }
      }
      return json(await getMacroNews(env.DB));
    }

    // Debug helper (pure math, no secrets/DB): validate setup geometry.
    if (url.pathname === "/api/debug-validate" && request.method === "POST") {
      try {
        const b = await request.json();
        const s = extractSetup(
          `Xu hướng: ${b.trend}\nEntry: ${b.entry}\nTP: ${b.tp}\nSL: ${b.sl}`
        );
        if (!s) return json({ valid: false, reason: "unparseable" });
        const lastPx = Number(b.market);
        const status =
          !s.valid
            ? "INVALID"
            : lastPx == null || !Number.isFinite(lastPx) ||
                Math.abs(s.entry - lastPx) > PENDING_GAP ||
                (s.rr != null && s.rr < 1)
              ? "PENDING"
              : "OPEN";
        return json({ valid: s.valid, trend: s.trend, rr: s.rr, status });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (url.pathname === "/api/whereami") {
      const trace = await (
        await fetch("https://www.cloudflare.com/cdn-cgi/trace")
      ).text();
      return new Response(trace, { headers: corsHeaders });
    }

    return json({ ok: true, service: "XAUUSD AI Backend" });
  },
};

// Legacy stub: Durable Object instances created by an earlier version
// still reference this class name, so it must stay exported.
export class GeminiProxy {
  async fetch() {
    return new Response("gone", { status: 410 });
  }
}

// ---------- D1 helpers ----------

async function ensureSchema(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taken_at TEXT NOT NULL DEFAULT (datetime('now')),
        data TEXT NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS news_cache (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS setups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_ts INTEGER NOT NULL,
        trend TEXT NOT NULL,
        style TEXT NOT NULL,
        entry REAL NOT NULL,
        tp REAL NOT NULL,
        sl REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        judged_at TEXT,
        activated_ts INTEGER,
        note TEXT
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS scores (
        pattern TEXT PRIMARY KEY,
        score INTEGER NOT NULL DEFAULT 0,
        won INTEGER NOT NULL DEFAULT 0,
        lost INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    ),
    db.prepare(
      `INSERT OR IGNORE INTO meta(key, value) VALUES('usage_bytes', '0')`
    ),
  ]);
  // Older DBs lack activated_ts (added later): best-effort migrate,
  // outside the batch so a duplicate-column error can't roll it back.
  try {
    await db.prepare(`ALTER TABLE setups ADD COLUMN activated_ts INTEGER`).run();
  } catch {
    // column already exists
  }
}

async function addUsage(db, n) {
  await db
    .prepare(`UPDATE meta SET value = CAST(value AS INTEGER) + ? WHERE key = 'usage_bytes'`)
    .bind(n)
    .run();
}

async function storageInfo(db) {
  const usage = await db
    .prepare(`SELECT value FROM meta WHERE key = 'usage_bytes'`)
    .first();
  const mem = await db
    .prepare(`SELECT COUNT(*) AS c FROM memories`)
    .first();
  const snap = await db
    .prepare(`SELECT COUNT(*) AS c FROM snapshots`)
    .first();
  const recent = await db
    .prepare(
      `SELECT id, kind, substr(content, 1, 200) AS snippet, created_at
       FROM memories ORDER BY id DESC LIMIT 10`
    )
    .all();
  const st = await db
    .prepare(`SELECT status, COUNT(*) AS c FROM setups GROUP BY status`)
    .all();
  const setups = { OPEN: 0, WON: 0, LOST: 0 };
  for (const r of st.results || []) setups[r.status] = r.c;
  const sc = await db
    .prepare(`SELECT pattern, score, won, lost FROM scores ORDER BY score DESC`)
    .all();
  const used = Number(usage?.value || 0);
  const openSetups = await db
    .prepare(
      `SELECT id, trend, style, entry, tp, sl, created_at, created_ts FROM setups
       WHERE status = 'OPEN' ORDER BY id DESC LIMIT 20`
    )
    .all();
  const pendingSetups = await db
    .prepare(
      `SELECT id, trend, style, entry, tp, sl, created_at, created_ts FROM setups
       WHERE status = 'PENDING' ORDER BY id DESC LIMIT 20`
    )
    .all();
  const judgedSetups = await db
    .prepare(
      `SELECT id, trend, style, entry, tp, sl, status, created_ts FROM setups
       WHERE status != 'OPEN' ORDER BY id DESC LIMIT 20`
    )
    .all();
  return {
    used_bytes: used,
    limit_bytes: D1_FREE_LIMIT_BYTES,
    tables: {
      memories: mem?.c || 0,
      snapshots: snap?.c || 0,
      setups,
    },
    scores: sc.results || [],
    open_setups: openSetups.results || [],
    pending_setups: pendingSetups.results || [],
    judged_setups: judgedSetups.results || [],
    recent: recent.results || [],
  };
}

async function storageInfoResponse(env) {
  if (!env.DB) return json({ error: "Missing DB binding" }, 500);
  await ensureSchema(env.DB);
  return json(await storageInfo(env.DB));
}

const LIVE_TTL_MS = 30_000;
// Spot sources, closest first. Swissquote BBO tracks Twelve spot within
// cents; gold-api is a fresh fallback; Yahoo futures lags and drifts dollars.
const LIVE_SOURCES = [
  { name: "Swissquote XAU/USD", url: "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD" },
  { name: "gold-api", url: "https://api.gold-api.com/price/XAU" },
  { name: "Yahoo GC=F", url: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d" },
];

function parseLiveBody(source, j, nowMs) {
  if (source.startsWith("Swissquote")) {
    const q = j?.[0];
    const p = q?.spreadProfilePrices?.[0];
    const bid = Number(p?.bid);
    const ask = Number(p?.ask);
    if (Number.isFinite(bid) && Number.isFinite(ask)) {
      return { price: Math.round(((bid + ask) / 2) * 100) / 100, time: Number(q.ts) || nowMs };
    }
  } else if (source === "gold-api") {
    const price = Number(j?.price);
    const time = Date.parse(j?.updatedAt) || nowMs;
    if (Number.isFinite(price)) return { price, time };
  } else {
    const meta = j?.chart?.result?.[0]?.meta || {};
    const price = Number(meta.regularMarketPrice);
    const time = Number(meta.regularMarketTime) * 1000 || nowMs;
    if (Number.isFinite(price)) return { price, time };
  }
  throw new Error("bad price from " + source);
}

async function livePrice(env) {
  const nowMs = Date.now();
  if (env.DB) {
    try {
      await ensureSchema(env.DB);
      const cached = await env.DB
        .prepare(`SELECT value FROM meta WHERE key = 'live_price'`)
        .first();
      if (cached?.value) {
        const c = JSON.parse(cached.value);
        // TTL on our fetch time: Yahoo market time itself can lag minutes.
        if (c.price && nowMs - (c.fetchedAt || 0) < LIVE_TTL_MS) {
          return json({
            price: c.price,
            time: c.time,
            cached: true,
            source: c.source || "live",
          });
        }
      }
    } catch {
      // fall through to live fetch
    }
  }
  try {
    let lastError = null;
    for (const s of LIVE_SOURCES) {
      try {
        const r = await fetch(s.url, {
          headers: { "User-Agent": "Mozilla/5.0 XAUUSD-Dashboard/1.0" },
        });
        if (!r.ok) throw new Error(s.name + " HTTP " + r.status);
        const parsed = parseLiveBody(s.name, await r.json(), nowMs);
        const out = { ...parsed, source: s.name };
        if (env.DB) {
          try {
            await env.DB.prepare(
              `INSERT OR REPLACE INTO meta(key, value) VALUES('live_price', ?)`
            )
              .bind(
                JSON.stringify({
                  price: out.price,
                  time: out.time,
                  source: out.source,
                  fetchedAt: nowMs,
                })
              )
              .run();
          } catch {
            // cache is best-effort
          }
        }
        return json(out);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("all live sources failed");
  } catch (error) {
    if (env.DB) {
      try {
        const stale = await env.DB
          .prepare(`SELECT value FROM meta WHERE key = 'live_price'`)
          .first();
        if (stale?.value) {
          const c = JSON.parse(stale.value);
          return json({ ...c, stale: true });
        }
      } catch {
        // ignore
      }
    }
    return json({ error: error.message }, 502);
  }
}

function describeMarket(marketData) {
  // Returns { text, snapshot } where snapshot is a JSON string or null.
  // Object (multi-TF) payloads are capped for the prompt, not the chart.
  if (Array.isArray(marketData)) {
    const compact = compactCandles(marketData);
    if (!compact.length) return { text: "[]", snapshot: null };
    return { text: JSON.stringify(compact), snapshot: JSON.stringify(compact) };
  }
  if (marketData && typeof marketData === "object") {
    const full = JSON.stringify(marketData);
    // Full object goes to the snapshot (parseable); prompt gets a cap.
    return { text: full.slice(0, 12000), snapshot: full.slice(0, 15000) };
  }
  return { text: "[]", snapshot: null };
}

function compactCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .filter(
      (c) =>
        c &&
        Number.isFinite(Number(c.time)) &&
        Number.isFinite(Number(c.close))
    )
    .map((c) => [
      c.time,
      round2(c.open),
      round2(c.high),
      round2(c.low),
      round2(c.close),
    ]);
}

async function loadContext(db) {
  const rows = await db
    .prepare(
      `SELECT kind, content, created_at FROM memories
       WHERE kind != 'knowledge'
       ORDER BY id DESC LIMIT 15`
    )
    .all();
  const mems = (rows.results || []).reverse();
  const snap = await db
    .prepare(`SELECT data, taken_at FROM snapshots ORDER BY id DESC LIMIT 1`)
    .first();
  const know = await db
    .prepare(
      `SELECT content FROM memories WHERE kind = 'knowledge'
       ORDER BY id DESC LIMIT 1`
    )
    .first();

  let block = "";
  if (know?.content) {
    block += know.content + "\n";
  }
  const kb = await db
    .prepare(
      `SELECT substr(content, 1, 400) AS c FROM memories
       WHERE kind = 'kb' ORDER BY id ASC`
    )
    .all();
  if (kb.results?.length) {
    block +=
      "[KIẾN THỨC NỀN XAUUSD — dùng để giải thích, đừng trích nguyên văn]\n" +
      kb.results.map((r) => `- ${r.c}`).join("\n").slice(0, 6000) +
      "\n";
  }
  if (mems.length) {
    block +=
      "[LONG-TERM MEMORY — rules, notes and past analyses, oldest first]\n" +
      mems
        .map((m) => `(${m.kind} @${m.created_at}) ${m.content}`)
        .join("\n")
        .slice(0, 5000) +
      "\n";
  }
  if (snap?.data) {
    try {
      const parsed = JSON.parse(snap.data);
      const arr = Array.isArray(parsed) ? parsed : parsed.candles;
      if (Array.isArray(arr) && arr.length) {
        const last = arr[arr.length - 1];
        const close = Array.isArray(last) ? last[4] : last?.close;
        const label = parsed.tf ? ` (${parsed.tf})` : "";
        block +=
          `[LATEST SAVED SNAPSHOT${label} @${snap.taken_at}] ` +
          `${arr.length} candles, last close ${close}.\n`;
      } else if (parsed.timeframes) {
        // Multi-TF snapshot: one line per timeframe.
        const lines = Object.entries(parsed.timeframes)
          .map(([k, v]) => `${k}: last ${v?.last ?? "-"} (${v?.count ?? 0})`)
          .join(", ");
        block += `[LATEST SAVED SNAPSHOT @${snap.taken_at}] ${lines}.\n`;
      }
    } catch {
      // ignore corrupt snapshot
    }
  }
  return block.slice(0, 6000);
}

// ---------- macro news (ForexFactory) ----------

const NEWS_TTL_MS = 60 * 60 * 1000;
const FF_CAL_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
const FF_GOLD_URL = "https://www.forexfactory.com/market/goldusd";

function xmlTag(block, name) {
  const m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(block);
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 XAUUSD-Dashboard/1.0" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function refreshMacroNews(db) {
  const events = [];
  const headlines = [];
  try {
    const xml = await fetchText(FF_CAL_URL, 12000);
    const blocks = xml.match(/<event>([\s\S]*?)<\/event>/g) || [];
    const all = blocks.map((b) => ({
      title: xmlTag(b, "title"),
      country: xmlTag(b, "country"),
      date: xmlTag(b, "date"),
      time: xmlTag(b, "time"),
      impact: xmlTag(b, "impact"),
      forecast: xmlTag(b, "forecast"),
      previous: xmlTag(b, "previous"),
    }));
    const usd = all.filter(
      (e) => e.country === "USD" && (e.impact === "High" || e.impact === "Medium")
    );
    const otherHigh = all.filter(
      (e) => e.country !== "USD" && e.impact === "High"
    );
    for (const e of [...usd, ...otherHigh].slice(0, 15)) events.push(e);
  } catch {
    // keep stale/empty on failure
  }
  try {
    const html = await fetchText(FF_GOLD_URL, 12000);
    const re =
      /<a[^>]*href="([^"]+)"[^>]*>([^<>]{30,180})<\/a>\s*From\s*([^<|]+?)(?:\||<)/g;
    let m;
    let n = 0;
    while ((m = re.exec(html)) && n < 8) {
      const href = m[1].startsWith("http")
        ? m[1]
        : "https://www.forexfactory.com" + m[1];
      headlines.push({ title: m[2].trim(), source: m[3].trim(), url: href });
      n++;
    }
  } catch {
    // headlines are best-effort
  }
  const payload = JSON.stringify({
    events,
    headlines,
    updated_at: new Date().toISOString(),
  });
  await db
    .prepare(
      `INSERT OR REPLACE INTO news_cache(key, payload, updated_at)
       VALUES('macro', ?, datetime('now'))`
    )
    .bind(payload)
    .run();
  await addUsage(db, byteLen(payload));
  return JSON.parse(payload);
}

async function getMacroNews(db) {
  const row = await db
    .prepare(`SELECT payload, updated_at FROM news_cache WHERE key = 'macro'`)
    .first();
  if (row?.payload) {
    const age = Date.now() - new Date(row.updated_at + "Z").getTime();
    if (age < NEWS_TTL_MS) return JSON.parse(row.payload);
  }
  try {
    return await refreshMacroNews(db);
  } catch {
    return row?.payload
      ? JSON.parse(row.payload)
      : { events: [], headlines: [], updated_at: null };
  }
}

function macroBlock(macro) {
  if (!macro) return "";
  let s = "[MACRO CONTEXT — ForexFactory competent sources]\n";
  if (macro.events?.length) {
    s +=
      "Upcoming/key economic events:\n" +
      macro.events
        .map(
          (e) =>
            `- ${e.date} ${e.time} ${e.country} ${e.title} [${e.impact}]` +
            (e.forecast ? ` F:${e.forecast}` : "") +
            (e.previous ? ` P:${e.previous}` : "")
        )
        .join("\n")
        .slice(0, 2000) +
      "\n";
  }
  if (macro.headlines?.length) {
    s +=
      "Gold headlines:\n" +
      macro.headlines
        .map((h) => `- ${h.title} (${h.source})`)
        .join("\n")
        .slice(0, 1200) +
      "\n";
  }
  return s.slice(0, 3200);
}

// ---------- setup backtest ----------

function parseNum(s) {
  if (s == null) return null;
  const m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Convert any chart the model can't read (raw candles) into a compact
// technical digest: RSI-14, range position, ATR, streak, swing extremes.
function rsi14(closes) {
  if (closes.length < 15) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / 14 / (losses / 14);
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function summarizeTF(candles) {
  const valid = (Array.isArray(candles) ? candles : []).filter(
    (c) =>
      c &&
      [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(Number(v)))
  );
  if (!valid.length) return null;
  const closes = valid.map((c) => Number(c.close));
  const highs = valid.map((c) => Number(c.high));
  const lows = valid.map((c) => Number(c.low));
  const last = closes[closes.length - 1];
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  let atr = null;
  const trs = [];
  for (let i = Math.max(1, valid.length - 14); i < valid.length; i++) {
    const c = valid[i];
    const p = valid[i - 1];
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    );
  }
  if (trs.length) atr = Math.round((trs.reduce((a, b) => a + b, 0) / trs.length) * 100) / 100;
  let streak = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    const d = closes[i] - closes[i - 1];
    if (streak >= 0 && d >= 0) streak++;
    else if (streak <= 0 && d < 0) streak--;
    else break;
  }
  return {
    last,
    count: valid.length,
    rsi14: rsi14(closes),
    rangePos:
      hi === lo ? 50 : Math.round(((last - lo) / (hi - lo)) * 100),
    atr,
    streak,
    swingHigh: hi,
    swingLow: lo,
  };
}

function techDigest(marketData) {
  const out = [];
  const tfs = marketData?.timeframes || null;
  const push = (name, candles) => {
    const s = summarizeTF(candles);
    if (!s) return;
    out.push(
      `${name}: last ${s.last}, RSI14 ${s.rsi14 ?? "-"}, ` +
        `vị trí trong biên ${s.count} nến: ${s.rangePos}%, ` +
        `ATR ${s.atr ?? "-"}, chuỗi ${s.streak > 0 ? "+" + s.streak : s.streak}, ` +
        `swing H/L ${s.swingHigh}/${s.swingLow}`
    );
  };
  if (tfs) {
    for (const k of ["1m", "5m", "15m", "1h", "4h", "1D"]) {
      if (tfs[k]?.candles) push(k, tfs[k].candles);
    }
  } else if (Array.isArray(marketData)) {
    push("data", marketData);
  }
  if (!out.length) return "";
  return "[TECHNICAL DIGEST — chỉ báo đã tính sẵn, đừng tính lại]\n" + out.join("\n");
}

function setupKV(text) {
  const m = /```setup([\s\S]*?)```/.exec(text || "");
  const src = m ? m[1] : text || "";
  const out = {};
  for (const line of src.split("\n")) {
    const mm =
      /^\s*(?:[-*•]\s*)?(?:\d+[.)]\s*)?(?:\*\*)?\s*([^:：\-–—*]{1,20}?)(?:\*\*)?\s*[:：\-–—]\s*(.+?)\s*$/.exec(
        line
      );
    if (mm) out[mm[1].trim().toLowerCase()] = mm[2].replace(/\*\*/g, "").trim();
  }
  return out;
}

function extractSetup(text) {
  const kv = setupKV(text);
  const get = (...names) => {
    for (const n of names) if (kv[n]) return kv[n];
    return "";
  };
  const entry = parseNum(get("entry", "điểm vào", "vào lệnh"));
  const tp = parseNum(get("tp", "chốt lời"));
  const sl = parseNum(get("sl", "cắt lỗ"));
  if (entry == null || tp == null || sl == null) return null;
  const t = get("xu hướng").toUpperCase();
  let trend = /GIẢM|GIAM|DOWN|SHORT|SELL/.test(t)
    ? "SHORT"
    : /TĂNG|TANG|UP|LONG|BUY/.test(t)
      ? "LONG"
      : "SIDEWAYS";
  // Direction geometry: LONG needs SL < entry < TP; SHORT needs TP < entry < SL.
  // Fix a contradicting label; reject numbers that fit neither side (junk).
  const longOk = sl < entry && entry < tp;
  const shortOk = tp < entry && entry < sl;
  if (trend === "LONG" && !longOk) trend = shortOk ? "SHORT" : "SIDEWAYS";
  else if (trend === "SHORT" && !shortOk) trend = longOk ? "LONG" : "SIDEWAYS";
  const style = /SWING/.test(get("kiểu").toUpperCase()) ? "SWING" : "SCALPING";
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
  const valid =
    (trend === "LONG" && longOk) ||
    (trend === "SHORT" && shortOk) ||
    (trend === "SIDEWAYS" && (longOk || shortOk));
  return {
    trend,
    style,
    entry,
    tp,
    sl,
    rr,
    valid,
    pending: get("lệnh chờ", "lệnh"),
    scalp: get("scalp"),
    swing: get("swing"),
    reason: get("lý do"),
  };
}

function marketLast(marketData) {
  const pick = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const v = Number(arr[arr.length - 1]?.close);
    return Number.isFinite(v) ? v : null;
  };
  if (Array.isArray(marketData)) return pick(marketData);
  const tfs = marketData?.timeframes || {};
  for (const k of ["1m", "5m", "15m", "1h", "4h", "1D"]) {
    const v = pick(tfs[k]?.candles);
    if (v != null) return v;
  }
  return null;
}

function judgeCandles(marketData) {  // Finest series available for verdicts: 1m, else 5m, else 15m.
  const pick = (arr) =>
    Array.isArray(arr)
      ? arr.filter(
          (c) =>
            c &&
            Number.isFinite(c.time) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low)
        )
      : [];
  if (Array.isArray(marketData)) return pick(marketData);
  const tfs = marketData?.timeframes || {};
  for (const k of ["1m", "5m", "15m", "1h", "4h"]) {
    const arr = pick(tfs[k]?.candles);
    if (arr.length) return arr;
  }
  return [];
}

// Entry $1.5+ away from market = pending order, else market order.
const PENDING_GAP = 1.5;

async function judgeSetups(db, candles) {
  if (!candles.length) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .prepare(
      `SELECT * FROM setups WHERE status IN ('OPEN', 'PENDING')
       AND created_ts > ? ORDER BY id ASC`
    )
    .bind(nowSec - 7 * 86400)
    .all();
  const verdicts = [];
  for (const s of rows.results || []) {
    if (!(s.entry > 0) || !(s.tp > 0) || !(s.sl > 0)) continue;
    let activeFrom = s.created_ts;
    // Pending activates when a candle after placement crosses entry.
    // Pending is never judged WON/LOST.
    if (s.status === "PENDING") {
      let touched = null;
      for (const c of candles) {
        if (!(c.time > s.created_ts)) continue;
        if (c.low <= s.entry && s.entry <= c.high) {
          touched = c.time;
          break;
        }
      }
      if (touched == null) continue; // still waiting
      activeFrom = touched;
      await db
        .prepare(
          `UPDATE setups SET status = 'OPEN', activated_ts = ?, note = ?
           WHERE id = ?`
        )
        .bind(
          touched,
          `Kích hoạt lúc ${new Date(touched * 1000).toISOString()}`,
          s.id
        )
        .run();
    }
    // Range judging from activation on: TP first WON, SL first LOST.
    // Same candle hits both sides → conservative LOST.
    let verdict = null;
    let hitPrice = null;
    let hitTime = null;
    for (const c of candles) {
      if (!(c.time > activeFrom)) continue;
      const slHit =
        (s.sl <= s.entry && c.low <= s.sl) ||
        (s.sl >= s.entry && c.high >= s.sl);
      const tpHit =
        (s.tp >= s.entry && c.high >= s.tp) ||
        (s.tp <= s.entry && c.low <= s.tp);
      if (slHit) {
        verdict = "LOST";
        hitPrice = s.sl;
        hitTime = c.time;
        break;
      }
      if (tpHit) {
        verdict = "WON";
        hitPrice = s.tp;
        hitTime = c.time;
        break;
      }
    }
    if (!verdict) continue;
    const note =
      `${verdict === "WON" ? "THẮNG" : "THUA"} — giá chạm ${hitPrice} lúc ` +
      new Date(hitTime * 1000).toISOString();
    await db
      .prepare(`UPDATE setups SET status = ?, judged_at = datetime('now'), note = ? WHERE id = ?`)
      .bind(verdict, note, s.id)
      .run();
    // Score the pattern: WON +1, SWING WON +3 (harder calls earn more),
    // any LOST -1. Relearn signal for future analysis.
    const pattern = `${s.style} ${s.trend}`;
    const delta = verdict === "WON" ? (s.style === "SWING" ? 3 : 1) : -1;
    await db
      .prepare(
        `INSERT INTO scores(pattern, score, won, lost, updated_at)
         VALUES(?, ?, ?, ?, datetime('now'))
         ON CONFLICT(pattern) DO UPDATE SET
           score = score + ?,
           won = won + ?,
           lost = lost + ?,
           updated_at = datetime('now')`
      )
      .bind(
        pattern,
        delta,
        verdict === "WON" ? 1 : 0,
        verdict === "LOST" ? 1 : 0,
        delta,
        verdict === "WON" ? 1 : 0,
        verdict === "LOST" ? 1 : 0
      )
      .run();
    const sc = await db
      .prepare(`SELECT score, won, lost FROM scores WHERE pattern = ?`)
      .bind(pattern)
      .first();
    const lesson =
      `Bài học #${s.id} (${pattern} entry ${s.entry} TP ${s.tp} SL ${s.sl}): ${note} ` +
      `(điểm ${pattern}: ${sc?.score ?? delta}).`.slice(0, 600);
    await db
      .prepare(`INSERT INTO memories(kind, content) VALUES('lesson', ?)`)
      .bind(lesson)
      .run();
    await addUsage(db, byteLen(lesson));
    verdicts.push({ id: s.id, verdict });
  }
  await db
    .prepare(
      `DELETE FROM setups WHERE status != 'OPEN' AND judged_at < datetime('now', '-90 days')`
    )
    .run();
  return verdicts;
}

async function trackRecord(db) {
  const rows = await db
    .prepare(`SELECT status, COUNT(*) AS c FROM setups GROUP BY status`)
    .all();
  const c = { OPEN: 0, WON: 0, LOST: 0 };
  for (const r of rows.results || []) c[r.status] = r.c;
  let s =
    `[TRACK RECORD] setups đã chấm: ${c.WON + c.LOST} ` +
    `(${c.WON} thắng / ${c.LOST} thua), đang mở: ${c.OPEN}.`;
  const recent = await db
    .prepare(
      `SELECT trend, style, entry, tp, sl, status, note FROM setups
       WHERE status != 'OPEN' ORDER BY id DESC LIMIT 5`
    )
    .all();
  if (recent.results?.length) {
    s +=
      "\nGần nhất:\n" +
      recent.results
        .map(
          (r) =>
            `- ${r.style} ${r.trend} E${r.entry} TP${r.tp} SL${r.sl} → ${r.status} (${r.note || ""})`
        )
        .join("\n")
        .slice(0, 800);
  }
  const scores = await db
    .prepare(`SELECT pattern, score, won, lost FROM scores ORDER BY score DESC`)
    .all();
  if (scores.results?.length) {
    s +=
      "\nĐIỂM PATTERN (scalp thắng +1, swing thắng +3, thua -1 — ưu tiên điểm cao, học lại từ điểm âm):\n" +
      scores.results
        .map((r) => `- ${r.pattern}: ${r.score} (${r.won}W/${r.lost}L)`)
        .join("\n")
        .slice(0, 600);
  }
  return s.slice(0, 1600);
}

// Casual gate against accidental taps — NOT real security: this constant
// ships in the public repo and bundle, so anyone can read it.
const CLEAN_PASSWORD = "anhnhandeptrai";

async function storageClean(request, env) {
  try {
    if (!env.DB) return json({ error: "Missing DB binding" }, 500);
    const body = await request.json();
    if (body.password !== CLEAN_PASSWORD) {
      return json({ error: "Sai mật khẩu" }, 403);
    }
    await ensureSchema(env.DB);
    const db = env.DB;
    // Compress first: fold everything into the knowledge digest,
    // then delete. Rules, notes and lessons are never deleted.
    await buildKnowledge(db);
    const before = await storageInfo(db);

    // 1. Snapshots: delete older than 7 days, always keep newest 10.
    const snapDel = await db
      .prepare(
        `DELETE FROM snapshots WHERE taken_at < datetime('now', '-7 days')
         AND id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 10)`
      )
      .run();
    const snapshotsDeleted = snapDel.meta?.changes || 0;

    // 2. Compress: snapshots older than 3 days keep only last 50 candles.
    let snapshotsTrimmed = 0;
    const trimmable = await db
      .prepare(
        `SELECT id, data FROM snapshots
         WHERE taken_at < datetime('now', '-3 days')`
      )
      .all();
    for (const r of trimmable.results || []) {
      try {
        const arr = JSON.parse(r.data);
        if (Array.isArray(arr) && arr.length > 50) {
          const cut = JSON.stringify(arr.slice(-50));
          await db
            .prepare(`UPDATE snapshots SET data = ? WHERE id = ?`)
            .bind(cut, r.id)
            .run();
          snapshotsTrimmed++;
        }
      } catch {
        // object-form snapshots are left alone
      }
    }

    // 3. Memories: keep all lessons/rules/notes; analyses keep newest 100.
    const memDel = await db
      .prepare(
        `DELETE FROM memories WHERE kind = 'analysis'
         AND id NOT IN (
           SELECT id FROM memories WHERE kind = 'analysis'
           ORDER BY id DESC LIMIT 100
         )`
      )
      .run();

    // 4. Setups: judged older than 30 days go.
    const stDel = await db
      .prepare(
        `DELETE FROM setups WHERE status != 'OPEN'
         AND judged_at < datetime('now', '-30 days')`
      )
      .run();

    // 5. Recompute usage from actual rows (estimate).
    const sizes = await db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM memories) +
           (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM snapshots) +
           (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM news_cache)
           AS total`
      )
      .first();
    await db
      .prepare(`UPDATE meta SET value = ? WHERE key = 'usage_bytes'`)
      .bind(String(sizes?.total || 0))
      .run();

    const after = await storageInfo(db);
    return json({
      ok: true,
      stats: {
        memories_deleted: memDel.meta?.changes || 0,
        snapshots_deleted: snapshotsDeleted,
        snapshots_trimmed: snapshotsTrimmed,
        setups_deleted: stDel.meta?.changes || 0,
        bytes_before: before.used_bytes,
        bytes_after: after.used_bytes,
      },
      storage: after,
    });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

async function pruneMemories(db) {
  // Only analyses are pruned. Rules, notes, lessons and knowledge
  // are never auto-deleted.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c, MAX(id) AS m FROM memories WHERE kind = 'analysis'`
    )
    .first();
  if (row && row.c > MAX_MEMORIES + 50) {
    await db
      .prepare(
        `DELETE FROM memories WHERE kind = 'analysis' AND id <= ?`
      )
      .bind(row.m - MAX_MEMORIES)
      .run();
  }
}

// Fold stats + recent lessons into ONE 'knowledge' row: the compressed
// base for future analysis. Called before deletions so nothing is lost.
async function buildKnowledge(db) {
  const rows = await db
    .prepare(
      `SELECT trend, style, status, COUNT(*) AS c FROM setups
       GROUP BY trend, style, status`
    )
    .all();
  const counters = await db
    .prepare(
      `SELECT kind, COUNT(*) AS c FROM memories
       WHERE kind IN ('rule', 'note', 'lesson') GROUP BY kind`
    )
    .all();
  const lessons = await db
    .prepare(
      `SELECT substr(content, 1, 200) AS s FROM memories
       WHERE kind = 'lesson' ORDER BY id DESC LIMIT 3`
    )
    .all();
  const parts = [];
  const tally = {};
  for (const r of rows.results || []) {
    tally[`${r.style} ${r.trend} ${r.status}`] = r.c;
  }
  const t = (k) => tally[k] || 0;
  const lw = t("SCALPING LONG WON") + t("SWING LONG WON");
  const ll = t("SCALPING LONG LOST") + t("SWING LONG LOST");
  const sw = t("SCALPING SHORT WON") + t("SWING SHORT WON");
  const sl = t("SCALPING SHORT LOST") + t("SWING SHORT LOST");
  parts.push(
    `CƠ SỞ TRI THỨC — setup đã chấm: LONG ${lw} thắng/${ll} thua, ` +
      `SHORT ${sw} thắng/${sl} thua.`
  );
  const counts = {};
  for (const r of counters.results || []) counts[r.kind] = r.c;
  parts.push(
    `Đã lưu: ${counts.rule || 0} quy tắc, ${counts.note || 0} ghi chú, ` +
      `${counts.lesson || 0} bài học.`
  );
  if (lessons.results?.length) {
    parts.push(
      "Bài học gần nhất:\n" +
        lessons.results.map((r) => `- ${r.s}`).join("\n")
    );
  }
  const proven = await db
    .prepare(
      `SELECT pattern, score, won, lost FROM scores
       WHERE score > 0 ORDER BY score DESC`
    )
    .all();
  if (proven.results?.length) {
    parts.push(
      "PATTERN ĐÃ CHỨNG MINH (cơ sở, ưu tiên dùng lại):\n" +
        proven.results
          .map((r) => `- ${r.pattern}: +${r.score} (${r.won}W/${r.lost}L)`)
          .join("\n")
    );
  } else {
    parts.push("Chưa có pattern nào điểm dương.");
  }
  const digest = parts.join("\n").slice(0, 1500);  await db.prepare(`DELETE FROM memories WHERE kind = 'knowledge'`).run();
  await db
    .prepare(`INSERT INTO memories(kind, content) VALUES('knowledge', ?)`)
    .bind(digest)
    .run();
  await addUsage(db, byteLen(digest));
}

// ---------- routes ----------

const ALLOWED_INTERVALS = ["1min", "5min", "15min", "1h", "4h", "1day"];

// Longer history costs the same 1 credit per request on Twelve Data,
// so take full context: 500 intraday candles, 365 daily (~1 year).
const OUTPUT_SIZES = {
  "1min": 500,
  "5min": 500,
  "15min": 500,
  "1h": 500,
  "4h": 500,
  "1day": 365,
};

// Twelve values (newest-first, datetime strings) → ascending OHLC for judging.
function twelveToCandles(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => ({
      time: Math.floor(new Date(v.datetime).getTime() / 1000),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
    }))
    .filter(
      (c) => Number.isFinite(c.time) && Number.isFinite(c.high) && Number.isFinite(c.low)
    )
    .sort((a, b) => a.time - b.time);
}

async function getXAUUSD(env, interval) {
  if (!env.TWELVE_DATA_API_KEY) {
    return json({ error: "Missing TWELVE_DATA_API_KEY secret" }, 500);
  }
  if (!ALLOWED_INTERVALS.includes(interval)) {
    interval = "1min";
  }

  const apiUrl = new URL("https://api.twelvedata.com/time_series");
  apiUrl.searchParams.set("symbol", "XAU/USD");
  apiUrl.searchParams.set("interval", interval);
  apiUrl.searchParams.set("outputsize", String(OUTPUT_SIZES[interval] || 200));
  // Force UTC datetimes so candle times align with setup timestamps.
  apiUrl.searchParams.set("timezone", "UTC");
  apiUrl.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

  const response = await fetch(apiUrl);

  if (!response.ok) {
    return json({ error: "Twelve Data request failed" }, 502);
  }

  const data = await response.json();

  if (data.status === "error") {
    return json(data, 400);
  }
  // Anchor for clients: unix seconds when Twelve was fetched.
  data._fetched_at = Math.floor(Date.now() / 1000);

  // Judge open setups on every market fetch (not only on chat):
  // entry/TP/SL were noted with timestamps when the AI answered.
  if (env.DB) {
    try {
      await ensureSchema(env.DB);
      const verdicts = await judgeSetups(env.DB, twelveToCandles(data.values));
      if (verdicts.length) await buildKnowledge(env.DB);
    } catch {
      // judging never blocks market data
    }
  }

  return json(data);
}

async function saveMemory(request, env) {
  try {
    if (!env.DB) return json({ error: "Missing DB binding" }, 500);
    const body = await request.json();
    const kind = body.kind === "note" ? "note" : "rule";
    const content = String(body.content || "").trim().slice(0, 4000);
    if (!content) return json({ error: "Empty content" }, 400);

    await ensureSchema(env.DB);
    await env.DB.prepare(
      `INSERT INTO memories(kind, content) VALUES(?, ?)`
    )
      .bind(kind, content)
      .run();
    await addUsage(env.DB, byteLen(content));
    await pruneMemories(env.DB);
    return json({ ok: true, storage: await storageInfo(env.DB) });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

// Workers AI: no API key, no region block. Response normalized to
// Gemini shape so the frontend is unchanged. Old context from D1 is
// injected into every chat call.
async function chatWithAI(request, env) {
  try {
    if (!env.AI) return json({ error: "Missing AI binding" }, 500);

    const body = await request.json();
    const prompt = String(body.prompt || "");
    const marketData = body.marketData || null;
    const boost = body.boost === true;

    let memoryBlock = "";
    let track = "";
    let storage = null;
    const md = describeMarket(marketData);
    const tech = techDigest(marketData);
    let macro = "";
    if (env.DB) {
      await ensureSchema(env.DB);
      try {
        macro = macroBlock(await getMacroNews(env.DB));
      } catch {
        macro = "";
      }
      // Backtest: judge open setups against the finest fresh candles.
      // New verdicts refresh the knowledge digest immediately.
      try {
        const verdicts = await judgeSetups(env.DB, judgeCandles(marketData));
        if (verdicts.length) await buildKnowledge(env.DB);
      } catch {
        // judging never blocks the chat
      }
      memoryBlock = await loadContext(env.DB);
      try {
        track = await trackRecord(env.DB);
      } catch {
        track = "";
      }

      if (md.snapshot) {
        await env.DB.prepare(
          `INSERT INTO snapshots(data) VALUES(?)`
        )
          .bind(md.snapshot)
          .run();
        await addUsage(env.DB, byteLen(md.snapshot));
      }
    }

    const systemInstruction = `You are a Vietnamese trading chatbot for an XAU/USD dashboard. Chat naturally like a knowledgeable friend: concise, direct, a little personality, but every call stays grounded in data. Always reply in Vietnamese WITH FULL DIACRITICS (đầy đủ dấu), even when the user types without them. Use Markdown (bullets "- ", **bold** prices).

Think like an analyst: candles first, then macro news + memory + track record of your own past setups, reason step by step, then conclude. Vary phrasing. Be decisive: when the edge is real, give the setup with conviction and a clear invalidation (SL); only stand aside when truly no edge, saying plainly what would change your mind. Learn from your WON/LOST history — avoid repeating losing patterns.

Start every answer with one line "Trọng tâm: ..." restating what the user is really asking, then answer exactly that focus before any setup.

Rules: never invent market data; separate observation from interpretation; probabilities, never certainty.

Explain each call with theory, in order:
1. Kinh tế: Fed/lãi suất, USD/DXY, lạm phát (CPI/PCE), việc làm (NFP) — dùng đúng số lịch tin.
2. Chính trị/địa chính trị & tâm lý rủi ro (risk-on/off, trú ẩn, NHTW mua vàng).
3. Kỹ thuật: nêu phương pháp (BOS/CHoCH, liquidity, S/R...).

Always give a SCALP entry. Give a SWING entry (hold >1h) ONLY when the entry is beautiful: likely a peak or bottom backed by trend projection (4H/1D structure, strong support/resistance, projected future path). If no swing-quality entry exists, write "Swing: — (chờ ...)" naming exactly what you are waiting for. Suggest pending orders (BUY LIMIT / SELL STOP) with 3–10+ price levels across scenarios. An entry more than $2 from current market is a PENDING order: state its trigger condition. When the trend invalidates a pending order, cancel it by writing exactly "HỦY LỆNH CHỜ #id" with a one-line reason (cancelled orders are never scored).

Direction check before answering: for TĂNG/LONG, TP must be ABOVE entry and SL BELOW entry; for GIẢM/SHORT, TP BELOW entry and SL ABOVE entry. Never output a LONG with TP below entry. Minimum RR 1:1 (reward at least equals risk); if RR would be worse, do not force a market entry — give a pending zone at a peak/bottom instead.

You MUST end every answer with this exact block. ONE trend value. Fill every line (use "—" only if truly unknown):

\`\`\`setup
Xu hướng: TĂNG | GIẢM | SIDEWAYS
Kiểu: SCALPING | SWING
Entry: <giá>
TP: <mục tiêu>
SL: <cắt lỗ>
RR: <1:x, tính từ Entry/TP/SL>
Lệnh chờ: <BUY LIMIT / SELL STOP các mức, hoặc —>
Scalp: <entry scalping hoặc —>
Swing: <entry swing giữ >1h hoặc —>
Lý do: <1 câu>
\`\`\`

Ví dụ câu trả lời đúng:
Trọng tâm: bạn hỏi xu hướng và điểm vào.
- Giá **4136.44**, DXY suy yếu sau NFP, 4H vừa BOS lên khỏi 4120.

\`\`\`setup
Xu hướng: TĂNG
Kiểu: SWING
Entry: 4136.44
TP: 4150.00 / 4165.00
SL: 4128.00
RR: 1:2.5
Lệnh chờ: BUY LIMIT 4132 / 4128 / 4124 / 4120
Scalp: 4136.44
Swing: 4132.00 (đáy pullback sau BOS 4H, projection lên 4165)
Lý do: NFP yếu làm USD giảm, nến 1H BOS lên
\`\`\`

Track record and lessons to stay consistent with:`;

    const aiRes = await env.AI.run("@cf/qwen/qwen3-30b-a3b-fp8", {
      temperature: 0.7,
      max_tokens: boost ? 2500 : 1500,
      messages: [
        { role: "system", content: systemInstruction },
        {
          role: "user",
          content:
            (macro ? macro + "\n" : "") +
            (tech ? tech + "\n" : "") +
            (track ? track + "\n" : "") +
            (memoryBlock ? memoryBlock + "\n" : "") +
            "User question:\n" +
            prompt +
            "\n\nCurrent market data:\n" +
            md.text,
        },
      ],
    });

    let text = aiRes?.response || "AI returned no response.";
    // Strip reasoning traces if the model emits them.
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    if (env.DB) {
      // AI-cancelled pendings: "HỦY LỆNH CHỜ #id" anywhere in the reply.
      // Cancelled orders are never judged WON/LOST.
      const cancels = [
        ...text.matchAll(/hủy lệnh chờ\s*#(\d+)|cancel\s*#(\d+)/gi),
      ]
        .map((m) => Number(m[1] || m[2]))
        .filter((n) => Number.isFinite(n));
      for (const id of cancels) {
        await env.DB.prepare(
          `UPDATE setups SET status = 'CANCELLED', judged_at = datetime('now'),
           note = 'AI hủy theo xu hướng' WHERE id = ? AND status IN ('PENDING', 'OPEN')`
        )
          .bind(id)
          .run();
      }
      // Selective saving: only what helps future analysis.
      const tagged = /\[phân tích\]/i.test(prompt);
      const setup = extractSetup(text);
      // Geometrically invalid setups (TP/SL on the wrong sides) are junk:
      // never backtested, never memorized (unless explicitly tagged).
      const usable = setup && setup.valid;
      if (usable) {
        // Entry far from market, unknown market, or RR < 1 (min 1:1) →
        // PENDING waiting for a peak/bottom entry instead of a market order.
        const lastPx = marketLast(marketData);
        const status =
          lastPx == null ||
          Math.abs(setup.entry - lastPx) > PENDING_GAP ||
          (setup.rr != null && setup.rr < 1)
            ? "PENDING"
            : "OPEN";
        await env.DB.prepare(
          `INSERT INTO setups(created_ts, trend, style, entry, tp, sl, status)
           VALUES(?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            Math.floor(Date.now() / 1000),
            setup.trend,
            setup.style,
            setup.entry,
            setup.tp,
            setup.sl,
            status
          )
          .run();
        await addUsage(
          env.DB,
          byteLen(JSON.stringify(setup))
        );
      }
      if (tagged) {
        // Explicit learning material: save the full exchange as a lesson.
        const lesson =
          `[phân tích] Q: ${prompt}\nA: ${text}`.slice(0, 3000);
        await env.DB.prepare(
          `INSERT INTO memories(kind, content) VALUES('lesson', ?)`
        )
          .bind(lesson)
          .run();
        await addUsage(env.DB, byteLen(lesson));
      } else if (usable) {
        // Compact setup summary only — chit-chat is not saved.
        const body = text.replace(/```setup[\s\S]*?```/, "").trim();
        const entry =
          `Setup ${setup.style} ${setup.trend} E${setup.entry} ` +
          `TP${setup.tp} SL${setup.sl} | ${setup.reason || ""} | ` +
          body.slice(0, 300);
        await env.DB.prepare(
          `INSERT INTO memories(kind, content) VALUES('analysis', ?)`
        )
          .bind(entry.slice(0, 3000))
          .run();
        await addUsage(env.DB, byteLen(entry));
      }
      await pruneMemories(env.DB);
      storage = await storageInfo(env.DB);
    }

    return json({
      candidates: [{ content: { parts: [{ text }] } }],
      storage,
    });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
