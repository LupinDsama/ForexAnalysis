const PERIOD = 14;

function rsiSeries(closes) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < PERIOD + 1) return out;
  for (let i = PERIOD; i < closes.length; i++) {
    let gains = 0;
    let losses = 0;
    for (let j = i - PERIOD + 1; j <= i; j++) {
      const d = closes[j] - closes[j - 1];
      if (d >= 0) gains += d;
      else losses -= d;
    }
    if (losses === 0) {
      out[i] = 100;
    } else {
      const rs = gains / PERIOD / (losses / PERIOD);
      out[i] = Math.round((100 - 100 / (1 + rs)) * 10) / 10;
    }
  }
  return out;
}

export default function RsiPanel({ data, theme = "dark" }) {
  const closes = (data || [])
    .map((c) => Number(c.close))
    .filter((v) => Number.isFinite(v));
  const rsi = rsiSeries(closes);
  const pts = [];
  rsi.forEach((v, i) => {
    if (v == null) return;
    pts.push([i, v]);
  });

  if (pts.length < 2) return null;

  const n = closes.length;
  const X = (i) => (n <= 1 ? 0 : (i / (n - 1)) * 1000);
  const Y = (v) => 100 - Math.max(0, Math.min(100, v));
  const line = pts.map(([i, v]) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1][1];
  const zone = last >= 70 ? "Quá mua" : last <= 30 ? "Quá bán" : "Trung tính";
  const zoneClass = last >= 70 ? "hot" : last <= 30 ? "cold" : "";
  const lineColor = theme === "light" ? "#0a59cc" : "#4d9fff";
  const gridColor = theme === "light" ? "#e5e5ea" : "#243352";

  return (
    <div className="rsi-panel">
      <div className="rsi-head">
        <span>
          RSI {PERIOD}: <strong>{last.toFixed(1)}</strong>
        </span>
        <span className={`rsi-zone ${zoneClass}`}>{zone}</span>
      </div>
      <svg
        className="rsi-svg"
        viewBox="0 0 1000 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`RSI 14 hiện tại ${last.toFixed(1)}`}
      >
        <line x1="0" y1="30" x2="1000" y2="30" stroke="#ef4444" strokeWidth="1" strokeDasharray="5 4" opacity="0.7" />
        <line x1="0" y1="70" x2="1000" y2="70" stroke="#22c55e" strokeWidth="1" strokeDasharray="5 4" opacity="0.7" />
        <line x1="0" y1="50" x2="1000" y2="50" stroke={gridColor} strokeWidth="1" opacity="0.6" />
        <polyline points={line} fill="none" stroke={lineColor} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <circle cx={X(pts[pts.length - 1][0])} cy={Y(last)} r="4" fill={lineColor} />
      </svg>
    </div>
  );
}
