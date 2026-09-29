import { useState } from "react";

export default function News({ news, onRefresh }) {
  const [spinning, setSpinning] = useState(false);
  const events = news?.events || [];

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
    <div className="news">
      <div className="news-head">
        <h2>Tin vĩ mô</h2>
        <button onClick={handleRefresh} disabled={spinning} title="Tải lại tin">
          ⟳
        </button>
      </div>
      <p className="muted">
        ForexFactory · cập nhật{" "}
        {news?.updated_at
          ? new Date(news.updated_at).toLocaleString()
          : "-"}
      </p>
      <ul className="news-list">
        {events.slice(0, 10).map((e, i) => (
          <li key={i}>
            <span className={`impact ${e.impact.toLowerCase()}`}>
              {e.impact}
            </span>
            <div>
              <strong>{e.title}</strong>
              <div className="muted">
                {e.date} {e.time} · F:{e.forecast || "-"} P:
                {e.previous || "-"}
              </div>
            </div>
          </li>
        ))}
        {events.length === 0 && (
          <li className="muted">Chưa có tin. Bấm ⟳ để tải</li>
        )}
      </ul>
      <a
        href="https://www.forexfactory.com/market/goldusd"
        target="_blank"
        rel="noreferrer"
      >
        Mở ForexFactory Gold/USD ↗
      </a>
    </div>
  );
}
