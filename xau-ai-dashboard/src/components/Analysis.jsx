function formatTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

export default function Analysis({ data, timeframes, loading, lastFetch }) {
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
            {changeOf(tf.key)}) · {formatTime(lastFetch?.[tf.key])}
          </p>
        );
      })}
      <p>{loading ? "● Updating" : "On-demand updates"}</p>
      <p className="muted">
        Fetch lúc mở trang / chuyển khung / ⟳ / chat · AI luôn nhận dữ liệu tươi
      </p>
    </div>
  );
}
