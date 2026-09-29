import { useCallback, useEffect, useRef, useState } from "react";
import Chart from "./components/Chart";
import Controls from "./components/Controls";
import Analysis from "./components/Analysis";
import Chat from "./components/Chat";
import Memory from "./components/Memory";
import News from "./components/News";
import Orders from "./components/Orders";
import {
  getXAUUSD,
  askAI,
  convertCandles,
  getQuotaInfo,
  incRequestCount,
  getStorage,
  getNews,
  saveMemory,
  cleanStorage,
} from "./services/api";
import "./App.css";

// On-demand: fetch on open / tab switch is cache-only, manual ⟳ and chat.
// For chat, a timeframe is re-fetched only when older than its staleness
// window — 1 request = 1 symbol + 1 interval on Twelve Data, so this
// keeps analysis fresh where it moves while sparing the free quota.
const TIMEFRAMES = [
  { key: "1m", label: "1m", interval: "1min", staleMs: 90_000 },
  { key: "5m", label: "5m", interval: "5min", staleMs: 360_000 },
  { key: "15m", label: "15m", interval: "15min", staleMs: 900_000 },
  { key: "1h", label: "1H", interval: "1h", staleMs: 1_200_000 },
  { key: "4h", label: "4H", interval: "4h", staleMs: 2_400_000 },
  { key: "1D", label: "1D", interval: "1day", staleMs: 43_200_000 },
];

// Normal chat: higher TFs only (cheap + stable). Super Boost: all five, deep.
const NORMAL_TFS = ["5m", "1h", "4h"];

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString();
}

