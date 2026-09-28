const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/xauusd") {
      return getXAUUSD(env);
    }

    if (url.pathname === "/api/chat") {
      return chatWithGemini(request, env);
    }

    return json({ ok: true, service: "XAUUSD AI Backend" });
  },
};

async function getXAUUSD(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    return json({ error: "Missing TWELVE_DATA_API_KEY secret" }, 500);
  }

  const apiUrl = new URL("https://api.twelvedata.com/time_series");
  apiUrl.searchParams.set("symbol", "XAU/USD");
  apiUrl.searchParams.set("interval", "1min");
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

async function chatWithGemini(request, env) {
  try {
    if (!env.GEMINI_API_KEY) {
      return json({ error: "Missing GEMINI_API_KEY secret" }, 500);
    }

    const body = await request.json();
    const prompt = body.prompt || "";
    const marketData = body.marketData || null;

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
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
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

    const data = await response.json();
    return json(data, response.ok ? 200 : 502);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
