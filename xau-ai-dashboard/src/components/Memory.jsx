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

export default function Memory({ storage, onSave, onClean }) {
  const [kind, setKind] = useState("rule");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [showGate, setShowGate] = useState(false);
  const [password, setPassword] = useState("");
  const [gateError, setGateError] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState(null);

  const used = storage?.used_bytes || 0;
  const limit = storage?.limit_bytes || 1;
  const pct = Math.min(100, (used / limit) * 100);
  const tables = storage?.tables || {};
  const recent = storage?.recent || [];
  const setups = tables.setups || {};
  const scores = storage?.scores || [];

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

  async function handleClean() {
    if (cleaning) return;
    setCleaning(true);
    setGateError("");
    try {
      const res = await onClean(password);
      setCleanResult(res.stats || null);
      setShowGate(false);
      setPassword("");
    } catch (e) {
      setGateError(e.message);
    } finally {
      setCleaning(false);
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
        Phân tích: {tables.memories ?? "-"} · Snapshot nến:{" "}
        {tables.snapshots ?? "-"}
      </p>
      <p className="muted">
        Setup: {setups.OPEN ?? 0} mở, {setups.WON ?? 0} thắng,{" "}
        {setups.LOST ?? 0} thua
      </p>
      {scores.length > 0 && (
        <p className="muted">
          Điểm pattern:{" "}
          {scores.map((s) => `${s.pattern} ${s.score >= 0 ? "+" : ""}${s.score}`).join(" · ")}
        </p>
      )}
      <p className="muted">
        Chỉ lưu điều quan trọng: setup có Entry/TP/SL, bài học [phân tích],
        quy tắc tay. Chat xã giao không lưu.
      </p>

      <button className="clean-btn" onClick={() => { setShowGate(true); setCleanResult(null); }}>
        Lọc và dọn kho
      </button>

      {cleanResult && (
        <p className="muted">
          Đã dọn: {cleanResult.memories_deleted} phân tích cũ,{" "}
          {cleanResult.snapshots_deleted} snapshot cũ,{" "}
          {cleanResult.snapshots_trimmed} snapshot nén gọn,{" "}
          {cleanResult.setups_deleted} setup cũ. Dung lượng{" "}
          {formatBytes(cleanResult.bytes_before)} còn{" "}
          {formatBytes(cleanResult.bytes_after)}.
        </p>
      )}

      {showGate && (
        <div className="gate-overlay" onClick={() => setShowGate(false)}>
          <div className="gate-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Xác nhận dọn kho</h3>
            <p className="muted">
              Nhập mật khẩu để nén thành tri thức và xóa dữ liệu không quan
              trọng. Quy tắc, ghi chú, bài học và setup đang mở không bao
              giờ bị xóa.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleClean();
              }}
              placeholder="Mật khẩu"
              autoFocus
            />
            {gateError && <p className="gate-error">{gateError}</p>}
            <div className="gate-actions">
              <button onClick={() => setShowGate(false)}>Hủy</button>
              <button
                className="danger"
                onClick={handleClean}
                disabled={cleaning || !password}
              >
                {cleaning ? "Đang dọn..." : "Bắt đầu dọn"}
              </button>
            </div>
          </div>
        </div>
      )}

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
