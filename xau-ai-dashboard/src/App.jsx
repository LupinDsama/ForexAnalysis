import { useCallback, useEffect, useState } from "react";
import Chart from "./components/Chart";
import Controls from "./components/Controls";
import Analysis from "./components/Analysis";
import Chat from "./components/Chat";
import Memory from "./components/Memory";
import {
  getXAUUSD,
  askAI,
  convertCandles,
  getQuotaInfo,
  incRequestCount,
  getStorage,
  saveMemory,
} from "./services/api";
import "./App.css";

// Refresh cadence per timeframe. Higher TFs barely move intraday,
// so they poll rarely to protect the Twelve Data free quota (800/day).
const TIMEFRAMES = [
  { key: "1m", label: "1m", interval: "1min", refreshMs: 60_000 },
  { key: "5m", label: "5m", interval: "5min", refreshMs: 300_000 },
  { key: "1h", label: "1H", interval: "1h", refreshMs: 900_000 },
  { key: "4h", label: "4H", interval: "4h", refreshMs: 1_800_000 },
];

function App() {
  const [chartVisible, setChartVisible] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activeTF, setActiveTF] = useState("1m");
  const [data, setData] = useState({ "1m": [], "5m": [], "1h": [], "4h": [] });
  const [updating, setUpdating] = useState({});
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState([]);
  const [asking, setAsking] = useState(false);
  const [quota, setQuota] = useState(() => getQuotaInfo());
  const [storage, setStorage] = useState(null);

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

  const loadTF = useCallback(async (tf) => {
    const q = getQuotaInfo();
    if (q.shouldStop) {
      setQuota(q);
      setAutoRefresh(false);
      setError("Twelve Data daily quota nearly reached — auto refresh stopped.");
      return;
    }
    setUpdating((u) => ({ ...u, [tf.key]: true }));
    try {
      const res = await getXAUUSD(tf.interval);
      incRequestCount();
      setQuota(getQuotaInfo());
      setData((d) => ({ ...d, [tf.key]: convertCandles(res.values) }));
      setError("");
    } catch (e) {
      setError(`${tf.label}: ${e.message}`);
    } finally {
      setUpdating((u) => ({ ...u, [tf.key]: false }));
    }
  }, []);

  // Initial load: all timeframes once.
  useEffect(() => {
    TIMEFRAMES.forEach((tf) => loadTF(tf));
  }, [loadTF]);

  // Per-timeframe auto refresh.
  useEffect(() => {
    if (!autoRefresh) return;
    const timers = TIMEFRAMES.map((tf) =>
      setInterval(() => loadTF(tf), tf.refreshMs)
    );
    return () => timers.forEach(clearInterval);
  }, [autoRefresh, loadTF]);

  function buildMarketContext() {
    const timeframes = {};
    for (const tf of TIMEFRAMES) {
      const arr = data[tf.key] || [];
      const last = arr[arr.length - 1];
      const prev = arr[arr.length - 2];
      timeframes[tf.key] = {
        count: arr.length,
        last: last?.close ?? null,
        change:
          last && prev ? +(last.close - prev.close).toFixed(2) : null,
        candles:
          tf.key === activeTF ? arr.slice(-30) : arr.slice(-10),
      };
    }
    return { active: activeTF, timeframes };
  }

  async function handleAskAI() {
    if (!question.trim() || asking) return;
    const q = question.trim();
    setQuestion("");
    setHistory((h) => [...h, { role: "user", text: q }]);
    setAsking(true);
    try {
      const result = await askAI(q, buildMarketContext());
      const text =
        result?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "AI returned no response.";
      setHistory((h) => [...h, { role: "ai", text }]);
      if (result?.storage) setStorage(result.storage);
    } catch (e) {
      setHistory((h) => [...h, { role: "ai", text: `Error: ${e.message}` }]);
    } finally {
      setAsking(false);
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

  const activeTFConf = TIMEFRAMES.find((t) => t.key === activeTF);

  return (
    <div className="app">
      <header>
        <h1>XAUUSD AI Analyzer</h1>
        <Controls
          chartVisible={chartVisible}
          autoRefresh={autoRefresh}
          quota={quota}
          onToggleChart={() => setChartVisible((v) => !v)}
          onToggleRefresh={() => setAutoRefresh((v) => !v)}
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
                onClick={() => setActiveTF(tf.key)}
              >
                {tf.label}
                {updating[tf.key] ? " ●" : ""}
              </button>
            ))}
            <button
              className="refresh-one"
              onClick={() => loadTF(activeTFConf)}
              title="Refresh this timeframe now"
            >
              ⟳
            </button>
          </div>

          {chartVisible ? (
            <Chart key={activeTF} data={data[activeTF]} />
          ) : (
            <div className="chart-hidden">Chart hidden</div>
          )}
          <div className="status">
            {updating[activeTF]
              ? "Updating..."
              : autoRefresh
                ? `Auto refresh ON (${activeTFConf.label})`
                : "Auto refresh OFF"}
          </div>
        </section>

        <aside className="ai-panel">
          <Analysis
            data={data}
            timeframes={TIMEFRAMES}
            loading={Object.values(updating).some(Boolean)}
            autoRefresh={autoRefresh}
          />
          <Chat
            question={question}
            setQuestion={setQuestion}
            history={history}
            asking={asking}
            onSend={handleAskAI}
          />
          <Memory storage={storage} onSave={handleSaveMemory} />
        </aside>
      </main>
    </div>
  );
}

export default App;
