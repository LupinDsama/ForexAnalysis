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

function App() {
  const [chartVisible, setChartVisible] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);
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

  const loadMarketData = useCallback(async () => {
    const q = getQuotaInfo();
    if (q.shouldStop) {
      setQuota(q);
      setAutoRefresh(false);
      setError("Twelve Data daily quota nearly reached — auto refresh stopped.");
      return;
    }
    try {
      setLoading(true);
      setError("");
      const data = await getXAUUSD();
      incRequestCount();
      setQuota(getQuotaInfo());
      setCandles(convertCandles(data.values));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMarketData();
  }, [loadMarketData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadMarketData, 60_000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadMarketData]);

  async function handleAskAI() {
    if (!question.trim() || asking) return;
    const q = question.trim();
    setQuestion("");
    setHistory((h) => [...h, { role: "user", text: q }]);
    setAsking(true);
    try {
      const result = await askAI(q, candles.slice(-50));
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
          {chartVisible ? (
            <Chart data={candles} />
          ) : (
            <div className="chart-hidden">Chart hidden</div>
          )}
          <div className="status">
            {loading
              ? "Updating..."
              : autoRefresh
                ? "Auto refresh ON (60s)"
                : "Auto refresh OFF"}
          </div>
        </section>

        <aside className="ai-panel">
          <Analysis candles={candles} loading={loading} autoRefresh={autoRefresh} />
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
