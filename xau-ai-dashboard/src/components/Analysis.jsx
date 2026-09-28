export default function Analysis({ data, timeframes, loading, autoRefresh }) {
  function lastOf(key) {
    const arr = data?.[key] || [];
    return arr[arr.length - 1] || null;
  }

  function changeOf(key) {
    const arr = data?.[key] || [];
    const last = arr[arr.length - 1];
    const prev = arr[arr.length - 2];
    if (!last || !prev) return "—";
    const d = last.close - prev.close;
    return `${d >= 0 ? "+" : ""}${d.toFixed(2)}`;
  }

  return (
    <div className="analysis">
      <h2>AI Analysis</h2>
      {timeframes.map((tf) => {
        const last = lastOf(tf.key);
        return (
          <p key={tf.key}>
            {tf.label}: {last ? last.close.toFixed(2) : "—"} (
            {changeOf(tf.key)})
          </p>
        );
      })}
      <p>
        {loading ? "● Updating" : autoRefresh ? "Auto refresh ON" : "Auto refresh OFF"}
      </p>
      <p className="muted">
        Multi-timeframe 1m / 5m / 1H / 4H · AI sees all four on every question
      </p>
    </div>
  );
}
