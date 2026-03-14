import { useState, useEffect, useCallback } from "react";

// ── helpers ───────────────────────────────────────────────────────────────────
const parsePnl = (str) => {
  const s = String(str).replace(/[$,\s"]/g, "");
  if (s.startsWith("(") && s.endsWith(")")) return -parseFloat(s.slice(1, -1)) || 0;
  return parseFloat(s) || 0;
};

const splitCSVLine = (line) => {
  const result = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ""; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
};

const detectSession = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const h = d.getHours(), mn = d.getMinutes();
  const mins = h * 60 + mn;
  if (mins >= 540 && mins < 870) return "londres";
  if (mins >= 870 && mins <= 1320) return "us";
  return null;
};

const parseApexDate = (str) => {
  if (!str) return "";
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`;
  return str;
};

const detectFormat = (headers) => {
  const h = headers.map(x => x.toLowerCase().replace(/"/g, "").trim());
  if (h.some(x => x === "buyfillid" || x === "sellfillid")) return "topstep";
  if (h.some(x => x === "enteredat" || x === "contractname")) return "apex";
  return null;
};

const parseCSV = (text, accountName) => {
  const cleaned = text.replace(/^\uFEFF/, "");
  const lines = cleaned.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]).map(h => h.replace(/"/g, "").trim());
  const fmt = detectFormat(headers);
  if (!fmt) return [];
  const trades = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 3) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || "").replace(/^"|"$/g, "").trim(); });
    try {
      if (fmt === "topstep") {
        const pnl = parsePnl(row.pnl);
        const boughtAt = row.boughtTimestamp || "";
        const soldAt = row.soldTimestamp || "";
        const dateObj = boughtAt ? new Date(boughtAt) : null;
        const dateStr = dateObj && !isNaN(dateObj)
          ? `${String(dateObj.getMonth()+1).padStart(2,"0")}/${String(dateObj.getDate()).padStart(2,"0")}/${dateObj.getFullYear()}`
          : "";
        let direction = "long";
        if (boughtAt && soldAt) direction = new Date(soldAt) > new Date(boughtAt) ? "long" : "short";
        trades.push({
          id: `${row.buyFillId||""}-${row.sellFillId||""}-${i}`,
          symbol: row.symbol || "", lot: parseInt(row.qty) || 1,
          buyPrice: parseFloat(row.buyPrice) || 0, sellPrice: parseFloat(row.sellPrice) || 0,
          pnl, boughtAt, soldAt, duration: row.duration || "", date: dateStr,
          account: accountName, category: detectSession(boughtAt), direction,
        });
      } else {
        const pnl = parsePnl(row.PnL || row.pnl || "0");
        const boughtAt = parseApexDate(row.EnteredAt || row.enteredAt || "");
        const soldAt = parseApexDate(row.ExitedAt || row.exitedAt || "");
        const dateObj = boughtAt ? new Date(boughtAt) : null;
        const dateStr = dateObj && !isNaN(dateObj)
          ? `${String(dateObj.getMonth()+1).padStart(2,"0")}/${String(dateObj.getDate()).padStart(2,"0")}/${dateObj.getFullYear()}`
          : "";
        const rawType = (row.Type || row.type || "").toLowerCase();
        let direction = "long";
        if (rawType.includes("short")) direction = "short";
        else if (rawType.includes("long")) direction = "long";
        else if (boughtAt && soldAt) direction = new Date(soldAt) > new Date(boughtAt) ? "long" : "short";
        trades.push({
          id: `apex-${row.Id||row.id||""}-${i}`,
          symbol: row.ContractName || row.contractName || "",
          lot: parseInt(row.Size || row.size) || 1,
          buyPrice: parseFloat(row.EntryPrice || row.entryPrice) || 0,
          sellPrice: parseFloat(row.ExitPrice || row.exitPrice) || 0,
          pnl, boughtAt, soldAt, duration: row.TradeDuration || row.tradeDuration || "",
          date: dateStr, account: accountName, category: detectSession(boughtAt), direction,
        });
      }
    } catch(e) {}
  }
  return trades;
};

const fmtMoney = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", signDisplay: "always" }).format(n);
const fmtAbs = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD" }).format(n);

const isScalp = (duration) => {
  if (!duration) return false;
  const hms = duration.match(/^(\d+):(\d+):(\d+)/);
  if (hms) return parseInt(hms[1]) * 3600 + parseInt(hms[2]) * 60 + parseInt(hms[3]) < 120;
  const minMatch = duration.match(/(\d+)min/);
  if (minMatch && parseInt(minMatch[1]) >= 2) return false;
  if (duration.includes("sec")) return true;
  return false;
};

// ── storage ───────────────────────────────────────────────────────────────────
const SK = "trading-journal-v2";
const SK_STATUS = "trading-journal-account-status";
const SK_PAYOUT = "trading-journal-account-payouts";
const SK_CHALL = "trading-journal-account-challenges";
const SK_SIZE = "trading-journal-account-sizes";
const SK_TYPE = "trading-journal-account-types";
const SK_SCALP_OFF = "trading-journal-scalp-off";

const load = async (key) => {
  try { const r = await window.storage.get(key, true); return r ? JSON.parse(r.value) : {}; }
  catch { return {}; }
};
const save = async (key, val) => {
  try { await window.storage.set(key, JSON.stringify(val), true); } catch {}
};
const loadTrades = async () => {
  try { const r = await window.storage.get(SK, true); return r ? JSON.parse(r.value) : []; }
  catch { return []; }
};
const saveTrades = async (t) => {
  try { await window.storage.set(SK, JSON.stringify(t), true); } catch {}
};

// ── stats ─────────────────────────────────────────────────────────────────────
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

const CAT = {
  londres: { color: "#60a5fa", label: "Londres", flag: "🇬🇧" },
  us: { color: "#f97316", label: "US", flag: "🇺🇸" },
};

// ── LOT CALC COMPONENT ────────────────────────────────────────────────────────
const INSTRUMENTS = {
  MGC:  { label: "Micro Gold",    color: "#f5c842", glow: "rgba(245,200,66,0.14)",   bg: "rgba(245,200,66,0.07)",   vp: 1,    unit: "pts",  dec: 1 },
  GC:   { label: "Mini Gold",     color: "#ffd96b", glow: "rgba(255,217,107,0.12)",  bg: "rgba(255,217,107,0.06)",  vp: 10,   unit: "pts",  dec: 1 },
  MNQ:  { label: "Micro Nasdaq",  color: "#00d4ff", glow: "rgba(0,212,255,0.12)",    bg: "rgba(0,212,255,0.06)",    vp: 2,    unit: "pts",  dec: 2 },
  NQ:   { label: "Mini Nasdaq",   color: "#5eeaff", glow: "rgba(94,234,255,0.12)",   bg: "rgba(94,234,255,0.06)",   vp: 20,   unit: "pts",  dec: 2 },
  M6E:  { label: "Micro EUR/USD", color: "#a855f7", glow: "rgba(168,85,247,0.12)",   bg: "rgba(168,85,247,0.06)",   vp: 1.25, unit: "pips", dec: 4 },
  "6E": { label: "Mini EUR/USD",  color: "#c084fc", glow: "rgba(192,132,252,0.12)",  bg: "rgba(192,132,252,0.06)",  vp: 6.25, unit: "pips", dec: 4 },
};

function dollarVal(distance, inst) {
  if (inst.unit === "pips") return (distance / 0.0001) * inst.vp;
  return distance * inst.vp;
}
function fmtDist(distance, inst) {
  if (inst.unit === "pips") return (Math.round(distance / 0.0001 * 10) / 10) + " pips";
  return distance.toFixed(inst.dec) + " pts";
}
function fmtPx(price, inst) { return price.toFixed(inst.dec); }

function LotCalcTab() {
  const [curInst, setCurInst] = useState("MGC");
  const [entry, setEntry] = useState("");
  const [sl, setSl] = useState("");
  const [risk, setRisk] = useState("");
  const [tp1Mode, setTp1Mode] = useState("rr");
  const [tp1Rr, setTp1Rr] = useState("");
  const [tp1Lots, setTp1Lots] = useState("");
  const [tp1Price, setTp1Price] = useState("");
  const [tp1LotsP, setTp1LotsP] = useState("");
  const [tp2Mode, setTp2Mode] = useState("rr");
  const [tp2Rr, setTp2Rr] = useState("");
  const [tp2Price, setTp2Price] = useState("");

  const inst = INSTRUMENTS[curInst];
  const e = parseFloat(entry), s = parseFloat(sl), r = parseFloat(risk);

  const valid = !isNaN(e) && !isNaN(s) && !isNaN(r) && r > 0;
  const distSL = valid ? Math.abs(e - s) : 0;
  const isLong = e > s;
  const riskPerLot = valid && distSL > 0 ? dollarVal(distSL, inst) : 0;
  const lots = valid && riskPerLot > 0 ? Math.floor(r / riskPerLot) : 0;
  const realRisk = lots * riskPerLot;

  // TP1
  let tp1PriceCalc = NaN, tp1LotsN = 0, tp1Gain = 0, tp1RrCalc = NaN;
  if (valid && distSL > 0 && lots > 0) {
    if (tp1Mode === "rr") {
      const rr = parseFloat(tp1Rr);
      tp1LotsN = parseInt(tp1Lots) || 0;
      if (!isNaN(rr) && rr > 0) tp1PriceCalc = isLong ? e + distSL * rr : e - distSL * rr;
    } else {
      tp1PriceCalc = parseFloat(tp1Price);
      tp1LotsN = parseInt(tp1LotsP) || 0;
      if (!isNaN(tp1PriceCalc)) {
        const raw = (tp1PriceCalc - e) * (isLong ? 1 : -1);
        tp1RrCalc = raw / distSL;
      }
    }
  }
  const hasTP1 = !isNaN(tp1PriceCalc) && tp1LotsN > 0 && lots > 0;
  const lotsTP1 = hasTP1 ? Math.min(tp1LotsN, lots) : 0;
  const lotsRem = hasTP1 ? lots - lotsTP1 : lots;
  if (hasTP1) {
    const dist = (tp1PriceCalc - e) * (isLong ? 1 : -1);
    tp1Gain = dollarVal(Math.abs(dist), inst) * lotsTP1 * (dist >= 0 ? 1 : -1);
  }

  // TP2
  let tp2PriceCalc = NaN, tp2Gain = 0, tp2RrCalc = NaN;
  if (valid && distSL > 0 && lots > 0) {
    if (tp2Mode === "rr") {
      const rr = parseFloat(tp2Rr);
      if (!isNaN(rr) && rr > 0) tp2PriceCalc = isLong ? e + distSL * rr : e - distSL * rr;
    } else {
      tp2PriceCalc = parseFloat(tp2Price);
      if (!isNaN(tp2PriceCalc)) {
        const raw = (tp2PriceCalc - e) * (isLong ? 1 : -1);
        tp2RrCalc = raw / distSL;
      }
    }
  }
  const hasTP2 = !isNaN(tp2PriceCalc) && lots > 0;
  if (hasTP2) {
    const dist = (tp2PriceCalc - e) * (isLong ? 1 : -1);
    tp2Gain = dollarVal(Math.abs(dist), inst) * lotsRem * (dist >= 0 ? 1 : -1);
  }

  const net = tp1Gain + tp2Gain;
  const rrNet = realRisk > 0 ? net / realRisk : 0;
  const showSummary = (hasTP1 || hasTP2) && lots > 0;

  // styles
  const S = {
    stitle: { fontSize: 9, letterSpacing: 3, textTransform: "uppercase", color: "#44486a", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 },
    card: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 20, marginBottom: 14 },
    flabel: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#44486a", marginBottom: 7 },
    input: { width: "100%", padding: "12px 42px 12px 14px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, color: "#dde0f5", fontFamily: "monospace", fontSize: 14, outline: "none", boxSizing: "border-box", MozAppearance: "textfield" },
    inputPfx: { width: "100%", padding: "12px 14px 12px 28px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, color: "#dde0f5", fontFamily: "monospace", fontSize: 14, outline: "none", boxSizing: "border-box", MozAppearance: "textfield" },
    irow: { position: "relative" },
    sfx: { position: "absolute", right: 13, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#44486a", pointerEvents: "none" },
    pfx: { position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "#44486a", pointerEvents: "none" },
    frow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
    field: { marginBottom: 14 },
    statGrid: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 10 },
    stat: { background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, padding: "10px 8px", textAlign: "center" },
    statL: { fontSize: 8, letterSpacing: 2, textTransform: "uppercase", color: "#44486a", marginBottom: 4 },
    statV: { fontSize: 12, fontWeight: 600, color: "#dde0f5" },
    tpBlock: { background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, padding: 16, marginBottom: 10 },
    tpHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
    modeToggle: { display: "flex", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 4, overflow: "hidden" },
    modeBtn: (active) => ({ padding: "4px 10px", fontSize: 9, letterSpacing: 1, color: active ? "#dde0f5" : "#44486a", background: active ? "rgba(255,255,255,0.1)" : "transparent", border: "none", cursor: "pointer", textTransform: "uppercase", fontFamily: "monospace", transition: "all 0.15s" }),
    badge: (cls) => ({ display: "inline-block", padding: "2px 9px", borderRadius: 3, fontSize: 8, letterSpacing: 1, fontWeight: 700, ...(cls === "tp1" ? { background: "rgba(255,140,0,0.12)", color: "#ff8c00", border: "1px solid rgba(255,140,0,0.25)" } : { background: "rgba(16,232,154,0.10)", color: "#10e89a", border: "1px solid rgba(16,232,154,0.22)" }) }),
    computed: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 },
    sumRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 12 },
    netBlock: { background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: 18, marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" },
  };

  const rrColor = (rr) => rr >= 2 ? "#10e89a" : rr >= 1 ? "#ff8c00" : "#ff4060";

  const placeholder = (field) => {
    const pip = inst.unit === "pips";
    const nq = curInst.includes("NQ");
    if (field === "entry") return pip ? "1.08500" : nq ? "19500.00" : "2650.0";
    if (field === "sl")    return pip ? "1.08400" : nq ? "19480.00" : "2645.0";
    if (field === "tp1")   return pip ? "1.08600" : nq ? "19520.00" : "2660.0";
    if (field === "tp2")   return pip ? "1.08700" : nq ? "19550.00" : "2670.0";
    return "";
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", fontFamily: "monospace" }}>
      {/* Instrument grid */}
      <div style={{ ...S.stitle }}>
        Instrument
        <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 24 }}>
        {Object.entries(INSTRUMENTS).map(([k, v]) => {
          const active = k === curInst;
          return (
            <button key={k} onClick={() => setCurInst(k)} style={{ padding: "12px 6px 10px", border: active ? `1px solid ${v.color}` : "1px solid rgba(255,255,255,0.08)", background: active ? v.bg : "rgba(255,255,255,0.02)", borderRadius: 6, cursor: "pointer", textAlign: "center", position: "relative", transition: "all 0.18s" }}>
              {active && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: v.color, borderRadius: "6px 6px 0 0" }} />}
              <div style={{ fontFamily: "'Bebas Neue', 'Syne', sans-serif", fontSize: 20, letterSpacing: 2, color: active ? v.color : "#555", transition: "color 0.18s" }}>{k}</div>
              <div style={{ fontSize: 8, letterSpacing: 1, color: active ? v.color : "#333", marginTop: 2, opacity: active ? 0.8 : 1 }}>{v.label}</div>
              <div style={{ fontSize: 8, color: "#333", marginTop: 1 }}>${v.vp}/{v.unit === "pips" ? "pip" : "pt"}</div>
            </button>
          );
        })}
      </div>

      {/* Entry / SL / Risk */}
      <div style={{ ...S.stitle }}>
        Niveaux & Risque
        <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
      </div>
      <div style={S.card}>
        <div style={S.frow}>
          <div style={S.field}>
            <div style={S.flabel}>Entrée</div>
            <div style={S.irow}>
              <input type="number" step="0.01" placeholder={placeholder("entry")} value={entry} onChange={e => setEntry(e.target.value)} style={{ ...S.input, borderColor: valid && distSL > 0 ? `${inst.color}55` : "rgba(255,255,255,0.08)" }} />
            </div>
          </div>
          <div style={S.field}>
            <div style={S.flabel}>Stop Loss</div>
            <div style={S.irow}>
              <input type="number" step="0.01" placeholder={placeholder("sl")} value={sl} onChange={e => setSl(e.target.value)} style={{ ...S.input, borderColor: valid && distSL > 0 ? `${inst.color}55` : "rgba(255,255,255,0.08)" }} />
            </div>
          </div>
        </div>
        <div style={S.field}>
          <div style={S.flabel}>Risque maximum <em style={{ fontStyle: "normal", fontSize: 8, color: "#666" }}>USD</em></div>
          <div style={S.irow}>
            <span style={S.pfx}>$</span>
            <input type="number" step="1" placeholder="200" value={risk} onChange={e => setRisk(e.target.value)} style={S.inputPfx} />
          </div>
        </div>

        <div style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: "18px 0" }} />

        {/* Result box */}
        <div style={{ background: "rgba(0,0,0,0.3)", border: `1px solid ${valid && lots > 0 ? inst.color : "rgba(255,255,255,0.08)"}`, borderRadius: 6, padding: "18px 20px", textAlign: "center", marginBottom: 12, boxShadow: valid && lots > 0 ? `0 0 28px ${inst.glow}` : "none", transition: "all 0.3s" }}>
          <div style={{ fontSize: 9, letterSpacing: 3, textTransform: "uppercase", color: "#44486a", marginBottom: 8 }}>Nombre de lots</div>
          <div style={{ fontFamily: "'Syne', 'Bebas Neue', sans-serif", fontSize: 72, lineHeight: 1, letterSpacing: 2, color: valid && lots > 0 ? inst.color : "#333", transition: "color 0.25s", fontWeight: 800 }}>
            {valid && distSL > 0 ? lots : "—"}
          </div>
          <div style={{ fontSize: 10, color: "#44486a", letterSpacing: 2, marginTop: 4 }}>LOTS</div>
        </div>

        {valid && distSL > 0 && lots > 0 && (
          <div style={S.statGrid}>
            <div style={S.stat}><div style={S.statL}>Distance SL</div><div style={S.statV}>{fmtDist(distSL, inst)}</div></div>
            <div style={S.stat}><div style={S.statL}>Risque réel</div><div style={{ ...S.statV, color: "#ff4060" }}>-${realRisk.toFixed(2)}</div></div>
            <div style={S.stat}><div style={S.statL}>Risque/lot</div><div style={S.statV}>${riskPerLot.toFixed(2)}</div></div>
          </div>
        )}
        {valid && distSL === 0 && (
          <div style={{ padding: "9px 13px", borderLeft: "3px solid #ff4060", background: "rgba(255,64,96,0.06)", borderRadius: "0 4px 4px 0", fontSize: 10, color: "#ff4060" }}>⚠ Distance SL nulle ou invalide.</div>
        )}
      </div>

      {/* Take Profit */}
      <div style={{ ...S.stitle }}>
        Take Profit
        <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
      </div>
      <div style={S.card}>
        {/* TP1 */}
        <div style={S.tpBlock}>
          <div style={S.tpHead}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={S.badge("tp1")}>TP 1</span>
              <span style={{ fontSize: 9, color: "#44486a" }}>Sortie partielle</span>
            </div>
            <div style={S.modeToggle}>
              <button style={S.modeBtn(tp1Mode === "rr")}    onClick={() => setTp1Mode("rr")}>R:R</button>
              <button style={S.modeBtn(tp1Mode === "price")} onClick={() => setTp1Mode("price")}>Prix</button>
            </div>
          </div>

          {tp1Mode === "rr" ? (
            <>
              <div style={S.frow}>
                <div style={S.field}>
                  <div style={S.flabel}>Ratio R:R <em style={{ fontStyle: "normal", fontSize: 8, color: "#666" }}>ex: 1.5</em></div>
                  <div style={S.irow}>
                    <input type="number" step="0.1" min="0.1" placeholder="1.5" value={tp1Rr} onChange={e => setTp1Rr(e.target.value)} style={S.input} />
                    <span style={S.sfx}>R</span>
                  </div>
                </div>
                <div style={S.field}>
                  <div style={S.flabel}>Lots fermés <em style={{ fontStyle: "normal", fontSize: 8, color: "#666" }}>au TP1</em></div>
                  <div style={S.irow}>
                    <input type="number" step="1" min="0" placeholder="0" value={tp1Lots} onChange={e => setTp1Lots(e.target.value)} style={S.input} />
                    <span style={S.sfx}>lot</span>
                  </div>
                </div>
              </div>
              {!isNaN(tp1PriceCalc) && (
                <div style={S.computed}>
                  <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#44486a" }}>Prix TP1 calculé</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: inst.color }}>{fmtPx(tp1PriceCalc, inst)}</span>
                </div>
              )}
            </>
          ) : (
            <>
              <div style={S.frow}>
                <div style={S.field}>
                  <div style={S.flabel}>Prix TP1</div>
                  <div style={S.irow}>
                    <input type="number" step="0.01" placeholder={placeholder("tp1")} value={tp1Price} onChange={e => setTp1Price(e.target.value)} style={S.input} />
                  </div>
                </div>
                <div style={S.field}>
                  <div style={S.flabel}>Lots fermés <em style={{ fontStyle: "normal", fontSize: 8, color: "#666" }}>au TP1</em></div>
                  <div style={S.irow}>
                    <input type="number" step="1" min="0" placeholder="0" value={tp1LotsP} onChange={e => setTp1LotsP(e.target.value)} style={S.input} />
                    <span style={S.sfx}>lot</span>
                  </div>
                </div>
              </div>
              {!isNaN(tp1RrCalc) && valid && distSL > 0 && (
                <div style={S.computed}>
                  <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#44486a" }}>R:R TP1</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: rrColor(tp1RrCalc) }}>{tp1RrCalc.toFixed(2)}R</span>
                </div>
              )}
            </>
          )}

          {hasTP1 && (
            <div style={S.statGrid}>
              <div style={S.stat}><div style={S.statL}>Dist. TP1</div><div style={{ ...S.statV, color: "#ff8c00" }}>{fmtDist(Math.abs(tp1PriceCalc - e), inst)}</div></div>
              <div style={S.stat}><div style={S.statL}>Gain TP1</div><div style={{ ...S.statV, color: "#10e89a" }}>${tp1Gain.toFixed(2)}</div></div>
              <div style={S.stat}><div style={S.statL}>Lots restants</div><div style={S.statV}>{lotsRem} lot{lotsRem !== 1 ? "s" : ""}</div></div>
            </div>
          )}
        </div>

        {/* TP2 */}
        <div style={{ ...S.tpBlock, marginBottom: 0 }}>
          <div style={S.tpHead}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={S.badge("tp2")}>TP FINAL</span>
              <span style={{ fontSize: 9, color: "#44486a" }}>Sortie lots restants</span>
            </div>
            <div style={S.modeToggle}>
              <button style={S.modeBtn(tp2Mode === "rr")}    onClick={() => setTp2Mode("rr")}>R:R</button>
              <button style={S.modeBtn(tp2Mode === "price")} onClick={() => setTp2Mode("price")}>Prix</button>
            </div>
          </div>

          {tp2Mode === "rr" ? (
            <>
              <div style={S.field}>
                <div style={S.flabel}>Ratio R:R <em style={{ fontStyle: "normal", fontSize: 8, color: "#666" }}>ex: 3</em></div>
                <div style={S.irow}>
                  <input type="number" step="0.1" min="0.1" placeholder="3" value={tp2Rr} onChange={e => setTp2Rr(e.target.value)} style={S.input} />
                  <span style={S.sfx}>R</span>
                </div>
              </div>
              {!isNaN(tp2PriceCalc) && (
                <div style={S.computed}>
                  <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#44486a" }}>Prix TP Final calculé</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: inst.color }}>{fmtPx(tp2PriceCalc, inst)}</span>
                </div>
              )}
            </>
          ) : (
            <>
              <div style={S.field}>
                <div style={S.flabel}>Prix TP Final</div>
                <div style={S.irow}>
                  <input type="number" step="0.01" placeholder={placeholder("tp2")} value={tp2Price} onChange={e => setTp2Price(e.target.value)} style={S.input} />
                </div>
              </div>
              {!isNaN(tp2RrCalc) && valid && distSL > 0 && (
                <div style={S.computed}>
                  <span style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#44486a" }}>R:R TP Final</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: rrColor(tp2RrCalc) }}>{tp2RrCalc.toFixed(2)}R</span>
                </div>
              )}
            </>
          )}

          {hasTP2 && (
            <div style={S.statGrid}>
              <div style={S.stat}><div style={S.statL}>Dist. TP Final</div><div style={{ ...S.statV, color: "#10e89a" }}>{fmtDist(Math.abs(tp2PriceCalc - e), inst)}</div></div>
              <div style={S.stat}><div style={S.statL}>Gain TP Final</div><div style={{ ...S.statV, color: "#10e89a" }}>${tp2Gain.toFixed(2)}</div></div>
              <div style={S.stat}><div style={S.statL}>Lots TP Final</div><div style={S.statV}>{lotsRem} lot{lotsRem !== 1 ? "s" : ""}</div></div>
            </div>
          )}
        </div>
      </div>

      {/* Summary */}
      {showSummary && (
        <>
          <div style={{ ...S.stitle }}>
            Résumé
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.07)" }} />
          </div>
          <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
            <div style={{ background: "rgba(255,255,255,0.03)", padding: "13px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
              <span style={{ fontSize: 9, letterSpacing: 3, textTransform: "uppercase", color: "#44486a" }}>📊 Récapitulatif</span>
              <span style={{ fontWeight: 700, fontSize: 12, color: isLong ? "#10e89a" : "#ff4060" }}>{isLong ? "▲ LONG" : "▼ SHORT"}</span>
            </div>
            <div style={{ padding: 18 }}>
              <div style={S.sumRow}><span style={{ color: "#555" }}>Instrument</span><span style={{ fontWeight: 700, color: inst.color }}>{curInst} — {inst.label}</span></div>
              <div style={S.sumRow}><span style={{ color: "#555" }}>Lots totaux</span><span style={{ fontWeight: 700 }}>{lots} lot{lots !== 1 ? "s" : ""}</span></div>
              <div style={S.sumRow}><span style={{ color: "#555" }}>Risque si SL touché</span><span style={{ fontWeight: 700, color: "#ff4060" }}>-${realRisk.toFixed(2)}</span></div>
              {hasTP1 && <div style={S.sumRow}><span style={{ color: "#555" }}>Gain TP1 (partiel)</span><span style={{ fontWeight: 700, color: "#ff8c00" }}>+${tp1Gain.toFixed(2)} ({lotsTP1} lot{lotsTP1 !== 1 ? "s" : ""})</span></div>}
              {hasTP2 && <div style={{ ...S.sumRow, borderBottom: "none" }}><span style={{ color: "#555" }}>Gain TP Final (reste)</span><span style={{ fontWeight: 700, color: "#10e89a" }}>+${tp2Gain.toFixed(2)} ({lotsRem} lot{lotsRem !== 1 ? "s" : ""})</span></div>}

              <div style={S.netBlock}>
                <div>
                  <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#44486a" }}>Gain net total</div>
                  <div style={{ fontSize: 9, color: "#44486a", marginTop: 4 }}>R:R = 1 : {Math.abs(rrNet).toFixed(2)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 38, fontWeight: 800, letterSpacing: 1, color: net >= 0 ? "#10e89a" : "#ff4060" }}>
                    {net >= 0 ? "+" : ""}{net.toFixed(2)}$
                  </div>
                  <div style={{ marginTop: 5, display: "inline-block", padding: "3px 10px", borderRadius: 3, fontWeight: 700, fontSize: 14, ...(rrNet >= 2 ? { background: "rgba(16,232,154,0.12)", color: "#10e89a", border: "1px solid rgba(16,232,154,0.25)" } : rrNet >= 1 ? { background: "rgba(255,140,0,0.12)", color: "#ff8c00", border: "1px solid rgba(255,140,0,0.25)" } : { background: "rgba(255,64,96,0.12)", color: "#ff4060", border: "1px solid rgba(255,64,96,0.25)" }) }}>
                    {rrNet.toFixed(2)}R
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <div style={{ textAlign: "center", fontSize: 9, color: "#33364a", letterSpacing: 1.5, marginTop: 10, lineHeight: 1.8 }}>
        MGC $1/pt · GC $10/pt · MNQ $2/pt · NQ $20/pt · M6E $1.25/pip · 6E $6.25/pip
      </div>
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "18px 20px" }}>
      <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "#555", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || "#f0f0f0", fontFamily: "'Syne', sans-serif" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#555", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function PnlBadge({ pnl }) {
  const pos = pnl >= 0;
  return (
    <span style={{
      display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700,
      background: pos ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)",
      color: pos ? "#34d399" : "#f87171",
      border: `1px solid ${pos ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)"}`,
    }}>{fmtMoney(pnl)}</span>
  );
}

