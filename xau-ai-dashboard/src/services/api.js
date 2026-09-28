// Direct browser calls (Phase 1 local/demo).
// Keys come from Vite env (.env, gitignored) — never commit real keys.
// NOTE: keys are visible in shipped JS. For public deploy, prefer the
// Cloudflare Worker proxy in worker/ (keeps secrets server-side).

const TWELVE_KEY = import.meta.env.VITE_TWELVE_DATA_API_KEY || "";
const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.0-flash";

export async function getXAUUSD() {
  if (!TWELVE_KEY) {
    throw new Error("Missing VITE_TWELVE_DATA_API_KEY in .env");
  }

  const apiUrl = new URL("https://api.twelvedata.com/time_series");
  apiUrl.searchParams.set("symbol", "XAU/USD");
  apiUrl.searchParams.set("interval", "1min");
  apiUrl.searchParams.set("outputsize", "200");
  apiUrl.searchParams.set("apikey", TWELVE_KEY);

  const response = await fetch(apiUrl);

  if (!response.ok) {
    throw new Error(`Twelve Data request failed (${response.status})`);
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(data.message || "Twelve Data error");
  }

  return data;
}

export async function askAI(prompt, marketData) {
  if (!GEMINI_KEY) {
    throw new Error("Missing VITE_GEMINI_API_KEY in .env");
  }

  const systemInstruction = `You are an AI assistant for a financial market data visualization dashboard.

Analyze the supplied XAU/USD market data carefully.

Do not invent market data.
Clearly distinguish observed data from interpretation.
Do not claim certainty about future prices.

User question:
${prompt}

Current market data:
${JSON.stringify(marketData)}
`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: systemInstruction }],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`AI request failed (${response.status})`);
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
