import { useState } from "react";

function trendClass(t) {
  if (t === "LONG") return "long";
  if (t === "SHORT") return "short";
  return "side";
}

export default function Orders({ title, items, emptyText, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const list = items || [];

  async function toggle() {
    if (!open) {
      setLoading(true);
      try {
        await onRefresh();
      } finally {
        setLoading(false);
      }
    }
    setOpen((v) => !v);
  }

  return (
    <div className="orders">
      <button className="orders-toggle" onClick={toggle}>
        {title} ({list.length}) {open ? "▾" : "▸"}
      </button>
      {open && (
        <ul className="orders-list">
          {loading && <li className="muted">Đang tải...</li>}
          {!loading && list.length === 0 && (
            <li className="muted">{emptyText}</li>
          )}
          {list.map((o) => (
            <li key={o.id}>
              <strong className={trendClass(o.trend)}>
                #{o.id} {o.style} {o.trend}
              </strong>
              <div>
                E {o.entry} · TP {o.tp} · SL {o.sl}
              </div>
              <div className="muted">{o.created_at}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
