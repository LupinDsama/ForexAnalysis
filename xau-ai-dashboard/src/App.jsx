import { useCallback, useEffect, useRef, useState } from "react";
import Chart from "./components/Chart";
import RsiPanel from "./components/RsiPanel";
import Controls from "./components/Controls";
import Analysis from "./components/Analysis";
import Chat from "./components/Chat";
import Memory from "./components/Memory";
import News from "./components/News";
import Orders from "./components/Orders";
import Results from "./components/Results";
import {
  getXAUUSD,
  askAI,
  convertCandles,
  getQuotaInfo,
  incRequestCount,
  getStorage,
  getNews,
  getLive,
  touchLive,
  isTradingTime,
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

// Normal chat: 1m (current price) + higher TFs. Super Boost: all six, deep.
const NORMAL_TFS = ["1m", "5m", "1h", "4h"];

// Candle length in seconds per timeframe, for live tick aggregation.
const TF_BOUNDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1D": 86400 };

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleTimeString();
}

function describeActions(actions) {
  if (!Array.isArray(actions) || !actions.length) return null;
  const parts = [];
  for (const a of actions) {
    if (a.cmd === "open") {
      parts.push(
        a.id != null
          ? `Đã mở lệnh #${a.id} (${a.trend}, ${a.status})`
          : "Lệnh mở bị từ chối (số không hợp lệ)"
      );
    } else if (a.cmd === "close") {
      parts.push(
        a.result === "closed"
          ? `Đã đóng lệnh #${a.id}`
          : `Lệnh #${a.id} không mở nên không đóng được`
      );
    } else if (a.cmd === "activate") {
      parts.push(
        a.result === "opened"
          ? `Đã đưa lệnh chờ #${a.id} sang mở`
          : `Lệnh #${a.id} không phải chờ nên không kích hoạt được`
      );
    } else if (a.cmd === "delete") {
      parts.push(
        a.result === "deleted"
          ? `Đã xóa lệnh chờ #${a.id}`
          : `Lệnh #${a.id} không phải chờ nên không xóa được`
      );
    }
  }
  return parts.length ? parts.join(" · ") : null;
}

