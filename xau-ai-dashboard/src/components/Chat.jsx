import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function parseSetup(text) {
  const src = text || "";
  const m = /```setup([\s\S]*?)```/.exec(src);
  if (m) {
    const setup = {};
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) {
        setup[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
    }
    if (setup["xu hướng"] || setup["entry"] || setup["tp"] || setup["sl"]) {
      return { setup, body: src.replace(m[0], "").trim() };
    }
  }
  // Fallback: "**Entry:** ...", "- Entry: ...", "1. TP: ..." etc.
  const found = {};
  const rest = [];
  const KEYMAP = {
    "xu hướng": "xu hướng",
    entry: "entry",
    "điểm vào": "entry",
    "vào lệnh": "entry",
    tp: "tp",
    "chốt lời": "tp",
    sl: "sl",
    "cắt lỗ": "sl",
    "lý do": "lý do",
    "kiểu": "kiểu",
    scalp: "scalp",
    swing: "swing",
    "lệnh chờ": "lệnh chờ",
    "lệnh": "lệnh chờ",
    rr: "rr",
  };
  for (const line of src.split("\n")) {
    const mm =
      /^\s*(?:[-*•]\s*)?(?:\d+[.)]\s*)?(?:\*\*)?\s*(xu hướng|entry|điểm vào|vào lệnh|tp\d*|chốt lời|sl|cắt lỗ|lý do|kiểu|scalp|swing|lệnh chờ|lệnh|rr)(?:\*\*)?\s*[:\-–—]\s*(.+?)\s*$/.exec(
        line
      );
    if (mm) {
      const raw = mm[1].toLowerCase();
      const key = /^tp\d*$/.test(raw) ? "tp" : KEYMAP[raw] || raw;
      const val = mm[2].replace(/\*\*/g, "").trim();
      if (val && val !== "—") {
        found[key] = (found[key] ? found[key] + " / " : "") + val;
      }
    } else {
      rest.push(line);
    }
  }
  if (found["xu hướng"] || found["entry"] || found["tp"] || found["sl"]) {
    return { setup: found, body: rest.join("\n").trim() };
  }
  return { setup: null, body: src };
}

function cleanTrend(trend) {
  const t = (trend || "").trim();
  if (!t || t === "—" || t.includes("|")) return "—";
  return t;
}

function trendClass(trend) {
  const t = cleanTrend(trend).toUpperCase();
  if (t === "—") return "side";
  if (t.includes("TĂNG") || t.includes("UP") || t.includes("LONG")) return "up";
  if (t.includes("GIẢM") || t.includes("DOWN") || t.includes("SHORT")) return "down";
  return "side";
}

function SetupCard({ setup }) {
  const trend = cleanTrend(setup["xu hướng"]);
  const extra = [
    ["Kiểu", setup["kiểu"]],
    ["RR", setup["rr"]],
    ["Lệnh chờ", setup["lệnh chờ"]],
    ["Scalp", setup["scalp"]],
    ["Swing", setup["swing"]],
  ].filter(([, v]) => v);
  return (
    <div className="setup-card">
      <div className={`setup-trend ${trendClass(trend)}`}>
        {trend}
      </div>
      <div className="setup-rows">
        <div>
          <span>Entry</span>
          <strong>{setup["entry"] || "—"}</strong>
        </div>
        <div>
          <span>TP</span>
          <strong className="tp">{setup["tp"] || "—"}</strong>
        </div>
        <div>
          <span>SL</span>
          <strong className="sl">{setup["sl"] || "—"}</strong>
        </div>
        {extra.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {setup["lý do"] && <p className="setup-reason">{setup["lý do"]}</p>}
    </div>
  );
}

function AiMessage({ msg }) {
  const { setup, body } = parseSetup(msg.text);
  return (
    <div className="msg ai">
      {msg.shot && (
        <a href={msg.shot} target="_blank" rel="noreferrer">
          <img
            className="msg-shot"
            src={msg.shot}
            alt="Chart tại thời điểm phân tích"
          />
        </a>
      )}
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </div>
      {setup && <SetupCard setup={setup} />}
    </div>
  );
}

const MENTIONS = [
  { key: "1m", label: "1m", hint: "khung 1 phút", insert: "@1m " },
  { key: "5m", label: "5m", hint: "khung 5 phút", insert: "@5m " },
  { key: "15m", label: "15m", hint: "khung 15 phút", insert: "@15m " },
  { key: "1h", label: "1H", hint: "khung 1 giờ", insert: "@1H " },
  { key: "4h", label: "4H", hint: "khung 4 giờ", insert: "@4H " },
  { key: "1d", label: "1D", hint: "khung ngày", insert: "@1D " },
  { key: "phan-tich", label: "[phân tích]", hint: "lưu thành bài học", insert: "[phân tích] " },
];

export default function Chat({
  question,
  setQuestion,
  history,
  asking,
  phase,
  boost,
  onToggleBoost,
  onSend,
}) {
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const [mentionQuery, setMentionQuery] = useState(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history, asking]);

  function updateMention(value, caret) {
    const before = value.slice(0, caret);
    const m = /@([a-zA-Z0-9à-ỹÀ-Ỹ-]*)$/.exec(before);
    setMentionQuery(m ? m[1] : null);
  }

  const mentionMatches =
    mentionQuery == null
      ? []
      : MENTIONS.filter((x) =>
          x.label.toLowerCase().includes(mentionQuery.toLowerCase())
        );

  function pickMention(item) {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? question.length;
    const before = question.slice(0, caret).replace(/@[a-zA-Z0-9à-ỹÀ-Ỹ-]*$/, item.insert);
    const next = before + question.slice(caret);
    setQuestion(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = before.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  function handleKey(e) {
    if (mentionQuery != null && mentionMatches.length) {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionMatches[0]);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      setMentionQuery(null);
      onSend();
    }
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <h2>AI Chat</h2>
        <button
          className={boost ? "boost on" : "boost"}
          onClick={onToggleBoost}
          title="Super Boost: lấy tươi cả 5 khung, phân tích sâu (tốn ~5 requests)"
        >
          Super Boost
        </button>
      </div>
      <div className="history">
        {history.length === 0 && <p className="muted">Hỏi AI về dữ liệu XAU/USD hiện tại...</p>}
        {history.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg user">
              {m.text}
            </div>
          ) : (
            <AiMessage key={i} msg={m} />
          )
        )}
        {asking && (
          <div className="msg ai waiting">
            <div className="wait-text">
              {phase === "fetch"
                ? "Đang lấy dữ liệu mới từ Twelve Data…"
                : "AI đang phân tích…"}
            </div>
            <div className="shimmer">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="chat-box">
        <div className="chat-input-wrap">
          <textarea
            ref={inputRef}
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={handleKey}
            onClick={(e) => updateMention(question, e.target.selectionStart)}
            placeholder="Hỏi AI... (@ khung giờ, [phân tích] để lưu bài học)"
          />
          {mentionQuery != null && mentionMatches.length > 0 && (
            <ul className="mention-popup">
              {mentionMatches.map((m) => (
                <li key={m.key} onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}>
                  <strong>{m.label}</strong>
                  <span className="muted"> {m.hint}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button onClick={onSend} disabled={asking}>
          {asking ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
