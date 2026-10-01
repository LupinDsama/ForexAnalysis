// Browser -> Cloudflare Worker proxy (keys stay server-side as Worker secrets).
// No API keys in this bundle, so the built site can be committed to git
// and served from Pages branch root without tripping push protection.

const API_URL =
  import.meta.env.VITE_WORKER_URL || "http://localhost:8787";

export async function getXAUUSD(interval = "1min") {
  const response = await fetch(
    `${API_URL}/api/xauusd?interval=${encodeURIComponent(interval)}`
  );

  if (!response.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      // ignore
    }
    throw new Error(`Failed to fetch XAU/USD (${response.status}) ${detail}`);
  }

  return response.json();
}

export async function askAI(prompt, marketData, boost = false) {
  const response = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, marketData, boost }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      // ignore
    }
    throw new Error(`AI request failed (${response.status}) ${detail}`);
  }

  return response.json();
}

export async function getStorage() {
  const response = await fetch(`${API_URL}/api/storage`);
  if (!response.ok) {
    throw new Error("Failed to fetch storage info");
  }
  return response.json();
}

export async function getNews(refresh = false) {
  const response = await fetch(
    `${API_URL}/api/news${refresh ? "?refresh=1" : ""}`
  );
  if (!response.ok) {
    throw new Error("Failed to fetch news");
  }
  return response.json();
}

export async function saveMemory(kind, content) {
  const response = await fetch(`${API_URL}/api/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, content }),
  });
  if (!response.ok) {
    throw new Error("Failed to save memory");
  }
  return response.json();
}

export async function getLive() {
  const response = await fetch(`${API_URL}/api/live`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Live feed failed");
  }
  return data;
}

export async function touchLive(price, time) {
  try {
    const response = await fetch(`${API_URL}/api/touch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price, time }),
    });
    if (!response.ok) return { ok: false, activated: [] };
    return await response.json();
  } catch {
    return { ok: false, activated: [] };
  }
}

export async function cleanStorage(password) {  const response = await fetch(`${API_URL}/api/storage/clean`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Cleanup failed");
  }
  return data;
}

function parseTwelveTime(s) {
  if (typeof s !== "string") return NaN;
  const t = s.trim();
  // "YYYY-MM-DD HH:MM:SS" (UTC per Worker request) or "YYYY-MM-DD".
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(t)
    ? `${t}T00:00:00Z`
    : t.replace(" ", "T") + "Z";
  return Math.floor(Date.parse(iso) / 1000);
}

export function convertCandles(values) {
  if (!Array.isArray(values)) return [];
  return [...values]
    .reverse()
    .map((candle) => ({
      // Twelve datetimes are forced to UTC server-side; parse as UTC
      // explicitly (a bare "YYYY-MM-DD HH:MM:SS" would parse as LOCAL time
      // and shift verdict windows by hours).
      time: parseTwelveTime(candle.datetime),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    );
}

// --- Quota manager (Twelve Data Free ~800 credits/day) ---
const DAILY_LIMIT = 800;
const SAFE_STOP_AT = 750;

function todayKey() {
  return `xau_req_count_${new Date().toISOString().slice(0, 10)}`;
}

export function getRequestCount() {
  try {
    return Number(localStorage.getItem(todayKey()) || 0);
  } catch {
    return 0;
  }
}

export function incRequestCount() {
  try {
    const next = getRequestCount() + 1;
    localStorage.setItem(todayKey(), String(next));
    return next;
  } catch {
    return getRequestCount();
  }
}

export function getQuotaInfo() {
  const used = getRequestCount();
  return {
    used,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - used),
    shouldStop: used >= SAFE_STOP_AT,
  };
}