function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  const [liveOn, setLiveOn] = useState(true);
  const [liveStatus, setLiveStatus] = useState("off");
  const [liveTick, setLiveTick] = useState(null);
  const [showOrders, setShowOrders] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [nextLiveAt, setNextLiveAt] = useState(null);
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
  // Forming live candle per TF + last Twelve history candle (seed/guard).
  const liveRef = useRef({});
  const lastHistRef = useRef({});
  // Monotonic clock for live staleness (wall clock may be wrong).
  const lastTickPerf = useRef(0);

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
      if (candles.length) {
        const last = candles[candles.length - 1];
        lastHistRef.current[tf.key] = { time: last.time, close: last.close };
        // Fresh history replaces any forming live candle.
        delete liveRef.current[tf.key];
      }
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

  // 1s ticker for the live countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Live ticks (Yahoo COMEX via Worker, free, no Twelve quota).
  // Ticks fold into a forming candle per timeframe; the visible chart
  // updates in place. Twelve history still seeds every timeframe.
  useEffect(() => {
    if (!liveOn) {
      setLiveStatus("off");
      return;
    }
    let stop = false;
    setLiveStatus("connecting");
    setNextLiveAt(Date.now() + 30_000);

    function onTick(price, timeMs, source) {
      if (stop || !Number.isFinite(price)) return;
      lastTickPerf.current = performance.now();
      const tickSec = Math.floor((timeMs || Date.now()) / 1000);
      // No weekend candles: market is closed, ticks would paint flat bars.
      if (!isTradingTime(tickSec)) {
        setLiveTick({ price, time: timeMs || Date.now(), source: source || "", halted: true });
        return;
      }
      setLiveTick({ price, time: timeMs || Date.now(), source: source || "" });
      for (const tf of TIMEFRAMES) {
        const bound = TF_BOUNDS[tf.key];
        if (!bound) continue;
        const start = Math.floor(tickSec / bound) * bound;
        const cur = liveRef.current[tf.key];
        if (!cur || tickSec >= cur.start + bound) {
          const seed =
            cur?.close ??
            lastHistRef.current[tf.key]?.close ??
            price;
          liveRef.current[tf.key] = {
            start,
            time: start,
            open: seed,
            high: Math.max(seed, price),
            low: Math.min(seed, price),
            close: price,
          };
        } else {
          cur.high = Math.max(cur.high, price);
          cur.low = Math.min(cur.low, price);
          cur.close = price;
        }
        if (tf.key === activeTF && chartVisible) {
          const live = liveRef.current[tf.key];
          const histT = lastHistRef.current[tf.key]?.time || 0;
          if (live.time >= histT) {
            chartRef.current?.updateLive?.({
              time: live.time,
              open: live.open,
              high: live.high,
              low: live.low,
              close: live.close,
            });
          }
        }
      }
    }

    async function poll() {
      if (stop) return;
      try {
        const r = await getLive();
        if (!stop && Number.isFinite(r.price)) {
          setLiveStatus("live");
          onTick(r.price, r.time, r.source);
          // Pending touch-check on every tick (no Twelve credits).
          try {
            const t = await touchLive(r.price, r.time);
            if (!stop && t.activated?.length) {
              refreshStorage();
              setHistory((h) => [
                ...h,
                {
                  role: "system",
                  text: `Lệnh chờ ${t.activated.map((id) => `#${id}`).join(", ")} đã kích hoạt thành lệnh mở`,
                },
              ]);
            }
          } catch {
            // touch-check never breaks the live feed
          }
        }
      } catch {
        if (!stop) setLiveStatus("error");
      } finally {
        if (!stop) setNextLiveAt(Date.now() + 30_000);
      }
    }

    poll();
    const timer = setInterval(poll, 30_000);
    return () => {
      stop = true;
      clearInterval(timer);
      setLiveStatus("off");
    };
  }, [liveOn, activeTF, chartVisible]);

  function handleSwitchTF(key) {
    setActiveTF(key);
  }

  function buildMarketContext(dataObj, deep, focus) {
    const timeframes = {};
    for (const tf of TIMEFRAMES) {
      if (!deep && !NORMAL_TFS.includes(tf.key)) continue;
      const arr = dataObj[tf.key] || [];
      const last = arr[arr.length - 1];
      const prev = arr[arr.length - 2];
      const n = deep ? (tf.key === focus ? 60 : 30) : tf.key === focus ? 30 : 10;
      timeframes[tf.key] = {
        count: arr.length,
        last: last?.close ?? null,
        change: last && prev ? +(last.close - prev.close).toFixed(2) : null,
        candles: arr.slice(-n),
      };
    }
    return { active: focus, boost: deep, timeframes };
  }

  // @1H-style mention focuses that timeframe's depth for this question.
  function focusTF(prompt) {
    const m = /@(1m|5m|15m|1h|4h|1d)\b/i.exec(prompt || "");
    if (!m) return activeTF;
    const l = m[1].toLowerCase();
    return l === "1d" ? "1D" : l;
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
      const result = await askAI(q, buildMarketContext(current, boost, focusTF(q)), boost);
      const text =
        result?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "AI returned no response.";
      const sys = describeActions(result?.actions);
      setHistory((h) => {
        // Keep screenshots only on recent messages to bound memory.
        const pruned = h.map((m, idx) =>
          m.shot && idx < h.length - 4 ? { ...m, shot: null } : m
        );
        const next = [
          ...pruned,
          {
            role: "ai",
            text,
            shot,
            setupStatus: result?.setup_status || null,
            setupId: result?.setup_id || null,
          },
        ];
        if (sys) next.push({ role: "system", text: sys });
        return next;
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

  // Markers for open + judged setups, snapped to active series candles.
  function buildMarkers() {
    if (!showOrders) return [];
    const series = activeData;
    if (!series.length) return [];
    const bound = TF_BOUNDS[activeTF] || 60;
    const snap = (ts) => {
      let best = null;
      let bestDiff = bound * 1.5;
      for (const c of series) {
        const d = Math.abs(c.time - ts);
        if (d < bestDiff) {
          bestDiff = d;
          best = c.time;
        }
      }
      return best;
    };
    const out = [];
    for (const o of storage?.open_setups || []) {
      const t = snap(o.created_ts || Date.parse(o.created_at) / 1000);
      if (t == null) continue;
      if (o.trend === "SHORT") {
        out.push({ time: t, position: "aboveBar", color: "#1d4ed8", shape: "arrowDown", text: "E" });
      } else if (o.trend === "LONG") {
        out.push({ time: t, position: "belowBar", color: "#1d4ed8", shape: "arrowUp", text: "E" });
      } else {
        out.push({ time: t, position: "belowBar", color: "#1d4ed8", shape: "circle", text: "E" });
      }
    }
    for (const o of storage?.pending_setups || []) {
      const t = snap(o.created_ts || Date.parse(o.created_at) / 1000);
      if (t == null) continue;
      out.push({ time: t, position: "aboveBar", color: "#8e8e93", shape: "circle", text: "P" });
    }
    for (const o of storage?.judged_setups || []) {
      const t = snap(o.created_ts || Date.parse(o.created_at) / 1000);
      if (t == null) continue;
      if (o.status === "WON") {
        out.push({ time: t, position: "belowBar", color: "#22c55e", shape: "circle", text: "TP" });
      } else if (o.status === "LOST") {
        out.push({ time: t, position: "aboveBar", color: "#ef4444", shape: "circle", text: "SL" });
      }
    }
    return out;
  }

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
            <button
              className={showOrders ? "refresh-one orders-on" : "refresh-one"}
              onClick={() => setShowOrders((v) => !v)}
              title="Hiện lệnh mở + thắng/thua lên chart"
            >
              Lệnh
            </button>
          </div>

          {chartVisible ? (
            activeData.length || updating[activeTF] ? (
              <>
                <Chart
                  key={activeTF + theme}
                  ref={chartRef}
                  data={activeData}
                  markers={buildMarkers()}
                  theme={theme}
                />
                <RsiPanel data={activeData} theme={theme} />
              </>
            ) : (
              <div className="chart-empty">
                Chưa có dữ liệu khung {activeTFConf.label}. Bấm ⟳ để tải
              </div>
            )
          ) : (
            <div className="chart-hidden">Chart hidden</div>
          )}
          <div className="status status-row">
            <span>
              {updating[activeTF]
                ? "Đang tải..."
                : `Cập nhật lúc ${formatTime(lastFetch[activeTF])} (${activeTFConf.label}) · on-demand`}
            </span>
            <span className="live-wrap">
              {liveStatus === "live" && liveTick ? (
                <span className="live-on">
                  {liveTick.halted ? (
                    <>Thị trường nghỉ cuối tuần</>
                  ) : (
                    <>
                      ● LIVE {liveTick.price} {liveTick.source || ""}
                      {nextLiveAt
                        ? ` (${formatCountdown(nextLiveAt - now)})`
                        : ""}
                      {performance.now() - lastTickPerf.current > 600_000
                        ? " (giá cũ)"
                        : ""}
                    </>
                  )}
                </span>
              ) : liveStatus === "connecting" ? (
                <span className="muted">Đang nối live...</span>
              ) : liveStatus === "error" ? (
                <span className="muted">Live lỗi, dùng dữ liệu Twelve</span>
              ) : null}
              <button
                className={liveOn ? "live-toggle on" : "live-toggle"}
                onClick={() => setLiveOn((v) => !v)}
                title="Bật/tắt giá live (Yahoo COMEX, không tốn quota)"
              >
                Live {liveOn ? "ON" : "OFF"}
              </button>
            </span>
          </div>
        </section>

        <aside className="ai-panel">
          <Orders
            title="Lệnh đang mở"
            items={storage?.open_setups}
            emptyText="Không có lệnh mở"
            onRefresh={refreshStorage}
          />
          <Orders
            title="Lệnh chờ"
            items={storage?.pending_setups}
            emptyText="Không có lệnh chờ"
            onRefresh={refreshStorage}
          />
          <Orders
            title="Đã đóng/hủy"
            items={storage?.closed_setups}
            emptyText="Chưa có lệnh đóng/hủy"
            onRefresh={refreshStorage}
          />
          <Results results={storage?.results} onRefresh={refreshStorage} />
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
