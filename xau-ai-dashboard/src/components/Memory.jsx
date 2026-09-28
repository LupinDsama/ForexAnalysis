import { useState } from "react";

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v < 10 && u > 0 ? 1 : 0)} ${units[u]}`;
}

export default function Memory({ storage, onSave }) {
  const [kind, setKind] = useState("rule");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const used = storage?.used_bytes || 0;
  const limit = storage?.limit_bytes || 1;
  const pct = Math.min(100, (used / limit) * 100);
  const tables = storage?.tables || {};
  const recent = storage?.recent || [];

  async function handleSave() {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(kind, text.trim());
      setText("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="memory">
      <h2>Bộ nhớ D1</h2>
      <div className="storage-line">
        <span>
          Kho lưu trữ: {formatBytes(used)} / {formatBytes(limit)}
        </span>
        <span className="muted">
          ({pct < 0.01 && used > 0 ? "<0.01" : pct.toFixed(2)}%)
        </span>
      </div>
      <div className="storage-bar">
        <div className="fill" style={{ width: `${Math.max(pct, 0.5)}%` }} />
      </div>
      <p className="muted">
        Phân tích: {tables.memories ?? "—"} · Snapshot nến:{" "}
        {tables.snapshots ?? "—"} · Mỗi câu chat tự nạp context cũ + lưu lại
      </p>

      <div className="memory-form">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="rule">Quy tắc</option>
          <option value="note">Ghi chú</option>
        </select>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="VD: Chỉ vào lệnh khi RSI khung 15m đồng pha xu hướng 1h..."
        />
        <button onClick={handleSave} disabled={saving || !text.trim()}>
          {saving ? "..." : "Lưu"}
        </button>
      </div>

      {recent.length > 0 && (
        <ul className="memory-list">
          {recent.slice(0, 5).map((m) => (
            <li key={m.id}>
              <strong>[{m.kind}]</strong> {m.snippet}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
