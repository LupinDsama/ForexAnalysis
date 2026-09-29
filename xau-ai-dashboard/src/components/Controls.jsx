export default function Controls({ chartVisible, quota, onToggleChart }) {
  return (
    <div className="controls">
      <button onClick={onToggleChart}>
        Chart:{chartVisible ? " ON" : " OFF"}
      </button>
      <div className="quota">
        <span>Twelve Data</span>
        <span>
          Requests today: {quota.used}/{quota.limit}
        </span>
        <span>Remaining: {quota.remaining}</span>
        {quota.shouldStop && <span className="warn">Quota reached. Paused</span>}
      </div>
    </div>
  );
}
