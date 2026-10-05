import { useState } from "react";

// 1 lot XAUUSD chuẩn = 100 oz → 1 pip (0.1 giá) = $10.
const USD_PER_PIP_LOT = 10;

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts.replace(" ", "T") + "Z");
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtPips(n) {
  const v = Number(n) || 0;
  return `${v > 0 ? "+" : ""}${v}`;
}

export default function Results({ results, onRefresh }) {
  const [spinning, setSpinning] = useState(false);
  const [lot, setLot] = useState(() => {
    try {
      const v = Number(localStorage.getItem("xau_lot"));
      return Number.isFinite(v) && v > 0 ? v : 0.01;
    } catch {
      return 0.01;
    }
  });
  const list = results?.list || [];
  const won = results?.won || { pips: 0, count: 0 };
  const lost = results?.lost || { pips: 0, count: 0 };
  const net = Number(results?.net) || 0;
  const margin = Number(results?.margin) || 0;

  function changeLot(value) {
    const v = Number(value);
    if (Number.isFinite(v) && v > 0 && v <= 100) {
      setLot(v);
      try {
        localStorage.setItem("xau_lot", String(v));
      } catch {
        // ignore
      }
    }
  }

  const money = (pips) => {
    const v = pips * USD_PER_PIP_LOT * lot;
    return `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
  };

  async function handleRefresh() {
    if (spinning) return;
    setSpinning(true);
    try {
      await onRefresh();
    } finally {
      setSpinning(false);
    }
  }

  return (
    <div className="results">
      <div className="news-head">
        <h2>Kết quả hôm nay</h2>
        <label className="lot-label">
          Lot
          <input
            className="lot-input"
            type="number"
            min="0.01"
            step="0.01"
            value={lot}
            onChange={(e) => changeLot(e.target.value)}
          />
        </label>
        <button onClick={handleRefresh} disabled={spinning} title="Tải lại">
          ⟳
        </button>
      </div>
      <ul className="results-list">
        {list.map((r) => (
          <li key={r.id} className={r.status === "WON" ? "won" : "lost"}>
            <span className="r-time">{fmtTime(r.judged_at)}</span>
            <span className="r-id">#{r.id}</span>
            <span className="r-side">
              {r.style} {r.trend}
            </span>
            <span className="r-route">
              {r.entry} → {r.exit}
            </span>
            <span className={`r-pips ${r.pips >= 0 ? "pos" : "neg"}`}>
              {fmtPips(r.pips)}
            </span>
          </li>
        ))}
        {list.length === 0 && (
          <li className="muted">Chưa có lệnh nào chấm hôm nay</li>
        )}
      </ul>
      <div className="results-total">
        <span>
          Thắng <strong className="pos">{fmtPips(won.pips)}</strong>/{won.count}{" "}
          <span className="muted">({money(won.pips)})</span>
        </span>
        <span>
          Thua <strong className="neg">-{lost.pips}</strong>/{lost.count}{" "}
          <span className="muted">({money(-lost.pips)})</span>
        </span>
        <span>
          Tổng{" "}
          <strong className={net >= 0 ? "pos" : "neg"}>{fmtPips(net)}</strong>{" "}
          <span className="muted">({money(net)})</span>
        </span>
        <span className={`margin ${margin > 0 ? "pos" : margin < 0 ? "neg" : ""}`}>
          Margin {margin >= 0 ? "+" : ""}
          {margin}
        </span>
      </div>
    </div>
  );
}
