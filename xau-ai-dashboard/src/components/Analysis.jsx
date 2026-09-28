export default function Analysis({ candles, loading, autoRefresh }) {
  const last = candles?.length ? candles[candles.length - 1] : null;
  const prev = candles?.length > 1 ? candles[candles.length - 2] : null;
  const change = last && prev ? (last.close - prev.close).toFixed(2) : "—";

  return (
    <div className="analysis">
      <h2>AI Analysis</h2>
      <p>XAU/USD: {last ? last.close.toFixed(2) : "3xxx.xx"} · 1m</p>
      <p>
        {loading ? "● Updating" : autoRefresh ? "Auto refresh ON" : "Auto refresh OFF"}
      </p>
      <p>Last change: {change}</p>
      <p className="muted">
        Current market data · Structure · Indicators (Phase 2 will expand)
      </p>
    </div>
  );
}
