import { useEffect, useRef } from "react";
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
  // Fallback: "**Xu hướng**: ..." style lines anywhere in the text.
  const found = {};
  const rest = [];
  for (const line of src.split("\n")) {
    const mm =
      /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(xu hướng|entry|tp\d*|sl|lý do)(?:\*\*)?\s*[:-]\s*(.+?)\s*$/.exec(
        line
      );
    if (mm) {
      const key = /^tp\d*$/.test(mm[1].toLowerCase()) ? "tp" : mm[1].toLowerCase();
      found[key] = (found[key] ? found[key] + " / " : "") + mm[2].replace(/\*\*/g, "").trim();
    } else {
      rest.push(line);
    }
  }
  if (found["xu hướng"] || found["entry"] || found["tp"] || found["sl"]) {
    return { setup: found, body: rest.join("\n").trim() };
  }
  return { setup: null, body: src };
}

function trendClass(trend) {
  const t = (trend || "").toUpperCase();
  if (t.includes("TĂNG") || t.includes("UP") || t.includes("LONG")) return "up";
  if (t.includes("GIẢM") || t.includes("DOWN") || t.includes("SHORT")) return "down";
  return "side";
}

function SetupCard({ setup }) {
  return (
    <div className="setup-card">
      <div className={`setup-trend ${trendClass(setup["xu hướng"])}`}>
        {setup["xu hướng"] || "—"}
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

export default function Chat({
  question,
  setQuestion,
  history,
  asking,
  phase,
  onSend,
}) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history, asking]);

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div className="chat">
      <h2>AI Chat</h2>
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
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Hỏi AI... (Enter để gửi, Shift+Enter xuống dòng)"
        />
        <button onClick={onSend} disabled={asking}>
          {asking ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
