import { useCallback, useEffect, useRef, useState } from "react";
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

const TIMEFRAMES = [
  { key: "1m", label: "1m", interval: "1min" },
  { key: "5m", label: "5m", interval: "5min" },
  { key: "1h", label: "1H", interval: "1h" },
  { key: "4h", label: "4H", interval: "4h" },
];

function formatTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

function App() {
  const [chartVisible, setChartVisible] = useState(true);
  const [activeTF, setActiveTF] = useState("1m");
  const [data, setData] = useState({ "1m": [], "5m": [], "1h": [], "4h": [] });
  const [updating, setUpdating] = useState({});
  const [lastFetch, setLastFetch] = useState({});
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState([]);
  const [asking, setAsking] = useState(false);
  const [quota, setQuota] = useState(() => getQuotaInfo());
  const [storage, setStorage] = useState(null);
  const chartRef = useRef(null);

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

  // Returns fresh candles, or null on failure/quota stop.
  const loadTF = useCallback(async (tf) => {
    const q = getQuotaInfo();
    if (q.shouldStop) {
      setQuota(q);
      setError("Twelve Data daily quota reached — requests paused.");
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

  // Initial load: all timeframes once, on demand afterwards.
  useEffect(() => {
    TIMEFRAMES.forEach((tf) => loadTF(tf));
  }, [loadTF]);

  function handleSwitchTF(key) {
    setActiveTF(key);
    const tf = TIMEFRAMES.find((t) => t.key === key);
    if (tf) loadTF(tf);
  }

  function buildMarketContext(dataObj) {
    const timeframes = {};
    for (const tf of TIMEFRAMES) {
      const arr = dataObj[tf.key] || [];
      const last = arr[arr.length - 1];
      const prev = arr[arr.length - 2];
      timeframes[tf.key] = {
        count: arr.length,
        last: last?.close ?? null,
        change: last && prev ? +(last.close - prev.close).toFixed(2) : null,
        candles: tf.key === activeTF ? arr.slice(-30) : arr.slice(-10),
      };
    }
    return { active: activeTF, timeframes };
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
      // Fresh data for every chat: all 4 timeframes on demand.
      const fresh = await Promise.all(TIMEFRAMES.map((tf) => loadTF(tf)));
      const merged = {};
      TIMEFRAMES.forEach((tf, i) => {
        merged[tf.key] =
          fresh[i]?.length ? fresh[i] : data[tf.key] || [];
      });
      const result = await askAI(q, buildMarketContext(merged));
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
              title="Fetch this timeframe now"
            >
              ⟳
            </button>
          </div>

          {chartVisible ? (
            <Chart key={activeTF} ref={chartRef} data={data[activeTF]} />
          ) : (
            <div className="chart-hidden">Chart hidden</div>
          )}
          <div className="status">
            {updating[activeTF]
              ? "Fetching..."
              : `Cập nhật lúc ${formatTime(lastFetch[activeTF])} (${activeTFConf.label}) · on-demand`}
          </div>
        </section>

        <aside className="ai-panel">
          <Analysis
            data={data}
            timeframes={TIMEFRAMES}
            loading={Object.values(updating).some(Boolean)}
            lastFetch={lastFetch}
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
