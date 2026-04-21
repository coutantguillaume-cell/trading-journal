import { useState, useEffect, useRef } from "react";

const fmtMoney = (n) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", signDisplay: "always" }).format(n);

const calcStats = (trades) => {
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const winners = trades.filter(t => t.pnl > 5);
  const losers = trades.filter(t => t.pnl < -5);
  const decisive = trades.filter(t => Math.abs(t.pnl) > 5);
  const winRate = decisive.length ? (winners.length / decisive.length * 100).toFixed(1) : "—";
  const avgWin = winners.length ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0;
  const avgLoss = losers.length ? losers.reduce((s, t) => s + t.pnl, 0) / losers.length : 0;
  const pf = avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : "∞";
  const best = trades.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null);
  const worst = trades.reduce((w, t) => (!w || t.pnl < w.pnl ? t : w), null);
  const longs = trades.filter(t => t.direction === "long");
  const shorts = trades.filter(t => t.direction === "short");
  const be = trades.filter(t => Math.abs(t.pnl) <= 5);
  return {
    total, winners, losers, winRate, pf, best, worst, longs, shorts, be,
    longPnl: longs.reduce((s, t) => s + t.pnl, 0),
    shortPnl: shorts.reduce((s, t) => s + t.pnl, 0),
    longWr: longs.length ? Math.round(longs.filter(t => t.pnl > 0).length / longs.length * 100) : 0,
    shortWr: shorts.length ? Math.round(shorts.filter(t => t.pnl > 0).length / shorts.length * 100) : 0,
  };
};

const SUGGESTIONS = [
  "Analyse mes performances globales",
  "Quel est mon meilleur compte ?",
  "Quels sont mes points faibles ?",
  "Que penses-tu de mon profit factor ?",
];