function DirectionBadge({ d }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: d === "long" ? "#34d399" : "#f87171" }}>
      {d === "long" ? "▲ Long" : "▼ Short"}
    </span>
  );
}

function CategoryToggle({ id, cat, onUpdate }) {
  return (
    <span style={{ display: "inline-flex", gap: 3 }}>
      {[null, "londres", "us"].map((o, i) => {
        const active = cat === o;
        const labels = ["—", "🇬🇧", "🇺🇸"];
        return (
          <button key={i} onClick={() => onUpdate(id, o)} style={{
            padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "none",
            background: active ? (o ? `rgba(${o === "londres" ? "96,165,250" : "249,115,22"},0.25)` : "rgba(255,255,255,0.1)") : "rgba(255,255,255,0.03)",
            color: active ? (o === "londres" ? "#60a5fa" : o === "us" ? "#f97316" : "#aaa") : "#444",
          }}>{labels[i]}</button>
        );
      })}
    </span>
  );
}

function PieChart({ winners, losers, be, compact = false }) {
  const total = winners + losers + be;
  if (total === 0) return <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 11 }}>Aucune donnée</div>;

  const slices = [
    { value: winners, color: "#34d399", label: "Gagnants" },
    { value: losers,  color: "#f87171", label: "Perdants" },
    { value: be,      color: "#94a3b8", label: "Breakeven" },
  ];

  const R = 68, IR = 40, cx = 90, cy = 90;
  let angle = -Math.PI / 2;
  const GAP = 0.03;
  const paths = slices.map((s) => {
    if (s.value === 0) return null;
    const sweep = (s.value / total) * 2 * Math.PI - GAP;
    const a1 = angle + GAP / 2, a2 = a1 + sweep;
    const x1o = cx + R * Math.cos(a1), y1o = cy + R * Math.sin(a1);
    const x2o = cx + R * Math.cos(a2), y2o = cy + R * Math.sin(a2);
    const x1i = cx + IR * Math.cos(a2), y1i = cy + IR * Math.sin(a2);
    const x2i = cx + IR * Math.cos(a1), y2i = cy + IR * Math.sin(a1);
    const large = sweep > Math.PI ? 1 : 0;
    const d = `M${x1o.toFixed(2)},${y1o.toFixed(2)} A${R},${R} 0 ${large},1 ${x2o.toFixed(2)},${y2o.toFixed(2)} L${x1i.toFixed(2)},${y1i.toFixed(2)} A${IR},${IR} 0 ${large},0 ${x2i.toFixed(2)},${y2i.toFixed(2)} Z`;
    angle += (s.value / total) * 2 * Math.PI;
    return { d, color: s.color, label: s.label, value: s.value };
  }).filter(Boolean);

  const winPct = total ? ((winners / total) * 100).toFixed(1) : 0;

  if (compact) {
    const Rc = 36, IRc = 21, cxc = 40, cyc = 40;
    let ac = -Math.PI / 2;
    const cpaths = slices.map((s) => {
      if (s.value === 0) return null;
      const sw = (s.value / total) * 2 * Math.PI - GAP;
      const a1 = ac + GAP / 2, a2 = a1 + sw;
      const x1o = cxc + Rc * Math.cos(a1), y1o = cyc + Rc * Math.sin(a1);
      const x2o = cxc + Rc * Math.cos(a2), y2o = cyc + Rc * Math.sin(a2);
      const x1i = cxc + IRc * Math.cos(a2), y1i = cyc + IRc * Math.sin(a2);
      const x2i = cxc + IRc * Math.cos(a1), y2i = cyc + IRc * Math.sin(a1);
      const lg = sw > Math.PI ? 1 : 0;
      const d = `M${x1o.toFixed(2)},${y1o.toFixed(2)} A${Rc},${Rc} 0 ${lg},1 ${x2o.toFixed(2)},${y2o.toFixed(2)} L${x1i.toFixed(2)},${y1i.toFixed(2)} A${IRc},${IRc} 0 ${lg},0 ${x2i.toFixed(2)},${y2i.toFixed(2)} Z`;
      ac += (s.value / total) * 2 * Math.PI;
      return { d, color: s.color, label: s.label, value: s.value };
    }).filter(Boolean);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 16, width: "100%" }}>
        <svg width={80} height={80} style={{ flexShrink: 0, overflow: "visible" }}>
          {cpaths.map((p, i) => <path key={i} d={p.d} fill={p.color} opacity={0.9} />)}
          <text x={cxc} y={cyc - 4} textAnchor="middle" fill="#e0e0e0" fontSize={12} fontWeight={800} fontFamily="Syne, sans-serif">{winPct}%</text>
          <text x={cxc} y={cyc + 9} textAnchor="middle" fill="#555" fontSize={7} letterSpacing={1}>WIN</text>
        </svg>
        <div style={{ display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
          {slices.map(s => (
            <div key={s.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: 2, background: s.color }} />
                <span style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>{s.label}</span>
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: s.color, fontFamily: "'Syne', sans-serif" }}>{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      <svg width={180} height={180} style={{ flexShrink: 0, overflow: "visible" }}>
        {paths.map((p, i) => <path key={i} d={p.d} fill={p.color} opacity={0.9} />)}
        <text x={cx} y={cy - 10} textAnchor="middle" fill="#e0e0e0" fontSize={22} fontWeight={800} fontFamily="Syne, sans-serif">{winPct}%</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#555" fontSize={10} letterSpacing={2}>WIN RATE</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        {slices.map(s => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 3, height: 36, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1.5 }}>{s.label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: s.color, fontFamily: "'Syne', sans-serif" }}>{s.value}</div>
              </div>
              <div style={{ marginTop: 4, height: 3, borderRadius: 2, background: "rgba(255,255,255,0.05)" }}>
                <div style={{ height: "100%", borderRadius: 2, background: s.color, width: `${total ? (s.value / total * 100) : 0}%`, opacity: 0.7 }} />
              </div>
              <div style={{ fontSize: 9, color: "#444", marginTop: 3 }}>{total ? (s.value / total * 100).toFixed(1) : 0}%</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniChart({ trades, w = 400 }) {
  if (!trades || trades.length === 0) return (
    <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 11 }}>Aucune donnée</div>
  );
  let cum = 0;
  const points = trades.map(t => { cum += t.pnl; return cum; });
  const min = Math.min(0, ...points), max = Math.max(0, ...points);
  const range = max - min || 1;
  const H = 64, PAD = 6;
  const innerW = w - PAD * 2, innerH = H - PAD * 2;
  const xs = points.map((_, i) => PAD + (i / Math.max(points.length - 1, 1)) * innerW);
  const ys = points.map(v => H - PAD - ((v - min) / range) * innerH);
  const zeroY = H - PAD - ((0 - min) / range) * innerH;
  const path = points.map((_, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const area = `${path} L${xs[xs.length - 1].toFixed(1)},${zeroY.toFixed(1)} L${xs[0].toFixed(1)},${zeroY.toFixed(1)} Z`;
  const color = points[points.length - 1] >= 0 ? "#34d399" : "#f87171";
  const uid = `g${w}${trades.length}`;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${H}`} style={{ display: "block" }}>
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={PAD} y1={zeroY} x2={w - PAD} y2={zeroY} stroke="rgba(255,255,255,0.05)" strokeDasharray="3,3" />
      <path d={area} fill={`url(#${uid})`} />
      <path d={path} stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FilterDropdown({ label, value, active, isOpen, onToggle, children }) {
  return (
    <div style={{ position: "relative" }}>
      <button onClick={onToggle} style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "7px 14px", borderRadius: 8,
        border: active ? "1px solid rgba(167,139,250,0.5)" : "1px solid rgba(255,255,255,0.1)",
        background: active ? "rgba(167,139,250,0.1)" : "rgba(255,255,255,0.03)",
        color: active ? "#a78bfa" : "#888", cursor: "pointer", fontSize: 12, fontWeight: 600,
        whiteSpace: "nowrap",
      }}>
        <span style={{ fontSize: 10, color: active ? "#a78bfa" : "#555", textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
        <span style={{ color: active ? "#c4b5fd" : "#aaa", fontWeight: 400, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis" }}>{value}</span>
        <span style={{ fontSize: 9, color: "#555" }}>{isOpen ? "▲" : "▼"}</span>
      </button>
      {isOpen && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, background: "#1a1a1e", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: 6, zIndex: 200, minWidth: "100%", maxHeight: 300, overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DropdownItem({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: "block", width: "100%", padding: "7px 12px", borderRadius: 7, border: "none",
      cursor: "pointer", fontSize: 12, fontWeight: active ? 700 : 400, textAlign: "left",
      background: active ? "rgba(167,139,250,0.2)" : "transparent",
      color: active ? "#c4b5fd" : "#888",
    }}>{label}</button>
  );
}

function CalendarView({ trades }) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState(null);
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const dayNames = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

  const pnlByDay = {};
  trades.forEach(t => {
    if (!t.date) return;
    pnlByDay[t.date] = pnlByDay[t.date] || { pnl: 0, count: 0 };
    pnlByDay[t.date].pnl += t.pnl;
    pnlByDay[t.date].count += 1;
  });

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  let startDow = firstDay.getDay();
  startDow = startDow === 0 ? 6 : startDow - 1;
  const days = [];
  for (let i = 0; i < startDow; i++) days.push({ date: new Date(year, month, -startDow + i + 1), current: false });
  for (let i = 1; i <= lastDay.getDate(); i++) days.push({ date: new Date(year, month, i), current: true });
  const rem = 7 - (days.length % 7);
  if (rem < 7) for (let i = 1; i <= rem; i++) days.push({ date: new Date(year, month + 1, i), current: false });
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const fd = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  const today = new Date();
  const isToday = (d) => d.toDateString() === today.toDateString();
  const monthPnl = Object.entries(pnlByDay).filter(([ds]) => {
    const [mm, , yyyy] = ds.split("/");
    return parseInt(mm) - 1 === month && parseInt(yyyy) === year;
  }).reduce((s, [, v]) => s + v.pnl, 0);
  const fp = (n) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setCurrentDate(new Date(year, month - 1, 1))} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "#aaa", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 14 }}>‹</button>
          <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 18, minWidth: 140, textAlign: "center" }}>{monthNames[month]} {year}</div>
          <button onClick={() => setCurrentDate(new Date(year, month + 1, 1))} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "#aaa", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 14 }}>›</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: monthPnl >= 0 ? "#34d399" : "#f87171" }}>P&L Mensuel : {fp(monthPnl)}</div>
          <button onClick={() => setCurrentDate(new Date())} style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", color: "#aaa", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>Aujourd'hui</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr) 140px", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, overflow: "hidden" }}>
        {dayNames.map(d => (
          <div key={d} style={{ padding: "8px 0", textAlign: "center", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "#555", background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>{d}</div>
        ))}
        <div style={{ padding: "8px 0", textAlign: "center", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "#555", background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.07)", borderLeft: "1px solid rgba(255,255,255,0.07)" }}>Semaine</div>
        {weeks.map((week, wi) => {
          const weekPnl = week.reduce((s, { date, current }) => { if (!current) return s; const v = pnlByDay[fd(date)]; return v ? s + v.pnl : s; }, 0);
          const weekTrades = week.reduce((s, { date, current }) => { if (!current) return s; const v = pnlByDay[fd(date)]; return v ? s + v.count : s; }, 0);
          return (
            <React.Fragment key={wi}>
              {week.map(({ date, current }, di) => {
                const key = fd(date);
                const data = pnlByDay[key];
                const hasData = current && data && data.count > 0;
                const pos = hasData && data.pnl >= 0;
                const tod = isToday(date);
                return (
                  <div key={di} onClick={() => hasData && setSelectedDay(key)} style={{ minHeight: 80, padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.05)", borderRight: di < 6 ? "1px solid rgba(255,255,255,0.05)" : "none", background: hasData ? (pos ? "rgba(52,211,153,0.07)" : "rgba(248,113,113,0.07)") : tod ? "rgba(255,255,255,0.04)" : "transparent", cursor: hasData ? "pointer" : "default" }}>
                    <div style={{ fontSize: 12, fontWeight: tod ? 700 : 400, color: tod ? "#fff" : current ? "#888" : "#333", display: "inline-flex", alignItems: "center", justifyContent: "center", width: tod ? 22 : "auto", height: tod ? 22 : "auto", borderRadius: tod ? "50%" : 0, background: tod ? "#60a5fa" : "transparent" }}>{date.getDate()}</div>
                    {hasData && (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: pos ? "#34d399" : "#f87171" }}>{fp(data.pnl)}</div>
                        <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{data.count} trade{data.count > 1 ? "s" : ""}</div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ minHeight: 80, padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.05)", borderLeft: "1px solid rgba(255,255,255,0.07)", background: weekTrades > 0 ? (weekPnl >= 0 ? "rgba(52,211,153,0.04)" : "rgba(248,113,113,0.04)") : "rgba(255,255,255,0.01)", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
                <div style={{ fontSize: 9, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Sem. {wi + 1}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: weekTrades > 0 ? (weekPnl >= 0 ? "#34d399" : "#f87171") : "#333", fontFamily: "'Syne', sans-serif" }}>{weekTrades > 0 ? fp(weekPnl) : "$0.00"}</div>
                <div style={{ fontSize: 10, color: "#444", marginTop: 3 }}>{weekTrades} trade{weekTrades !== 1 ? "s" : ""}</div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
      {selectedDay && (() => {
        const dayTrades = trades.filter(t => t.date === selectedDay).sort((a, b) => (a.boughtAt || "").localeCompare(b.boughtAt || ""));
        const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
        const pos = dayPnl >= 0;
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setSelectedDay(null)}>
            <div style={{ background: "#161618", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: 28, width: 560, maxWidth: "95vw", maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <div>
                  <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 18 }}>{selectedDay}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: pos ? "#34d399" : "#f87171", marginTop: 4 }}>{(pos ? "+" : "-") + "$" + Math.abs(dayPnl).toFixed(2)} · {dayTrades.length} trade{dayTrades.length > 1 ? "s" : ""}</div>
                </div>
                <button onClick={() => setSelectedDay(null)} style={{ background: "transparent", border: "none", color: "#555", cursor: "pointer", fontSize: 20 }}>✕</button>
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                      {["Heure", "Symbole", "Dir.", "Lot", "Durée", "Session", "P&L"].map((h, i) => (
                        <th key={h} style={{ padding: "6px 10px", textAlign: i === 6 ? "right" : "left", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "#444", fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dayTrades.map(t => (
                      <tr key={t.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        <td style={{ padding: "9px 10px", color: "#555", fontSize: 10 }}>{(t.boughtAt || "").split("T")[1]?.slice(0, 5) || "—"}</td>
                        <td style={{ padding: "9px 10px", fontWeight: 700, color: "#e0e0e0", fontFamily: "'Syne', sans-serif" }}>{t.symbol}</td>
                        <td style={{ padding: "9px 10px" }}><DirectionBadge d={t.direction} /></td>
                        <td style={{ padding: "9px 10px", color: "#888" }}>{t.lot || "—"}</td>
                        <td style={{ padding: "9px 10px", color: "#555", fontSize: 10 }}>{t.duration || "—"}</td>
                        <td style={{ padding: "9px 10px" }}>{t.category === "londres" ? <span style={{ color: "#60a5fa" }}>🇬🇧</span> : t.category === "us" ? <span style={{ color: "#f97316" }}>🇺🇸</span> : <span style={{ color: "#444" }}>—</span>}</td>
                        <td style={{ padding: "9px 10px", textAlign: "right" }}><PnlBadge pnl={t.pnl} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function FinancesTab({ trades, accountPayouts, accountChallenges, accountStatuses, accountTypes }) {
  const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const totalPayouts = Object.values(accountPayouts).reduce((s, v) => s + (v || 0), 0);
  const totalChallenges = Object.values(accountChallenges).reduce((s, v) => s + (v || 0), 0);
  const netResult = totalPayouts - totalChallenges;

  const accountNames = [...new Set(trades.map(t => t.account).filter(Boolean))].sort((a, b) => {
    const doneA = (accountStatuses[a] === "passed" || accountStatuses[a] === "failed") ? 1 : 0;
    const doneB = (accountStatuses[b] === "passed" || accountStatuses[b] === "failed") ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    const ord = { reel: 0, evaluation: 1 };
    return (ord[accountTypes[a]] ?? 2) - (ord[accountTypes[b]] ?? 2);
  });

  const tradeMonths = {};
  trades.forEach(t => {
    if (!t.date) return;
    const parts = t.date.split("/");
    if (parts.length < 3) return;
    const key = `${parts[2]}-${parts[0].padStart(2, "0")}`;
    if (!tradeMonths[key]) tradeMonths[key] = new Set();
    tradeMonths[key].add(t.account);
  });
  const monthKeys = Object.keys(tradeMonths).sort();

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 28 }}>
        <div style={{ background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 12, padding: "20px 24px" }}>
          <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "#fbbf24", marginBottom: 8 }}>💸 Total Payouts</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#fbbf24", fontFamily: "'Syne', sans-serif" }}>{fmtAbs(totalPayouts)}</div>
        </div>
        <div style={{ background: "rgba(167,139,250,0.05)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 12, padding: "20px 24px" }}>
          <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "#a78bfa", marginBottom: 8 }}>🪙 Coût Challenges</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#a78bfa", fontFamily: "'Syne', sans-serif" }}>-{fmtAbs(totalChallenges)}</div>
        </div>
        <div style={{ background: netResult >= 0 ? "rgba(52,211,153,0.05)" : "rgba(248,113,113,0.05)", border: `1px solid ${netResult >= 0 ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)"}`, borderRadius: 12, padding: "20px 24px" }}>
          <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: netResult >= 0 ? "#34d399" : "#f87171", marginBottom: 8 }}>📊 Résultat Net</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: netResult >= 0 ? "#34d399" : "#f87171", fontFamily: "'Syne', sans-serif" }}>{netResult >= 0 ? "+" : ""}{fmtAbs(netResult)}</div>
        </div>
      </div>
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "#555", marginBottom: 16 }}>Par Mois</div>
        {monthKeys.length === 0 ? <div style={{ color: "#333", fontSize: 12 }}>Aucune donnée</div> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                {["Mois", "Payouts", "Challenges", "Net"].map((h, i) => (
                  <th key={h} style={{ padding: "6px 12px", textAlign: i > 0 ? "right" : "left", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "#444", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthKeys.map(key => {
                const [yyyy, mm] = key.split("-");
                const label = `${monthNames[parseInt(mm) - 1]} ${yyyy}`;
                const accs = [...tradeMonths[key]];
                const mp = accs.reduce((s, a) => s + (accountPayouts[a] || 0), 0);
                const mc = accs.reduce((s, a) => s + (accountChallenges[a] || 0), 0);
                const net = mp - mc;
                return (
                  <tr key={key} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td style={{ padding: "10px 12px", color: "#aaa", fontWeight: 600 }}>{label}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "#fbbf24" }}>{mp > 0 ? `+${fmtAbs(mp)}` : "—"}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "#a78bfa" }}>{mc > 0 ? `-${fmtAbs(mc)}` : "—"}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: net >= 0 ? "#34d399" : "#f87171" }}>{net !== 0 ? `${net >= 0 ? "+" : ""}${fmtAbs(net)}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid rgba(255,255,255,0.1)" }}>
                <td style={{ padding: "12px 12px", color: "#666", fontWeight: 700, fontSize: 11 }}>Total</td>
                <td style={{ padding: "12px 12px", textAlign: "right", color: "#fbbf24", fontWeight: 700 }}>{totalPayouts > 0 ? `+${fmtAbs(totalPayouts)}` : "—"}</td>
                <td style={{ padding: "12px 12px", textAlign: "right", color: "#a78bfa", fontWeight: 700 }}>{totalChallenges > 0 ? `-${fmtAbs(totalChallenges)}` : "—"}</td>
                <td style={{ padding: "12px 12px", textAlign: "right", fontWeight: 800, fontSize: 14, color: (totalPayouts - totalChallenges) >= 0 ? "#34d399" : "#f87171", fontFamily: "'Syne', sans-serif" }}>{(totalPayouts - totalChallenges) >= 0 ? "+" : ""}{fmtAbs(totalPayouts - totalChallenges)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "#555", marginBottom: 16 }}>Détail par Compte</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
              {["Compte", "1er Trade", "Payout", "Challenge", "Net"].map((h, i) => (
                <th key={h} style={{ padding: "6px 12px", textAlign: i > 0 ? "right" : "left", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "#444", fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accountNames.map(acc => {
              const accTrades = trades.filter(t => t.account === acc).sort((a, b) => (a.soldAt || "").localeCompare(b.soldAt || ""));
              const firstDate = accTrades[0]?.date || "—";
              const payout = accountPayouts[acc] || 0;
              const challenge = accountChallenges[acc] || 0;
              const net = payout - challenge;
              return (
                <tr key={acc} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{ color: "#a78bfa", fontWeight: 600 }}>{acc}</span>
                    {accountStatuses[acc] === "passed" && <span style={{ marginLeft: 6, fontSize: 10, color: "#34d399", fontWeight: 700 }}>✅ PASSED</span>}
                    {accountStatuses[acc] === "failed" && <span style={{ marginLeft: 6, fontSize: 10, color: "#f87171", fontWeight: 700 }}>❌ FAILED</span>}
                  </td>
                  <td style={{ padding: "10px 12px", color: "#555", textAlign: "right", fontSize: 11 }}>{firstDate}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#fbbf24" }}>{payout > 0 ? `+${fmtAbs(payout)}` : "—"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#a78bfa" }}>{challenge > 0 ? `-${fmtAbs(challenge)}` : "—"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: net >= 0 ? "#34d399" : "#f87171" }}>{net !== 0 ? `${net >= 0 ? "+" : ""}${fmtAbs(net)}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────
export default function TradingJournal() {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("dashboard");
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState(null);
  const [filterAccount, setFilterAccount] = useState("ALL");
  const [filterCat, setFilterCat] = useState("ALL");
  const [filterOpen, setFilterOpen] = useState(null);
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingImport, setPendingImport] = useState(null);
  const [editingAccountName, setEditingAccountName] = useState("");
  const [renameModal, setRenameModal] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [sortCol, setSortCol] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [accountStatuses, setAccountStatuses] = useState({});
  const [accountPayouts, setAccountPayouts] = useState({});
  const [accountChallenges, setAccountChallenges] = useState({});
  const [accountSizes, setAccountSizes] = useState({});
  const [accountTypes, setAccountTypes] = useState({});
  const [statusModal, setStatusModal] = useState(null);
  const [payoutModal, setPayoutModal] = useState(null);
  const [payoutValue, setPayoutValue] = useState("");
  const [challengeMenu, setChallengeMenu] = useState(null);
  const [sizeMenu, setSizeMenu] = useState(null);
  const [typeMenu, setTypeMenu] = useState(null);
  const [hideAmounts, setHideAmounts] = useState(false);
  const [scalpOff, setScalpOff] = useState({});

  useEffect(() => {
    Promise.all([loadTrades(), load(SK_STATUS), load(SK_PAYOUT), load(SK_CHALL), load(SK_SIZE), load(SK_TYPE), load(SK_SCALP_OFF)])
      .then(([t, st, py, ch, sz, ty, so]) => {
        setTrades(t); setAccountStatuses(st); setAccountPayouts(py);
        setAccountChallenges(ch); setAccountSizes(sz); setAccountTypes(ty); setScalpOff(so);
        setLoading(false);
      });
  }, []);

  const showToast = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3000); };
  const closeMenus = () => { setSizeMenu(null); setTypeMenu(null); setChallengeMenu(null); setFilterOpen(null); };

  const handleFile = useCallback((file) => {
    if (!file) return;
    const name = file.name.replace(/\.csv$/i, "");
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCSV(e.target.result, name);
      if (!parsed.length) { showToast("Aucun trade trouvé.", false); return; }
      setPendingImport({ trades: parsed, fileName: name });
      setEditingAccountName(name);
    };
    reader.readAsText(file);
  }, []);

  const confirmImport = () => {
    if (!pendingImport) return;
    const accountName = editingAccountName.trim() || pendingImport.fileName;
    const withAccount = pendingImport.trades.map(t => ({ ...t, account: accountName }));
    setTrades(prev => {
      const existingIds = new Set(prev.map(t => t.id));
      const newOnes = withAccount.filter(t => !existingIds.has(t.id));
      const merged = [...prev, ...newOnes].sort((a, b) => (a.soldAt || "").localeCompare(b.soldAt || ""));
      saveTrades(merged);
      showToast(`${newOnes.length} trade(s) importé(s) dans "${accountName}".`);
      return merged;
    });
    setPendingImport(null);
  };

  const handleDrop = (e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); };

  const updateCategory = useCallback((id, cat) => {
    setTrades(prev => { const u = prev.map(t => t.id === id ? { ...t, category: cat } : t); saveTrades(u); return u; });
  }, []);

  const openRename = (name) => { setRenameModal({ oldName: name }); setRenameValue(name); };
  const applyRename = () => {
    if (!renameModal) return;
    const newName = renameValue.trim();
    if (!newName) return;
    setTrades(prev => { const u = prev.map(t => t.account === renameModal.oldName ? { ...t, account: newName } : t); saveTrades(u); return u; });
    if (filterAccount === renameModal.oldName) setFilterAccount(newName);
    setRenameModal(null);
    showToast(`Compte renommé en "${newName}".`);
  };

  const deleteAccount = (name) => {
    setTrades(prev => { const u = prev.filter(t => t.account !== name); saveTrades(u); return u; });
    if (filterAccount === name) setFilterAccount("ALL");
    setConfirmDelete(null);
    showToast(`Compte "${name}" supprimé.`);
  };

  const setAccountStatus = async (name, status) => {
    const updated = { ...accountStatuses, [name]: status };
    setAccountStatuses(updated); await save(SK_STATUS, updated);
    setStatusModal(null);
    showToast(`"${name}" marqué ${status === "passed" ? "✅ PASSED" : "❌ FAILED"}.`);
  };

  const resetAccountStatus = async (name) => {
    const updated = { ...accountStatuses };
    delete updated[name];
    setAccountStatuses(updated); await save(SK_STATUS, updated); setStatusModal(null);
  };

  const applyPayout = async () => {
    if (!payoutModal) return;
    const amount = parseFloat(payoutValue.replace(",", ".")) || 0;
    if (!amount) return;
    const updated = { ...accountPayouts, [payoutModal]: (accountPayouts[payoutModal] || 0) + amount };
    setAccountPayouts(updated); await save(SK_PAYOUT, updated);
    setPayoutModal(null); setPayoutValue("");
    showToast(`Payout de ${fmtAbs(amount)} enregistré.`);
  };

  const resetPayout = async (name) => {
    const updated = { ...accountPayouts };
    delete updated[name];
    setAccountPayouts(updated); await save(SK_PAYOUT, updated);
    setPayoutModal(null); setPayoutValue("");
    showToast("Payout réinitialisé.");
  };

  const setChallengePrice = async (name, amount) => {
    const updated = { ...accountChallenges, [name]: amount };
    setAccountChallenges(updated); await save(SK_CHALL, updated);
    setChallengeMenu(null);
    showToast(`Challenge ${fmtAbs(amount)} enregistré.`);
  };

  const resetChallenge = async (name) => {
    const updated = { ...accountChallenges };
    delete updated[name];
    setAccountChallenges(updated); await save(SK_CHALL, updated); setChallengeMenu(null);
  };

  const setAccountType = async (name, type) => {
    const updated = { ...accountTypes, [name]: type };
    setAccountTypes(updated); await save(SK_TYPE, updated); setTypeMenu(null);
  };

  const setAccountSize = async (name, size) => {
    const updated = { ...accountSizes, [name]: size };
    setAccountSizes(updated); await save(SK_SIZE, updated); setSizeMenu(null);
  };

  const clearAll = async () => { setTrades([]); await saveTrades([]); setConfirmClear(false); showToast("Journal réinitialisé."); };

  const toggleScalpOff = async (id) => {
    const updated = { ...scalpOff, [id]: !scalpOff[id] };
    if (!updated[id]) delete updated[id];
    setScalpOff(updated); await save(SK_SCALP_OFF, updated);
  };

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  const sortAccounts = (a, b) => {
    const doneA = (accountStatuses[a] === "passed" || accountStatuses[a] === "failed") ? 1 : 0;
    const doneB = (accountStatuses[b] === "passed" || accountStatuses[b] === "failed") ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    const ord = { reel: 0, evaluation: 1 };
    return (ord[accountTypes[a]] ?? 2) - (ord[accountTypes[b]] ?? 2);
  };

  const accounts = ["ALL", ...new Set(trades.map(t => t.account).filter(Boolean))];

  const filtered = trades.filter(t => {
    const matchAcc = filterAccount === "ALL" || t.account === filterAccount;
    const matchCat = filterCat === "ALL" || (filterCat === "none" ? !t.category : t.category === filterCat);
    const matchType = typeFilter === "ALL" || accountTypes[t.account] === typeFilter;
    const isDone = accountStatuses[t.account] === "passed" || accountStatuses[t.account] === "failed";
    const notExcluded = filterAccount !== "ALL" || !isDone;
    return matchAcc && matchCat && matchType && notExcluded;
  });

  const sortedTrades = [...filtered].sort((a, b) => {
    let va, vb;
    if (sortCol === "date") { va = a.soldAt || ""; vb = b.soldAt || ""; }
    else if (sortCol === "pnl") { va = a.pnl; vb = b.pnl; }
    else if (sortCol === "lot") { va = a.lot || 0; vb = b.lot || 0; }
    else if (sortCol === "scalp") { va = (isScalp(a.duration) && !scalpOff[a.id]) ? 1 : 0; vb = (isScalp(b.duration) && !scalpOff[b.id]) ? 1 : 0; }
    else if (sortCol === "be") { va = Math.abs(a.pnl) <= 5 ? 1 : 0; vb = Math.abs(b.pnl) <= 5 ? 1 : 0; }
    else { va = (a[sortCol] || "").toString(); vb = (b[sortCol] || "").toString(); }
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const stats = calcStats(filtered);
  const byDay = {};
  filtered.forEach(t => { byDay[t.date] = (byDay[t.date] || 0) + t.pnl; });
  const daysSorted = Object.keys(byDay).sort();
  const maxDayAbs = Math.max(...Object.values(byDay).map(Math.abs), 1);

  const accountNames = [...new Set(trades.map(t => t.account).filter(Boolean))].sort(sortAccounts);
  const accountStats = accountNames.map(a => {
    const at = trades.filter(t => t.account === a);
    return { name: a, count: at.length, trades: at, ...calcStats(at) };
  });

  const totalPayouts = Object.values(accountPayouts).reduce((s, v) => s + (v || 0), 0);
  const totalChallenges = Object.values(accountChallenges).reduce((s, v) => s + (v || 0), 0);

  const chip = (active) => ({
    padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600,
    border: "1px solid rgba(255,255,255,0.09)", cursor: "pointer",
    background: active ? "rgba(255,255,255,0.1)" : "transparent",
    color: active ? "#f0f0f0" : "#555",
  });

  const tabBtn = (t) => ({
    padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600,
    letterSpacing: 0.4, border: "none",
    background: tab === t ? "rgba(255,255,255,0.1)" : "transparent",
    color: tab === t ? "#f0f0f0" : "#555", transition: "all .2s",
  });

  const thStyle = (col) => ({
    padding: "8px 10px", textAlign: "left", fontSize: 9, letterSpacing: 1.5,
    textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap",
    cursor: col ? "pointer" : "default",
    color: col && sortCol === col ? "#a78bfa" : "#444",
    userSelect: "none",
  });

  const menuStyle = { position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#1a1a1e", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 4, zIndex: 50, minWidth: 100 };
  const menuBtn = (active) => ({ display: "block", width: "100%", padding: "5px 10px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, textAlign: "left", background: active ? "rgba(255,255,255,0.1)" : "transparent", color: active ? "#f0f0f0" : "#888" });

  const TABS = [
    { id: "dashboard",   label: "📊 Dashboard" },
    { id: "comptes",     label: "🏦 Comptes" },
    { id: "calendrier",  label: "📅 Calendrier" },
    { id: "finances",    label: "💰 Finances" },
    { id: "journal",     label: "📋 Journal" },
    { id: "calculette",  label: "🧮 Calculette" },
    { id: "import",      label: "⬆️ Import" },
  ];

  if (loading) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0c0c0f", color: "#444" }}>Chargement…</div>;

  return (
    <div style={{ minHeight: "100vh", background: "#0c0c0f", color: "#e0e0e0", fontFamily: "'DM Sans', sans-serif" }} onClick={closeMenus}>
      <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&family=Bebas+Neue&display=swap" rel="stylesheet" />

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 999, padding: "10px 18px", borderRadius: 10,
          background: toast.ok ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)",
          border: `1px solid ${toast.ok ? "rgba(52,211,153,0.4)" : "rgba(248,113,113,0.4)"}`,
          color: toast.ok ? "#34d399" : "#f87171", fontSize: 12, fontWeight: 600 }}>
          {toast.msg}
        </div>
      )}

      {/* RENAME MODAL */}
      {renameModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#161618", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 28, width: 340 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 16 }}>Renommer le compte</div>
            <input value={renameValue} onChange={e => setRenameValue(e.target.value)} onKeyDown={e => e.key === "Enter" && applyRename()} autoFocus
              style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", color: "#f0f0f0", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
              <button onClick={() => setRenameModal(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #333", background: "transparent", color: "#888", cursor: "pointer", fontSize: 12 }}>Annuler</button>
              <button onClick={applyRename} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#a78bfa", color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Renommer</button>
            </div>
          </div>
        </div>
      )}

      {/* IMPORT CONFIRM MODAL */}
      {pendingImport && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#161618", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 28, width: 380 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Confirmer l&#39;import</div>
            <div style={{ color: "#555", fontSize: 12, marginBottom: 20 }}>{pendingImport.trades.length} trades détectés</div>
            <div style={{ fontSize: 10, color: "#555", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>Nom du compte</div>
            <input value={editingAccountName} onChange={e => setEditingAccountName(e.target.value)} autoFocus
              style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", color: "#f0f0f0", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
              <button onClick={() => setPendingImport(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #333", background: "transparent", color: "#888", cursor: "pointer", fontSize: 12 }}>Annuler</button>
              <button onClick={confirmImport} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#34d399", color: "#000", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Importer</button>
            </div>
          </div>
        </div>
      )}

      {/* STATUS MODAL */}
      {statusModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#161618", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 28, width: 320, textAlign: "center" }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Statut du compte</div>
            <div style={{ color: "#555", fontSize: 12, marginBottom: 24 }}>{statusModal}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 16 }}>
              <button onClick={() => setAccountStatus(statusModal, "passed")} style={{ padding: "10px 24px", borderRadius: 10, border: "1px solid rgba(52,211,153,0.4)", background: "rgba(52,211,153,0.1)", color: "#34d399", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>✅ PASSED</button>
              <button onClick={() => setAccountStatus(statusModal, "failed")} style={{ padding: "10px 24px", borderRadius: 10, border: "1px solid rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.1)", color: "#f87171", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>❌ FAILED</button>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={() => setStatusModal(null)} style={{ background: "transparent", border: "none", color: "#444", cursor: "pointer", fontSize: 12 }}>Annuler</button>
              {accountStatuses[statusModal] && (
                <button onClick={() => resetAccountStatus(statusModal)} style={{ background: "transparent", border: "none", color: "#f87171", cursor: "pointer", fontSize: 12 }}>↺ Réinitialiser</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PAYOUT MODAL */}
      {payoutModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#161618", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 28, width: 340 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>💸 Payout</div>
            <div style={{ color: "#555", fontSize: 12, marginBottom: 12 }}>{payoutModal}</div>
            {(accountPayouts[payoutModal] || 0) > 0 && (
              <div style={{ fontSize: 12, color: "#fbbf24", marginBottom: 12, padding: "8px 12px", background: "rgba(251,191,36,0.08)", borderRadius: 8 }}>
                Total déjà retiré : {fmtAbs(accountPayouts[payoutModal])}
              </div>
            )}
            <div style={{ fontSize: 10, color: "#555", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>Montant ($)</div>
            <input value={payoutValue} onChange={e => setPayoutValue(e.target.value)} onKeyDown={e => e.key === "Enter" && applyPayout()} autoFocus placeholder="ex: 500"
              style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", color: "#f0f0f0", fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
              <button onClick={() => { setPayoutModal(null); setPayoutValue(""); }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #333", background: "transparent", color: "#888", cursor: "pointer", fontSize: 12 }}>Annuler</button>
              {(accountPayouts[payoutModal] || 0) > 0 && (
                <button onClick={() => resetPayout(payoutModal)} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(248,113,113,0.3)", background: "transparent", color: "#f87171", cursor: "pointer", fontSize: 12 }}>↺ Reset</button>
              )}
              <button onClick={applyPayout} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#fbbf24", color: "#000", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Valider</button>
            </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 19, letterSpacing: -0.5 }}>◈ TRADING JOURNAL</div>
          <div style={{ fontSize: 10, color: "#444", marginTop: 2, letterSpacing: 1 }}>{trades.length} TRADES · {accountNames.length} COMPTE(S)</div>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              ...tabBtn(t.id),
              ...(t.id === "calculette" && tab === "calculette" ? { background: "rgba(245,200,66,0.15)", color: "#f5c842", border: "1px solid rgba(245,200,66,0.25)" } : {}),
            }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "22px 28px", maxWidth: 1300, margin: "0 auto" }}>

        {/* FILTERS */}
        {(tab === "dashboard" || tab === "journal" || tab === "calendrier") && (
          <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center" }} onClick={e => e.stopPropagation()}>
            <FilterDropdown label="🏷️ Type" value={typeFilter === "ALL" ? "Tous" : typeFilter === "evaluation" ? "📋 Eval." : "💼 Réel"} active={typeFilter !== "ALL"} isOpen={filterOpen === "type"} onToggle={() => setFilterOpen(o => o === "type" ? null : "type")}>
              {[["ALL", "Tous"], ["evaluation", "📋 Eval."], ["reel", "💼 Réel"]].map(([val, label]) => (
                <DropdownItem key={val} label={label} active={typeFilter === val} onClick={() => { setTypeFilter(val); setFilterAccount("ALL"); setFilterOpen(null); }} />
              ))}
            </FilterDropdown>
            <FilterDropdown label="🏦 Compte" value={filterAccount === "ALL" ? "Tous" : filterAccount} active={filterAccount !== "ALL"} isOpen={filterOpen === "compte"} onToggle={() => setFilterOpen(o => o === "compte" ? null : "compte")}>
              {accounts.filter(a => a === "ALL" || typeFilter === "ALL" || accountTypes[a] === typeFilter).map(a => (
                <DropdownItem key={a} label={a === "ALL" ? "Tous" : a} active={filterAccount === a} onClick={() => { setFilterAccount(a); setFilterOpen(null); }} />
              ))}
            </FilterDropdown>
            <FilterDropdown label="🕐 Session" value={filterCat === "ALL" ? "Toutes" : filterCat === "none" ? "Non classé" : CAT[filterCat].flag + " " + CAT[filterCat].label} active={filterCat !== "ALL"} isOpen={filterOpen === "session"} onToggle={() => setFilterOpen(o => o === "session" ? null : "session")}>
              {["ALL", "londres", "us", "none"].map(c => (
                <DropdownItem key={c} label={c === "ALL" ? "Toutes" : c === "none" ? "Non classé" : CAT[c].flag + " " + CAT[c].label} active={filterCat === c} onClick={() => { setFilterCat(c); setFilterOpen(null); }} />
              ))}
            </FilterDropdown>
          </div>
        )}

        {/* ── CALCULETTE TAB ── */}
        {tab === "calculette" && <LotCalcTab />}

        {/* DASHBOARD */}
        {tab === "dashboard" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 10, marginBottom: 16 }}>
              <StatCard label="P&L Total" value={fmtAbs(stats.total)} accent={stats.total >= 0 ? "#34d399" : "#f87171"} sub={`${filtered.length} trades`} />
              <StatCard label="Win Rate" value={`${stats.winRate}%`} sub={`${stats.winners.length}W / ${stats.losers.length}L (hors BE)`} accent="#a78bfa" />
              <StatCard label="🟰 Breakeven" value={filtered.length ? `${(stats.be.length / filtered.length * 100).toFixed(1)}%` : "—"} sub={`${stats.be.length} trade${stats.be.length !== 1 ? "s" : ""} (±$5)`} accent="#94a3b8" />
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14 }}>
                <PieChart winners={stats.winners.length} losers={stats.losers.length} be={stats.be.length} compact />
              </div>
              <StatCard label="Profit Factor" value={stats.pf} accent="#fbbf24" sub="< 1 perdant · 1-1.5 correct · > 2 excellent" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div style={{ background: "rgba(52,211,153,0.05)", border: "1px solid rgba(52,211,153,0.15)", borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontSize: 10, color: "#34d399", marginBottom: 10, opacity: 0.7, textTransform: "uppercase", letterSpacing: 2 }}>▲ Long — {stats.longs.length} trades</div>
                <div style={{ display: "flex", gap: 24 }}>
                  <div><div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>P&L</div><div style={{ fontSize: 18, fontWeight: 700, color: stats.longPnl >= 0 ? "#34d399" : "#f87171", fontFamily: "'Syne', sans-serif" }}>{fmtAbs(stats.longPnl)}</div></div>
                  <div><div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>Win Rate</div><div style={{ fontSize: 18, fontWeight: 700, color: "#34d399", fontFamily: "'Syne', sans-serif" }}>{stats.longWr}%</div></div>
                </div>
              </div>
              <div style={{ background: "rgba(248,113,113,0.05)", border: "1px solid rgba(248,113,113,0.15)", borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontSize: 10, color: "#f87171", marginBottom: 10, opacity: 0.7, textTransform: "uppercase", letterSpacing: 2 }}>▼ Short — {stats.shorts.length} trades</div>
                <div style={{ display: "flex", gap: 24 }}>
                  <div><div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>P&L</div><div style={{ fontSize: 18, fontWeight: 700, color: stats.shortPnl >= 0 ? "#34d399" : "#f87171", fontFamily: "'Syne', sans-serif" }}>{fmtAbs(stats.shortPnl)}</div></div>
                  <div><div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>Win Rate</div><div style={{ fontSize: 18, fontWeight: 700, color: "#f87171", fontFamily: "'Syne', sans-serif" }}>{stats.shortWr}%</div></div>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 18 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#444", marginBottom: 10 }}>P&L Cumulé</div>
                <MiniChart trades={filtered} w={500} />
              </div>
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 18 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#444", marginBottom: 10 }}>Par Jour</div>
                {daysSorted.length === 0 ? <div style={{ color: "#333", fontSize: 11 }}>Aucune donnée</div> :
                  daysSorted.map(d => {
                    const v = byDay[d]; const pos = v >= 0;
                    return (
                      <div key={d} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 10, color: "#555", width: 85, flexShrink: 0 }}>{d}</span>
                        <div style={{ flex: 1, background: "rgba(255,255,255,0.04)", borderRadius: 3, height: 5 }}>
                          <div style={{ height: "100%", borderRadius: 3, background: pos ? "#34d399" : "#f87171", width: `${Math.abs(v) / maxDayAbs * 100}%` }} />
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, color: pos ? "#34d399" : "#f87171", minWidth: 72, textAlign: "right" }}>{fmtMoney(v)}</span>
                      </div>
                    );
                  })
                }
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#34d399", marginBottom: 10, opacity: 0.7 }}>🏆 Meilleur</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#34d399", fontFamily: "'Syne', sans-serif" }}>{stats.best ? fmtAbs(stats.best.pnl) : "—"}</div>
                  <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>{stats.best?.symbol || ""}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#f87171", marginBottom: 10, opacity: 0.7 }}>💀 Pire</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#f87171", fontFamily: "'Syne', sans-serif" }}>{stats.worst ? fmtAbs(stats.worst.pnl) : "—"}</div>
                  <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>{stats.worst?.symbol || ""}</div>
                </div>
              </div>
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 18 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#444", marginBottom: 14 }}>⚡ Scalping (&lt; 2 min)</div>
                {(() => {
                  const scalps = filtered.filter(t => isScalp(t.duration) && !scalpOff[t.id]);
                  const scalpsW = scalps.filter(t => t.pnl > 5);
                  const scalpsL = scalps.filter(t => t.pnl < -5);
                  const scalpPnl = scalps.reduce((s, t) => s + t.pnl, 0);
                  const scalpWr = scalps.filter(t => Math.abs(t.pnl) > 5).length ? (scalpsW.length / scalps.filter(t => Math.abs(t.pnl) > 5).length * 100).toFixed(1) : "—";
                  return (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div><div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Trades</div><div style={{ fontSize: 22, fontWeight: 700, color: "#fbbf24", fontFamily: "'Syne', sans-serif" }}>{scalps.length}</div></div>
                      <div><div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>P&L</div><div style={{ fontSize: 22, fontWeight: 700, color: scalpPnl >= 0 ? "#34d399" : "#f87171", fontFamily: "'Syne', sans-serif" }}>{fmtAbs(scalpPnl)}</div></div>
                      <div><div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Win Rate</div><div style={{ fontSize: 22, fontWeight: 700, color: "#a78bfa", fontFamily: "'Syne', sans-serif" }}>{scalpWr}%</div></div>
                      <div><div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>W / L</div><div style={{ fontSize: 16, fontWeight: 700, color: "#888", fontFamily: "'Syne', sans-serif" }}>{scalpsW.length}<span style={{ color: "#444" }}> / </span>{scalpsL.length}</div></div>
                    </div>
                  );
                })()}
              </div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#444" }}>Finances</div>
                <button onClick={() => setHideAmounts(h => !h)} style={{ padding: "3px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#666", cursor: "pointer", fontSize: 11 }}>{hideAmounts ? "👁 Afficher" : "🙈 Masquer"}</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <div style={{ background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 10, color: "#fbbf24", marginBottom: 4 }}>💸 Payouts</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#fbbf24", fontFamily: "'Syne', sans-serif" }}>{hideAmounts ? "••••••" : fmtAbs(totalPayouts)}</div>
                </div>
                <div style={{ background: "rgba(167,139,250,0.05)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 10, color: "#a78bfa", marginBottom: 4 }}>🪙 Challenges</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#a78bfa", fontFamily: "'Syne', sans-serif" }}>{hideAmounts ? "••••••" : `-${fmtAbs(totalChallenges)}`}</div>
                </div>
                <div style={{ background: (totalPayouts - totalChallenges) >= 0 ? "rgba(52,211,153,0.05)" : "rgba(248,113,113,0.05)", border: `1px solid ${(totalPayouts - totalChallenges) >= 0 ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)"}`, borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 10, color: (totalPayouts - totalChallenges) >= 0 ? "#34d399" : "#f87171", marginBottom: 4 }}>📊 Net</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: (totalPayouts - totalChallenges) >= 0 ? "#34d399" : "#f87171", fontFamily: "'Syne', sans-serif" }}>{hideAmounts ? "••••••" : `${(totalPayouts - totalChallenges) >= 0 ? "+" : ""}${fmtAbs(totalPayouts - totalChallenges)}`}</div>
                </div>
              </div>
            </div>
            {filtered.length === 0 && <div style={{ textAlign: "center", color: "#333", padding: 60, fontSize: 13 }}>Importez un fichier CSV pour commencer.</div>}
          </>
        )}

        {/* COMPTES */}
        {tab === "comptes" && (
          <div>
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {[["ALL", "Tous"], ["evaluation", "📋 Eval."], ["reel", "💼 Réel"]].map(([val, label]) => (
                <button key={val} onClick={() => setTypeFilter(val)} style={chip(typeFilter === val)}>{label}</button>
              ))}
            </div>
            {accountStats.length === 0 ? <div style={{ textAlign: "center", color: "#333", padding: 60, fontSize: 13 }}>Aucun compte.</div> : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
                {accountStats.filter(a => typeFilter === "ALL" || accountTypes[a.name] === typeFilter).map(a => {
                  const status = accountStatuses[a.name];
                  const payout = accountPayouts[a.name] || 0;
                  const challenge = accountChallenges[a.name] || 0;
                  const size = accountSizes[a.name];
                  const atype = accountTypes[a.name];
                  return (
                    <div key={a.name} style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${status === "passed" ? "rgba(52,211,153,0.3)" : status === "failed" ? "rgba(248,113,113,0.25)" : "rgba(255,255,255,0.08)"}`, borderRadius: 14, padding: 20, position: "relative", overflow: "hidden" }}>
                      {status && (
                        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 1 }}>
                          <div style={{ transform: "rotate(-35deg)", fontSize: 48, fontWeight: 800, fontFamily: "'Syne', sans-serif", letterSpacing: 4, color: status === "passed" ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)", border: `3px solid ${status === "passed" ? "rgba(52,211,153,0.18)" : "rgba(248,113,113,0.18)"}`, padding: "6px 18px", borderRadius: 6, whiteSpace: "nowrap", userSelect: "none" }}>
                            {status === "passed" ? "PASSED" : "FAILED"}
                          </div>
                        </div>
                      )}
                      <div style={{ position: "relative", zIndex: 2 }}>
                        {confirmDelete === a.name ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                            <span style={{ fontSize: 11, color: "#f87171", flex: 1 }}>Supprimer tous les trades ?</span>
                            <button onClick={() => deleteAccount(a.name)} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 5, border: "none", background: "#f87171", color: "#fff", cursor: "pointer", fontWeight: 700 }}>Oui</button>
                            <button onClick={() => setConfirmDelete(null)} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 5, border: "1px solid #333", background: "transparent", color: "#888", cursor: "pointer" }}>Non</button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 15, color: "#a78bfa", flex: 1 }}>{a.name}</div>
                            <button onClick={() => openRename(a.name)} style={{ padding: "4px 7px", borderRadius: 6, border: "1px solid rgba(167,139,250,0.2)", background: "transparent", color: "#a78bfa", cursor: "pointer", fontSize: 13 }}>✏️</button>
                            <button onClick={() => setConfirmDelete(a.name)} style={{ padding: "4px 7px", borderRadius: 6, border: "1px solid rgba(248,113,113,0.2)", background: "transparent", color: "#f87171", cursor: "pointer", fontSize: 13 }}>🗑</button>
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }} onClick={e => e.stopPropagation()}>
                          <div style={{ position: "relative" }}>
                            <button onClick={() => { setSizeMenu(sizeMenu === a.name ? null : a.name); setTypeMenu(null); setChallengeMenu(null); }} style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid rgba(96,165,250,0.3)", background: size ? "rgba(96,165,250,0.1)" : "transparent", color: "#60a5fa", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                              {size || "💼 Taille"}
                            </button>
                            {sizeMenu === a.name && (
                              <div style={menuStyle}>
                                {["25K$", "50K$", "100K$", "150K$", "300K$"].map(s => (
                                  <button key={s} onClick={() => setAccountSize(a.name, s)} style={menuBtn(size === s)}>{s}</button>
                                ))}
                              </div>
                            )}
                          </div>
                          <div style={{ position: "relative" }}>
                            <button onClick={() => { setTypeMenu(typeMenu === a.name ? null : a.name); setSizeMenu(null); setChallengeMenu(null); }} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${atype === "evaluation" ? "rgba(251,191,36,0.3)" : atype === "reel" ? "rgba(52,211,153,0.3)" : "rgba(255,255,255,0.1)"}`, background: atype === "evaluation" ? "rgba(251,191,36,0.1)" : atype === "reel" ? "rgba(52,211,153,0.1)" : "transparent", color: atype === "evaluation" ? "#fbbf24" : atype === "reel" ? "#34d399" : "#888", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                              {atype === "evaluation" ? "📋 Eval." : atype === "reel" ? "💼 Réel" : "🏷️ Type"}
                            </button>
                            {typeMenu === a.name && (
                              <div style={menuStyle}>
                                {[["evaluation", "📋 Evaluation"], ["reel", "💼 Réel"]].map(([val, label]) => (
                                  <button key={val} onClick={() => setAccountType(a.name, val)} style={menuBtn(atype === val)}>{label}</button>
                                ))}
                              </div>
                            )}
                          </div>
                          <button onClick={() => { setPayoutModal(a.name); setPayoutValue(""); }} style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid rgba(251,191,36,0.3)", background: payout > 0 ? "rgba(251,191,36,0.1)" : "transparent", color: "#fbbf24", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                            💸 {payout > 0 ? fmtAbs(payout) : "Payout"}
                          </button>
                          <button onClick={() => setStatusModal(a.name)} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${status === "passed" ? "rgba(52,211,153,0.3)" : status === "failed" ? "rgba(248,113,113,0.3)" : "rgba(255,255,255,0.1)"}`, background: "transparent", color: status === "passed" ? "#34d399" : status === "failed" ? "#f87171" : "#888", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                            🏁 {status === "passed" ? "PASSED" : status === "failed" ? "FAILED" : "Statut"}
                          </button>
                          <div style={{ position: "relative" }}>
                            <button onClick={() => { setChallengeMenu(challengeMenu === a.name ? null : a.name); setSizeMenu(null); setTypeMenu(null); }} style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid rgba(167,139,250,0.2)", background: challenge ? "rgba(167,139,250,0.1)" : "transparent", color: "#a78bfa", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                              {challenge ? `🪙 $${challenge}` : "🪙 Challenge"}
                            </button>
                            {challengeMenu === a.name && (
                              <div style={{ ...menuStyle, minWidth: 130 }}>
                                {[49, 99, 149, 199, 299, 399].map(price => (
                                  <button key={price} onClick={() => setChallengePrice(a.name, price)} style={menuBtn(challenge === price)}>${price}</button>
                                ))}
                                <div style={{ borderTop: "1px solid rgba(255,255,255,0.07)", marginTop: 4, padding: "4px 6px" }}>
                                  <input placeholder="Autre ($)..." onKeyDown={e => { if (e.key === "Enter") { const v = parseFloat(e.target.value); if (v > 0) setChallengePrice(a.name, v); } }} onClick={e => e.stopPropagation()}
                                    style={{ width: "100%", padding: "4px 8px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#f0f0f0", fontSize: 11, outline: "none", boxSizing: "border-box" }} />
                                </div>
                                {challenge > 0 && <button onClick={() => resetChallenge(a.name)} style={{ display: "block", width: "100%", padding: "4px 10px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 10, background: "transparent", color: "#f87171", textAlign: "left" }}>↺ Reset</button>}
                              </div>
                            )}
                          </div>
                        </div>
                        <MiniChart trades={a.trades} w={280} />
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 14 }}>
                          <div><div style={{ fontSize: 9, color: "#555", letterSpacing: 1, textTransform: "uppercase" }}>P&L NET</div><div style={{ fontSize: 17, fontWeight: 700, color: (a.total - payout) >= 0 ? "#34d399" : "#f87171", fontFamily: "'Syne', sans-serif" }}>{fmtAbs(a.total - payout)}</div>{payout > 0 && <div style={{ fontSize: 9, color: "#fbbf24", marginTop: 2 }}>💸 -{fmtAbs(payout)}</div>}</div>
                          <div><div style={{ fontSize: 9, color: "#555", letterSpacing: 1, textTransform: "uppercase" }}>Win Rate</div><div style={{ fontSize: 17, fontWeight: 700, color: "#a78bfa", fontFamily: "'Syne', sans-serif" }}>{a.winRate}%</div></div>
                          <div><div style={{ fontSize: 9, color: "#555", letterSpacing: 1, textTransform: "uppercase" }}>Trades</div><div style={{ fontSize: 17, fontWeight: 700, color: "#888", fontFamily: "'Syne', sans-serif" }}>{a.count}</div></div>
                        </div>
                        <div style={{ marginTop: 10, display: "flex", gap: 10, fontSize: 11, flexWrap: "wrap" }}>
                          <span style={{ color: "#34d399" }}>{a.winners.length} ✓</span>
                          <span style={{ color: "#f87171" }}>{a.losers.length} ✗</span>
                          <span style={{ color: "#94a3b8" }}>{a.be.length} 🟰</span>
                          <span style={{ color: "#60a5fa" }}>{a.trades.filter(t => t.category === "londres").length} 🇬🇧</span>
                          <span style={{ color: "#f97316" }}>{a.trades.filter(t => t.category === "us").length} 🇺🇸</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "calendrier" && <CalendarView trades={filtered} />}

        {tab === "finances" && (
          <FinancesTab trades={trades} accountPayouts={accountPayouts} accountChallenges={accountChallenges} accountStatuses={accountStatuses} accountTypes={accountTypes} />
        )}

        {/* JOURNAL */}
        {tab === "journal" && (
          <div style={{ overflowX: "auto" }}>
            {filtered.length === 0 ? <div style={{ textAlign: "center", color: "#333", padding: 60, fontSize: 13 }}>Aucun trade.</div> : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                    {[{ label: "Symbole", col: "symbol" }, { label: "Date", col: "date" }, { label: "Heure", col: null }, { label: "Direction", col: "direction" }, { label: "BE", col: "be" }, { label: "Lot", col: "lot" }, { label: "Vente", col: null }, { label: "Durée", col: null }, { label: "Compte", col: "account" }, { label: "Session", col: "category" }, { label: "⚡", col: "scalp" }, { label: "P&L", col: "pnl" }].map(({ label, col }) => (
                      <th key={label} onClick={col ? () => handleSort(col) : undefined} style={thStyle(col)}>
                        {label}{col && sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : col ? " ·" : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedTrades.map(t => (
                    <tr key={t.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <td style={{ padding: "9px 10px", fontWeight: 700, color: "#e0e0e0", fontFamily: "'Syne', sans-serif", fontSize: 12 }}>{t.symbol}</td>
                      <td style={{ padding: "9px 10px", color: "#777", fontSize: 11 }}>{t.date}</td>
                      <td style={{ padding: "9px 10px", color: "#555", fontSize: 10 }}>{(t.boughtAt || "").split("T")[1]?.slice(0, 5) || (t.boughtAt || "").split(" ")[1]?.slice(0, 5) || "—"}</td>
                      <td style={{ padding: "9px 10px" }}><DirectionBadge d={t.direction} /></td>
                      <td style={{ padding: "9px 4px", textAlign: "center" }}>{Math.abs(t.pnl) <= 5 ? <span style={{ fontSize: 15 }}>🟰</span> : ""}</td>
                      <td style={{ padding: "9px 10px", color: "#888", fontSize: 11 }}>{t.lot || "—"}</td>
                      <td style={{ padding: "9px 10px", color: "#777", fontSize: 11 }}>{t.sellPrice ? t.sellPrice.toFixed(2) : "—"}</td>
                      <td style={{ padding: "9px 10px", color: "#555", fontSize: 10 }}>{t.duration}</td>
                      <td style={{ padding: "9px 10px" }}>
                        <span onClick={() => openRename(t.account)} style={{ cursor: "pointer", padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "rgba(167,139,250,0.1)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.2)" }}>{t.account || "—"}</span>
                      </td>
                      <td style={{ padding: "9px 10px" }}><CategoryToggle id={t.id} cat={t.category} onUpdate={updateCategory} /></td>
                      <td style={{ padding: "9px 4px", textAlign: "center" }}>{isScalp(t.duration) ? <span onClick={() => toggleScalpOff(t.id)} style={{ fontSize: 15, cursor: "pointer", opacity: scalpOff[t.id] ? 0.2 : 1 }}>⚡</span> : ""}</td>
                      <td style={{ padding: "9px 10px", textAlign: "right" }}><PnlBadge pnl={t.pnl} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {trades.length > 0 && (
              <div style={{ marginTop: 22, textAlign: "right" }}>
                {!confirmClear
                  ? <button onClick={() => setConfirmClear(true)} style={{ padding: "6px 14px", borderRadius: 7, border: "1px solid rgba(248,113,113,0.3)", background: "transparent", color: "#f87171", cursor: "pointer", fontSize: 11 }}>🗑 Effacer tout</button>
                  : <span style={{ fontSize: 12, color: "#f87171" }}>
                      Confirmer ?{" "}
                      <button onClick={clearAll} style={{ marginLeft: 8, padding: "5px 12px", borderRadius: 6, border: "none", background: "#f87171", color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 11 }}>Oui</button>
                      <button onClick={() => setConfirmClear(false)} style={{ marginLeft: 6, padding: "5px 12px", borderRadius: 6, border: "1px solid #333", background: "transparent", color: "#888", cursor: "pointer", fontSize: 11 }}>Non</button>
                    </span>
                }
              </div>
            )}
          </div>
        )}

        {/* IMPORT */}
        {tab === "import" && (
          <div style={{ maxWidth: 460, margin: "0 auto" }}>
            <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={handleDrop} onClick={() => document.getElementById("csv-input").click()}
              style={{ border: `2px dashed ${dragging ? "#a78bfa" : "rgba(255,255,255,0.09)"}`, borderRadius: 14, padding: "50px 36px", textAlign: "center", background: dragging ? "rgba(167,139,250,0.04)" : "rgba(255,255,255,0.01)", transition: "all .2s", cursor: "pointer", marginBottom: 18 }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>⬆️</div>
              <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 5 }}>Glissez votre CSV ici</div>
              <div style={{ color: "#444", fontSize: 11 }}>ou cliquez pour sélectionner</div>
              <input id="csv-input" type="file" accept=".csv" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
            </div>
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 16, fontSize: 11, color: "#555", lineHeight: 2 }}>
              ✓ Formats supportés : Topstep et Apex<br />
              ✓ Sessions Londres / US détectées automatiquement<br />
              ✓ Direction Long / Short détectée automatiquement<br />
              ✓ Doublons ignorés automatiquement
            </div>
            <div style={{ marginTop: 20, textAlign: "right" }}>
              {!confirmClear
                ? <button onClick={() => setConfirmClear(true)} style={{ padding: "6px 14px", borderRadius: 7, border: "1px solid rgba(248,113,113,0.3)", background: "transparent", color: "#f87171", cursor: "pointer", fontSize: 11 }}>🗑 Réinitialiser le journal</button>
                : <span style={{ fontSize: 12, color: "#f87171" }}>
                    Tout effacer ?{" "}
                    <button onClick={clearAll} style={{ marginLeft: 8, padding: "5px 12px", borderRadius: 6, border: "none", background: "#f87171", color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 11 }}>Oui</button>
                    <button onClick={() => setConfirmClear(false)} style={{ marginLeft: 6, padding: "5px 12px", borderRadius: 6, border: "1px solid #333", background: "transparent", color: "#888", cursor: "pointer", fontSize: 11 }}>Non</button>
                  </span>
              }
            </div>
          </div>
        )}

      </div>

      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateY(-5px); } to { opacity:1; transform:none; } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 3px; height: 3px; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 4px; }
        button { font-family: 'DM Sans', sans-serif; }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
    </div>
  );
}
