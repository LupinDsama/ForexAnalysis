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

export async function askAI(prompt, marketData) {
  const response = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, marketData }),
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

export function convertCandles(values) {
  if (!Array.isArray(values)) return [];
  return [...values]
    .reverse()
    .map((candle) => ({
      time: Math.floor(new Date(candle.datetime).getTime() / 1000),
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