export default function JarvisAssistant({ trades, accountStatuses, accountPayouts, accountChallenges, accountSizes, accountTypes }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const k = localStorage.getItem("jarvis-api-key");
    if (k) setApiKey(k);
  }, []);

  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [messages, open]);

  const saveKey = () => {
    const trimmed = keyInput.trim();
    if (trimmed) {
      localStorage.setItem("jarvis-api-key", trimmed);
      setApiKey(trimmed);
    }
    setShowKey(false);
    setKeyInput("");
  };

  const deleteKey = () => {
    localStorage.removeItem("jarvis-api-key");
    setApiKey("");
    setKeyInput("");
  };

  const buildContext = () => {
    if (!trades.length) return "Aucune donnée de trading disponible dans le journal.";

    const stats = calcStats(trades);
    const accounts = [...new Set(trades.map(t => t.account))];

    const accountStats = accounts.map(acc => {
      const accTrades = trades.filter(t => t.account === acc);
      const s = calcStats(accTrades);
      const status = accountStatuses?.[acc] || "en cours";
      const size = accountSizes?.[acc] || "inconnu";
      const type = accountTypes?.[acc] || "inconnu";
      const payoutsArr = accountPayouts?.[acc] || [];
      const challengesArr = accountChallenges?.[acc] || [];
      const totalPayout = Array.isArray(payoutsArr) ? payoutsArr.reduce((a, b) => a + b, 0) : 0;
      const totalChallenge = Array.isArray(challengesArr) ? challengesArr.reduce((a, b) => a + b, 0) : 0;
      return `  ${acc}: ${accTrades.length} trades | P&L: ${fmtMoney(s.total)} | WR: ${s.winRate}% | PF: ${s.pf} | Statut: ${status} | Taille: ${size} | Type: ${type} | Payouts reçus: ${fmtMoney(totalPayout)} | Coûts challenges: ${fmtMoney(totalChallenge)}`;
    }).join("\n");

    const byMonth = {};
    trades.forEach(t => {
      if (!t.date) return;
      const parts = t.date.split("/");
      if (parts.length < 3) return;
      const key = `${parts[2]}-${parts[0]}`;
      if (!byMonth[key]) byMonth[key] = { pnl: 0, count: 0, wins: 0 };
      byMonth[key].pnl += t.pnl;
      byMonth[key].count++;
      if (t.pnl > 5) byMonth[key].wins++;
    });
    const monthlyStr = Object.entries(byMonth)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 6)
      .map(([k, v]) => `  ${k}: ${fmtMoney(v.pnl)} (${v.count} trades, WR: ${v.count ? Math.round(v.wins / v.count * 100) : 0}%)`)
      .join("\n");

    const recent = [...trades]
      .sort((a, b) => (b.soldAt || "").localeCompare(a.soldAt || ""))
      .slice(0, 15)
      .map(t => `  ${t.date} | ${t.symbol} ${t.direction?.toUpperCase()} x${t.lot} | ${fmtMoney(t.pnl)} | ${t.category || "—"} | durée: ${t.duration || "—"}`)
      .join("\n");

    return `CONTEXTE DU JOURNAL DE TRADING (${new Date().toLocaleDateString("fr-FR")}):

STATISTIQUES GLOBALES:
- Trades totaux: ${trades.length}
- P&L total: ${fmtMoney(stats.total)}
- Taux de réussite: ${stats.winRate}%
- Profit factor: ${stats.pf}
- Gagnants: ${stats.winners.length} | Perdants: ${stats.losers.length} | Break-even: ${stats.be.length}
- Meilleur trade: ${stats.best ? fmtMoney(stats.best.pnl) + " (" + stats.best.symbol + ", " + stats.best.date + ")" : "N/A"}
- Pire trade: ${stats.worst ? fmtMoney(stats.worst.pnl) + " (" + stats.worst.symbol + ", " + stats.worst.date + ")" : "N/A"}
- P&L Long: ${fmtMoney(stats.longPnl)} (WR: ${stats.longWr}%)
- P&L Short: ${fmtMoney(stats.shortPnl)} (WR: ${stats.shortWr}%)

COMPTES (${accounts.length}):
${accountStats}

P&L MENSUEL (6 derniers mois):
${monthlyStr}

15 DERNIERS TRADES:
${recent}`;
  };

  const send = async (override) => {
    const text = (override !== undefined ? override : input).trim();
    if (!text || loading || !apiKey) return;
    setInput("");

    const newMessages = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setLoading(true);

    try {
      const context = buildContext();
      const systemPrompt = `Tu es J.A.R.V.I.S. (Just A Rather Very Intelligent System), un assistant IA de trading de haut niveau intégré dans un journal de trading de futures professionnels. Tu analyses les performances avec précision et fournis des insights actionnables et percutants.

${context}

Directives de comportement:
- Réponds toujours en français
- Sois concis, direct et axé sur les données
- Utilise les métriques de trading correctement (P&L, win rate, profit factor, expectancy, ratio risque/récompense)
- Identifie les patterns, forces et faiblesses dans les données
- Donne des recommandations spécifiques et actionnables
- Adopte un ton sophistiqué et légèrement formel, comme le vrai JARVIS d'Iron Man
- Formate clairement les montants en devise
- Si tu détectes des comportements dangereux (revenge trading, surtrading, mauvaise gestion du risque), signale-les clairement
- Commence parfois tes réponses par "Monsieur," ou "Bien sûr," pour rester dans le personnage`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: systemPrompt,
          messages: newMessages,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Erreur HTTP ${res.status}`);
      }

      const data = await res.json();
      setMessages(prev => [...prev, { role: "assistant", content: data.content[0]?.text || "" }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `⚠ Erreur système : ${err.message}`,
        error: true,
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* ── Floating trigger button ────────────────────────── */}
      <button
        onClick={() => setOpen(o => !o)}
        title="J.A.R.V.I.S. — Assistant Trading"
        style={{
          position: "fixed",
          bottom: 28,
          right: 28,
          width: 58,
          height: 58,
          borderRadius: "50%",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          zIndex: 9999,
          padding: 0,
        }}
      >
        <div style={{
          width: 58,
          height: 58,
          borderRadius: "50%",
          background: open
            ? "radial-gradient(circle at 40% 35%, #40e0ff 0%, #0090e0 35%, #003868 70%, #000a14 100%)"
            : "radial-gradient(circle at 40% 35%, #18b8e8 0%, #0070b0 35%, #002848 70%, #000810 100%)",
          boxShadow: open
            ? "0 0 0 2px rgba(0,200,255,0.5), 0 0 18px rgba(0,200,255,0.7), 0 0 40px rgba(0,150,255,0.4)"
            : "0 0 0 1px rgba(0,180,255,0.25), 0 0 10px rgba(0,150,255,0.3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 0.35s ease",
          position: "relative",
          overflow: "hidden",
        }}>
          {/* spinning outer ring */}
          <div style={{
            position: "absolute",
            inset: 3,
            borderRadius: "50%",
            border: "1px dashed rgba(0,220,255,0.45)",
            animation: "jarvisRotate 8s linear infinite",
          }} />
          {/* static middle ring */}
          <div style={{
            position: "absolute",
            inset: 10,
            borderRadius: "50%",
            border: "1px solid rgba(0,200,255,0.3)",
          }} />
          {/* core */}
          <div style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "radial-gradient(circle, #fff 0%, #80e8ff 40%, #00a8e8 100%)",
            boxShadow: "0 0 8px #0df, 0 0 16px rgba(0,200,255,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1,
          }}>
            {open
              ? <span style={{ fontSize: 11, fontWeight: 900, color: "#003860", lineHeight: 1 }}>✕</span>
              : <span style={{ fontSize: 8, fontWeight: 800, color: "#003860", letterSpacing: 0.5, lineHeight: 1 }}>AI</span>
            }
          </div>
        </div>
      </button>

      {/* ── Chat panel ─────────────────────────────────────── */}
      {open && (
        <div
          style={{
            position: "fixed",
            bottom: 100,
            right: 28,
            width: 390,
            height: 580,
            background: "#030d1a",
            border: "1px solid rgba(0,200,255,0.18)",
            borderRadius: 18,
            boxShadow: "0 0 0 1px rgba(0,100,200,0.08), 0 0 50px rgba(0,130,255,0.12), 0 24px 64px rgba(0,0,0,0.85)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: 9998,
            animation: "jarvisOpen 0.25s cubic-bezier(0.34,1.56,0.64,1)",
          }}
          onClick={e => e.stopPropagation()}
        >
          {/* scanline overlay */}
          <div style={{
            position: "absolute",
            inset: 0,
            backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,180,255,0.012) 2px, rgba(0,180,255,0.012) 4px)",
            pointerEvents: "none",
            zIndex: 0,
            borderRadius: 18,
          }} />

          {/* ── Header ── */}
          <div style={{
            padding: "14px 18px 12px",
            borderBottom: "1px solid rgba(0,200,255,0.1)",
            background: "linear-gradient(180deg, rgba(0,130,255,0.12) 0%, transparent 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            position: "relative",
            zIndex: 1,
            flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ position: "relative", width: 28, height: 28 }}>
                <div style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "50%",
                  border: "1px dashed rgba(0,220,255,0.4)",
                  animation: "jarvisRotate 6s linear infinite",
                }} />
                <div style={{
                  position: "absolute",
                  inset: 5,
                  borderRadius: "50%",
                  background: "radial-gradient(circle, #60efff 0%, #00a8e8 60%, #002848 100%)",
                  boxShadow: "0 0 6px rgba(0,220,255,0.6)",
                }} />
              </div>
              <div>
                <div style={{
                  color: "#00e5ff",
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: 3.5,
                  fontFamily: "'DM Sans', sans-serif",
                  textShadow: "0 0 12px rgba(0,229,255,0.6)",
                  lineHeight: 1.2,
                }}>J.A.R.V.I.S.</div>
                <div style={{ color: "#1e6080", fontSize: 9, letterSpacing: 2, marginTop: 1 }}>
                  TRADING INTELLIGENCE SYSTEM
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setShowKey(s => !s)}
                title={apiKey ? "Clef API configurée — cliquer pour modifier" : "Configurer la clef API"}
                style={{
                  background: apiKey ? "rgba(0,220,255,0.08)" : "rgba(255,150,0,0.08)",
                  border: `1px solid ${apiKey ? "rgba(0,220,255,0.2)" : "rgba(255,180,0,0.25)"}`,
                  borderRadius: 7,
                  color: apiKey ? "#2a7a9a" : "#b87020",
                  cursor: "pointer",
                  padding: "4px 9px",
                  fontSize: 13,
                  lineHeight: 1,
                }}
              >⚙</button>
              <button
                onClick={() => setMessages([])}
                title="Effacer la conversation"
                style={{
                  background: "rgba(0,100,160,0.08)",
                  border: "1px solid rgba(0,180,255,0.15)",
                  borderRadius: 7,
                  color: "#2a6a8a",
                  cursor: "pointer",
                  padding: "4px 9px",
                  fontSize: 13,
                  lineHeight: 1,
                }}
              >↺</button>
            </div>
          </div>

          {/* ── API Key panel ── */}
          {showKey && (
            <div style={{
              padding: "10px 16px",
              background: "rgba(0,80,160,0.07)",
              borderBottom: "1px solid rgba(0,200,255,0.08)",
              position: "relative",
              zIndex: 1,
              flexShrink: 0,
            }}>
              <div style={{ color: "#1a5070", fontSize: 10, letterSpacing: 1.5, marginBottom: 7 }}>
                CLÉ API ANTHROPIC
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="password"
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveKey()}
                  placeholder={apiKey ? "••••••••••••••••" : "sk-ant-api03-..."}
                  autoFocus
                  style={{
                    flex: 1,
                    background: "rgba(0,0,0,0.5)",
                    border: "1px solid rgba(0,200,255,0.18)",
                    borderRadius: 8,
                    color: "#7ac8e8",
                    padding: "7px 11px",
                    fontSize: 12,
                    outline: "none",
                    fontFamily: "'DM Sans', sans-serif",
                  }}
                />
                <button onClick={saveKey} style={{
                  background: "rgba(0,160,255,0.15)",
                  border: "1px solid rgba(0,220,255,0.25)",
                  borderRadius: 8,
                  color: "#00e5ff",
                  cursor: "pointer",
                  padding: "7px 13px",
                  fontSize: 12,
                  fontWeight: 700,
                }}>OK</button>
                {apiKey && (
                  <button onClick={deleteKey} title="Supprimer la clef" style={{
                    background: "rgba(255,60,60,0.08)",
                    border: "1px solid rgba(255,80,80,0.2)",
                    borderRadius: 8,
                    color: "#884444",
                    cursor: "pointer",
                    padding: "7px 10px",
                    fontSize: 12,
                  }}>✕</button>
                )}
              </div>
              {!apiKey && (
                <div style={{ color: "#1a4060", fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
                  Obtenez votre clef sur console.anthropic.com — stockée localement dans votre navigateur.
                </div>
              )}
            </div>
          )}

          {/* ── Messages ── */}
          <div style={{
            flex: 1,
            overflowY: "auto",
            padding: "14px 14px 6px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            position: "relative",
            zIndex: 1,
          }}>
            {messages.length === 0 && (
              <div style={{ textAlign: "center", marginTop: 24, paddingBottom: 8 }}>
                <div style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "radial-gradient(circle at 40% 35%, #18b8e8 0%, #004880 60%, #000d1a 100%)",
                  boxShadow: "0 0 20px rgba(0,180,255,0.25)",
                  margin: "0 auto 14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  position: "relative",
                }}>
                  <div style={{
                    position: "absolute",
                    inset: 3,
                    borderRadius: "50%",
                    border: "1px dashed rgba(0,220,255,0.4)",
                    animation: "jarvisRotate 5s linear infinite",
                  }} />
                  <span style={{ fontSize: 14, color: "#80e8ff", textShadow: "0 0 8px #0df" }}>◈</span>
                </div>
                <div style={{ color: "#1e6a8a", fontSize: 13, lineHeight: 1.65, marginBottom: 18 }}>
                  Bonjour. Je suis <span style={{ color: "#00c8e8" }}>J.A.R.V.I.S.</span><br />
                  {trades.length > 0
                    ? `J'ai analysé ${trades.length} trade(s) dans votre journal.`
                    : "Aucune donnée de trading détectée pour l'instant."
                  }<br />
                  Comment puis-je vous assister ?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {SUGGESTIONS.map(s => (
                    <button
                      key={s}
                      onClick={() => { setInput(s); setTimeout(() => send(s), 0); }}
                      style={{
                        background: "rgba(0,80,160,0.1)",
                        border: "1px solid rgba(0,160,255,0.12)",
                        borderRadius: 9,
                        color: "#2a7aaa",
                        cursor: "pointer",
                        padding: "8px 13px",
                        fontSize: 12,
                        textAlign: "left",
                        transition: "all 0.2s",
                        fontFamily: "'DM Sans', sans-serif",
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = "rgba(0,100,200,0.18)";
                        e.currentTarget.style.borderColor = "rgba(0,200,255,0.22)";
                        e.currentTarget.style.color = "#4ab0d8";
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = "rgba(0,80,160,0.1)";
                        e.currentTarget.style.borderColor = "rgba(0,160,255,0.12)";
                        e.currentTarget.style.color = "#2a7aaa";
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} style={{
                display: "flex",
                flexDirection: "column",
                alignItems: m.role === "user" ? "flex-end" : "flex-start",
              }}>
                {m.role === "assistant" && (
                  <div style={{
                    color: "#006888",
                    fontSize: 9,
                    letterSpacing: 2,
                    marginBottom: 3,
                    marginLeft: 3,
                  }}>J.A.R.V.I.S.</div>
                )}
                <div style={{
                  maxWidth: "88%",
                  padding: "9px 13px",
                  borderRadius: m.role === "user"
                    ? "13px 13px 4px 13px"
                    : "4px 13px 13px 13px",
                  background: m.role === "user"
                    ? "rgba(0,100,220,0.22)"
                    : m.error
                      ? "rgba(200,40,40,0.1)"
                      : "rgba(0,30,60,0.7)",
                  border: m.role === "user"
                    ? "1px solid rgba(0,160,255,0.28)"
                    : m.error
                      ? "1px solid rgba(255,80,80,0.2)"
                      : "1px solid rgba(0,80,160,0.22)",
                  color: m.role === "user"
                    ? "#80c8f0"
                    : m.error
                      ? "#e87070"
                      : "#6ab0d8",
                  fontSize: 13,
                  lineHeight: 1.65,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {m.content}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                <div style={{ color: "#006888", fontSize: 9, letterSpacing: 2, marginBottom: 3, marginLeft: 3 }}>J.A.R.V.I.S.</div>
                <div style={{
                  padding: "10px 14px",
                  background: "rgba(0,30,60,0.7)",
                  border: "1px solid rgba(0,80,160,0.22)",
                  borderRadius: "4px 13px 13px 13px",
                }}>
                  <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    {[0, 1, 2].map(i => (
                      <div key={i} style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "#00b8e0",
                        boxShadow: "0 0 4px #0df",
                        animation: `jarvisDot 1.3s ease-in-out ${i * 0.22}s infinite`,
                      }} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* ── Input area ── */}
          <div style={{
            padding: "10px 14px 14px",
            borderTop: "1px solid rgba(0,200,255,0.08)",
            background: "rgba(0,0,0,0.35)",
            position: "relative",
            zIndex: 1,
            flexShrink: 0,
          }}>
            {!apiKey ? (
              <button
                onClick={() => setShowKey(true)}
                style={{
                  width: "100%",
                  background: "rgba(255,160,0,0.07)",
                  border: "1px solid rgba(255,160,0,0.2)",
                  borderRadius: 10,
                  color: "#8a6020",
                  cursor: "pointer",
                  padding: "10px",
                  fontSize: 12,
                  fontFamily: "'DM Sans', sans-serif",
                  textAlign: "center",
                  lineHeight: 1.5,
                }}
              >
                ⚙ Configurez votre clé API Anthropic pour activer J.A.R.V.I.S.
              </button>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder="Interrogez J.A.R.V.I.S. …"
                  disabled={loading}
                  style={{
                    flex: 1,
                    background: "rgba(0,0,0,0.5)",
                    border: "1px solid rgba(0,200,255,0.14)",
                    borderRadius: 11,
                    color: "#80c8e8",
                    padding: "9px 14px",
                    fontSize: 13,
                    outline: "none",
                    fontFamily: "'DM Sans', sans-serif",
                    caretColor: "#00e5ff",
                  }}
                />
                <button
                  onClick={() => send()}
                  disabled={loading || !input.trim()}
                  style={{
                    background: loading || !input.trim()
                      ? "rgba(0,60,120,0.15)"
                      : "rgba(0,140,255,0.25)",
                    border: `1px solid ${loading || !input.trim() ? "rgba(0,120,200,0.12)" : "rgba(0,220,255,0.3)"}`,
                    borderRadius: 11,
                    color: loading || !input.trim() ? "#1a4060" : "#00e5ff",
                    cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                    padding: "9px 16px",
                    fontSize: 16,
                    lineHeight: 1,
                    transition: "all 0.2s",
                    boxShadow: loading || !input.trim() ? "none" : "0 0 10px rgba(0,220,255,0.15)",
                  }}
                >↑</button>
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes jarvisOpen {
          from { opacity: 0; transform: scale(0.88) translateY(12px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes jarvisRotate {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes jarvisDot {
          0%, 60%, 100% { transform: scale(0.75); opacity: 0.35; }
          30%            { transform: scale(1.25); opacity: 1; }
        }
      `}</style>
    </>
  );
}
