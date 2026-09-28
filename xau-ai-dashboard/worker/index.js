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
      return chatWithAI(request, env);
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

// Workers AI instead of Gemini: Cloudflare's egress IPs are geolocated
// by Google to unsupported regions ("User location is not supported"),
// no matter the Worker placement. Workers AI runs inside Cloudflare,
// needs no API key, and stays on the free tier for personal use.
// Response is normalized to Gemini shape so the frontend is unchanged.
async function chatWithAI(request, env) {
  try {
    if (!env.AI) {
      return json({ error: "Missing AI binding" }, 500);
    }

    const body = await request.json();
    const prompt = body.prompt || "";
    const marketData = body.marketData || null;

    const systemInstruction = `You are an AI assistant for a financial market data visualization dashboard.

Analyze the supplied XAU/USD market data carefully.

Do not invent market data.
Clearly distinguish observed data from interpretation.
Do not claim certainty about future prices.`;

    const aiRes = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
      messages: [
        { role: "system", content: systemInstruction },
        {
          role: "user",
          content:
            "User question:\n" +
            prompt +
            "\n\nCurrent market data:\n" +
            JSON.stringify(marketData),
        },
      ],
    });

    const text = aiRes?.response || "AI returned no response.";

    return json({
      candidates: [{ content: { parts: [{ text }] } }],
    });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
