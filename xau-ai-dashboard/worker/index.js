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

    if (url.pathname === "/api/news") {
      if (!env.DB) return json({ error: "Missing DB binding" }, 500);
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
      `INSERT OR IGNORE INTO meta(key, value) VALUES('usage_bytes', '0')`
    ),
  ]);
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
  const used = Number(usage?.value || 0);
  return {
    used_bytes: used,
    limit_bytes: D1_FREE_LIMIT_BYTES,
    tables: { memories: mem?.c || 0, snapshots: snap?.c || 0 },
    recent: recent.results || [],
  };
}

async function storageInfoResponse(env) {
  if (!env.DB) return json({ error: "Missing DB binding" }, 500);
  await ensureSchema(env.DB);
  return json(await storageInfo(env.DB));
}

function describeMarket(marketData) {
  // Returns { text, snapshot } where snapshot is a JSON string or null.
  if (Array.isArray(marketData)) {
    const compact = compactCandles(marketData);
    if (!compact.length) return { text: "[]", snapshot: null };
    return { text: JSON.stringify(compact), snapshot: JSON.stringify(compact) };
  }
  if (marketData && typeof marketData === "object") {
    const text = JSON.stringify(marketData).slice(0, 4000);
    return { text, snapshot: text };
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
       ORDER BY id DESC LIMIT 15`
    )
    .all();
  const mems = (rows.results || []).reverse();
  const snap = await db
    .prepare(`SELECT data, taken_at FROM snapshots ORDER BY id DESC LIMIT 1`)
    .first();

  let block = "";
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

async function pruneMemories(db) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c, MAX(id) AS m FROM memories`)
    .first();
  if (row && row.c > MAX_MEMORIES + 50) {
    await db
      .prepare(`DELETE FROM memories WHERE id <= ?`)
      .bind(row.m - MAX_MEMORIES)
      .run();
  }
}

// ---------- routes ----------

const ALLOWED_INTERVALS = ["1min", "5min", "1h", "4h"];

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
  apiUrl.searchParams.set("outputsize", "200");
  apiUrl.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

  const response = await fetch(apiUrl);

  if (!response.ok) {
    return json({ error: "Twelve Data request failed" }, 502);
  }

  const data = await response.json();

  if (data.status === "error") {
    return json(data, 400);
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

    let memoryBlock = "";
    let storage = null;
    const md = describeMarket(marketData);
    let macro = "";
    if (env.DB) {
      try {
        macro = macroBlock(await getMacroNews(env.DB));
      } catch {
        macro = "";
      }
    }
    if (env.DB) {
      await ensureSchema(env.DB);
      memoryBlock = await loadContext(env.DB);

      if (md.snapshot) {
        await env.DB.prepare(
          `INSERT INTO snapshots(data) VALUES(?)`
        )
          .bind(md.snapshot)
          .run();
        await addUsage(env.DB, byteLen(md.snapshot));
      }
    }

    const systemInstruction = `You are a Vietnamese trading assistant for an XAU/USD dashboard. Always reply in Vietnamese using Markdown (bullets with "- ", **bold** for prices).

Think like an analyst, not a template: start from what the candles actually show, weigh it against the macro news and long-term memory, reason step by step in your own words, and only then conclude. Vary your phrasing between answers. It is fine to say a setup is unclear and advise standing aside.

Rules: never invent market data; separate observed data from interpretation; express views in probabilities, never certainty.

Explain every call with theory first, in this order:
1. Kinh tế: Fed/lãi suất kỳ vọng, USD/DXY, lạm phát (CPI/PCE), việc làm (NFP), dùng đúng số liệu lịch tin được cung cấp.
2. Chính trị/địa chính trị & tâm lý rủi ro (risk-on/off, vàng trú ẩn, NHTW mua vàng).
3. Kỹ thuật: nêu rõ phương pháp dùng (cấu trúc BOS/CHoCH, liquidity, hỗ trợ/kháng cự...).

You MUST end every answer with this exact block. Pick exactly ONE trend value. Fill all 5 lines, never leave any blank (use "—" only if truly unknown):

\`\`\`setup
Xu hướng: TĂNG | GIẢM | SIDEWAYS
Entry: <vùng giá>
TP: <mục tiêu>
SL: <cắt lỗ>
Lý do: <1 câu>
\`\`\`

Ví dụ câu trả lời đúng:
- Giá đang **4136.44**, tăng **0.94%**.
- Fed giữ lãi suất, DXY suy yếu hỗ trợ vàng.

\`\`\`setup
Xu hướng: TĂNG
Entry: 4136.44
TP: 4140.00 / 4148.00
SL: 4130.00
Lý do: NFP yếu làm USD giảm, nến 1H BOS lên
\`\`\`

Long-term memory to stay consistent with:`;

    const aiRes = await env.AI.run("@cf/qwen/qwen3-30b-a3b-fp8", {
      temperature: 0.7,
      max_tokens: 1500,
      messages: [
        { role: "system", content: systemInstruction },
        {
          role: "user",
          content:
            (macro ? macro + "\n" : "") +
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
      const entry =
        `Q: ${prompt}\nA: ${text}`.slice(0, 3000);
      await env.DB.prepare(
        `INSERT INTO memories(kind, content) VALUES('analysis', ?)`
      )
        .bind(entry)
        .run();
      await addUsage(env.DB, byteLen(entry));
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
