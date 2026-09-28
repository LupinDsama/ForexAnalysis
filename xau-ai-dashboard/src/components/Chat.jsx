export default function Chat({
  question,
  setQuestion,
  history,
  asking,
  onSend,
}) {
  return (
    <div className="chat">
      <h2>AI Chat</h2>
      <div className="history">
        {history.length === 0 && <p className="muted">User: ... / AI: ...</p>}
        {history.map((m, i) => (
          <p key={i} className={m.role}>
            <strong>{m.role === "user" ? "User" : "AI"}:</strong> {m.text}
          </p>
        ))}
      </div>
      <div className="chat-box">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask AI about the current XAU/USD data..."
        />
        <button onClick={onSend} disabled={asking}>
          {asking ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
