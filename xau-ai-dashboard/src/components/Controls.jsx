export default function Controls({
  chartVisible,
  autoRefresh,
  quota,
  onToggleChart,
  onToggleRefresh,
}) {
  return (
    <div className="controls">
      <button onClick={onToggleChart}>
        Chart:{chartVisible ? " ON" : " OFF"}
      </button>
      <button onClick={onToggleRefresh}>
        Auto Refresh:{autoRefresh ? " ON" : " OFF"}
      </button>
      <div className="quota">
        <span>Twelve Data</span>
        <span>
          Requests today: {quota.used}/{quota.limit}
        </span>
        <span>Remaining: {quota.remaining}</span>
        {quota.shouldStop && <span className="warn">Near quota — auto stopped</span>}
      </div>
    </div>
  );
}