function App() {
  const [chartVisible, setChartVisible] = useState(true);
  const [activeTF, setActiveTF] = useState("1m");
  const [data, setData] = useState({
    "1m": [],
    "5m": [],
    "15m": [],
    "1h": [],
    "4h": [],
    "1D": [],
  });
  const [updating, setUpdating] = useState({});
  const [lastFetch, setLastFetch] = useState({});
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState([]);
  const [asking, setAsking] = useState(false);
  const [askPhase, setAskPhase] = useState(null);
  const [quota, setQuota] = useState(() => getQuotaInfo());
  const [storage, setStorage] = useState(null);
  const [news, setNews] = useState(null);
  const [boost, setBoost] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("xau_theme");
      if (saved === "light" || saved === "dark") return saved;
      if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
        return "dark";
      }
    } catch {
      // ignore
    }
    return "light";
  });
  const [style, setStyle] = useState(() => {
    try {
      const saved = localStorage.getItem("xau_style");
      if (saved === "ios" || saved === "terminal" || saved === "huawei") {
        return saved;
      }
    } catch {
      // ignore
    }
    return "ios";
  });
  const chartRef = useRef(null);
  const BUILD_ID = import.meta.env.VITE_BUILD_ID || "dev";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("xau_theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.style = style;
    try {
      localStorage.setItem("xau_style", style);
    } catch {
      // ignore
    }
  }, [style]);

  async function refreshStorage() {
    try {
      setStorage(await getStorage());
    } catch {
      // storage panel stays empty when Worker is unreachable
    }
  }

  useEffect(() => {
    refreshStorage();
  }, []);

  async function loadNews(refresh = false) {
    try {
      setNews(await getNews(refresh));
    } catch {
      // news panel stays empty when Worker is unreachable
    }
  }

  useEffect(() => {
    loadNews(false);
  }, []);

  // Returns fresh candles, or null on failure/quota stop.
  const loadTF = useCallback(async (tf) => {
    const q = getQuotaInfo();
    if (q.shouldStop) {
      setQuota(q);
      setError("Twelve Data daily quota reached. Requests paused.");
      return null;
    }
    setUpdating((u) => ({ ...u, [tf.key]: true }));
    try {
      const res = await getXAUUSD(tf.interval);
      incRequestCount();
      setQuota(getQuotaInfo());
      const candles = convertCandles(res.values);
      setData((d) => ({ ...d, [tf.key]: candles }));
      setLastFetch((t) => ({ ...t, [tf.key]: Date.now() }));
      setError("");
      return candles;
    } catch (e) {
      setError(`${tf.label}: ${e.message}`);
      return null;
    } finally {
      setUpdating((u) => ({ ...u, [tf.key]: false }));
    }
  }, []);

  // Initial load: active timeframe only. Others load on ⟳ or chat.
  useEffect(() => {
    loadTF(TIMEFRAMES[0]);
  }, [loadTF]);

  function handleSwitchTF(key) {
    setActiveTF(key);
  }

  function buildMarketContext(dataObj, deep) {
    const timeframes = {};
    for (const tf of TIMEFRAMES) {
      if (!deep && !NORMAL_TFS.includes(tf.key)) continue;
      const arr = dataObj[tf.key] || [];
      const last = arr[arr.length - 1];
      const prev = arr[arr.length - 2];
      const n = deep ? (tf.key === activeTF ? 60 : 30) : tf.key === activeTF ? 30 : 10;
      timeframes[tf.key] = {
        count: arr.length,
        last: last?.close ?? null,
        change: last && prev ? +(last.close - prev.close).toFixed(2) : null,
        candles: arr.slice(-n),
      };
    }
    return { active: activeTF, boost: deep, timeframes };
  }

  async function handleAskAI() {
    if (!question.trim() || asking) return;
    const q = question.trim();
    setQuestion("");
    // Snapshot the visible chart — attached to the AI reply below.
    const shot = chartRef.current?.screenshot?.() || null;
    setHistory((h) => [...h, { role: "user", text: q }]);
    setAsking(true);
    try {
      // Normal: refresh only stale higher TFs (5m/1h/4h).
      // Super Boost: force-fresh all five timeframes, deep context.
      setAskPhase("fetch");
      const nowTs = Date.now();
      const target = boost
        ? TIMEFRAMES
        : TIMEFRAMES.filter((tf) => NORMAL_TFS.includes(tf.key));
      const current = {};
      TIMEFRAMES.forEach((tf) => {
        current[tf.key] = data[tf.key] || [];
      });
      await Promise.all(
        target.map(async (tf) => {
          if (!boost) {
            const last = lastFetch[tf.key] || 0;
            const hasData = (current[tf.key] || []).length > 0;
            if (hasData && nowTs - last < tf.staleMs) return;
          }
          const fresh = await loadTF(tf);
          if (fresh?.length) current[tf.key] = fresh;
        })
      );
      setAskPhase("ai");
      const result = await askAI(q, buildMarketContext(current, boost), boost);
      const text =
        result?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "AI returned no response.";
      setHistory((h) => {
        // Keep screenshots only on recent messages to bound memory.
        const pruned = h.map((m, idx) =>
          m.shot && idx < h.length - 4 ? { ...m, shot: null } : m
        );
        return [...pruned, { role: "ai", text, shot }];
      });
      if (result?.storage) setStorage(result.storage);
    } catch (e) {
      setHistory((h) => [...h, { role: "ai", text: `Error: ${e.message}` }]);
    } finally {
      setAsking(false);
      setAskPhase(null);
    }
  }

  async function handleSaveMemory(kind, text) {
    const result = await saveMemory(kind, text);
    if (result?.storage) {
      setStorage(result.storage);
    } else {
      refreshStorage();
    }
  }

  async function handleCleanStorage(password) {
    const result = await cleanStorage(password);
    if (result?.storage) setStorage(result.storage);
    return result;
  }

  const activeTFConf = TIMEFRAMES.find((t) => t.key === activeTF);
  const activeData = data[activeTF] || [];

  return (
    <div className="app">
      <header>
        <div className="header-row">
          <h1>XAUUSD AI Analyzer</h1>
          <div className="style-switch">
            {[
              ["ios", "iOS"],
              ["terminal", "Terminal"],
              ["huawei", "Huawei"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={style === key ? "active" : ""}
                onClick={() => setStyle(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            title="Chuyển chế độ sáng hoặc tối"
          >
            {theme === "light" ? "Chế độ tối" : "Chế độ sáng"}
          </button>
        </div>
        <Controls
          chartVisible={chartVisible}
          quota={quota}
          onToggleChart={() => setChartVisible((v) => !v)}
        />
      </header>

      {error && <div className="error">{error}</div>}

      <main>
        <section className="chart-panel">
          <div className="tf-tabs">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.key}
                className={tf.key === activeTF ? "active" : ""}
                onClick={() => handleSwitchTF(tf.key)}
              >
                {tf.label}
                {updating[tf.key] ? " ●" : ""}
              </button>
            ))}
            <button
              className="refresh-one"
              onClick={() => loadTF(activeTFConf)}
              title="Tải lại khung này"
            >
              ⟳
            </button>
          </div>

          {chartVisible ? (
            activeData.length || updating[activeTF] ? (
              <Chart
                key={activeTF + theme}
                ref={chartRef}
                data={activeData}
                theme={theme}
              />
            ) : (
              <div className="chart-empty">
                Chưa có dữ liệu khung {activeTFConf.label}. Bấm ⟳ để tải
              </div>
            )
          ) : (
            <div className="chart-hidden">Chart hidden</div>
          )}
          <div className="status">
            {updating[activeTF]
              ? "Đang tải..."
              : `Cập nhật lúc ${formatTime(lastFetch[activeTF])} (${activeTFConf.label}) · on-demand`}
          </div>
        </section>

        <aside className="ai-panel">
          <Orders storage={storage} onRefresh={refreshStorage} />
          <Analysis
            data={data}
            timeframes={TIMEFRAMES}
            loading={Object.values(updating).some(Boolean)}
            lastFetch={lastFetch}
          />
          <News news={news} onRefresh={() => loadNews(true)} />
          <Chat
            question={question}
            setQuestion={setQuestion}
            history={history}
            asking={asking}
            phase={askPhase}
            boost={boost}
            onToggleBoost={() => setBoost((b) => !b)}
            onSend={handleAskAI}
          />
          <Memory storage={storage} onSave={handleSaveMemory} onClean={handleCleanStorage} />
        </aside>
      </main>

      <footer className="footer">
        Dev by Fexxwer · GitHub{" "}
        <a
          href="https://github.com/LupinDsama"
          target="_blank"
          rel="noreferrer"
        >
          LupinDsama
        </a>{" "}
        · bản {BUILD_ID}
      </footer>
    </div>
  );
}

export default App;
