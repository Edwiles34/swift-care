// QueueDisplay.jsx
// Full-screen queue display board for SwiftCare.
// Mount a TV/monitor at the hospital, open this page in Chrome, press F11.
// URL: https://app.swiftcareliberia.org?display=HOSPITAL_ID
//
// How to use:
//   1. Add this component to App.jsx (see instructions at bottom of file)
//   2. Deploy to Netlify
//   3. On hospital TV, open: https://app.swiftcareliberia.org?display=YOUR_HOSPITAL_ID
//   4. Press F11 for fullscreen

import { useState, useEffect, useRef, useCallback } from "react";
import {
  collection, query, where, orderBy, onSnapshot, getDoc, doc,
} from "firebase/firestore";
import { db } from "./firebase.js";

// ─── Department label map ─────────────────────────────────────────────────────
const DEPT_LABELS = {
  reception:  { label: "Reception",        window: 1 },
  triage:     { label: "Triage",           window: 2 },
  doctor:     { label: "Doctor",           window: 3 },
  lab:        { label: "Laboratory",       window: 4 },
  pharmacy:   { label: "Pharmacy",         window: 5 },
  maternity:  { label: "Maternity",        window: 6 },
  emergency:  { label: "Emergency",        window: 7 },
  xray:       { label: "X-Ray",            window: 8 },
  dental:     { label: "Dental",           window: 9 },
  billing:    { label: "Billing",          window: 10 },
  opd:        { label: "Outpatient",       window: 11 },
  pediatrics: { label: "Pediatrics",       window: 12 },
};

// ─── Voice Announcement ───────────────────────────────────────────────────────
// Converts "RC-001" → "Now serving Reception, ticket number 001, at Window 1.
//                       Please proceed to the Reception desk. Thank you."
const announce = (ticket, deptId, windowNum) => {
  if (!window.speechSynthesis) return;

  const deptLabel = DEPT_LABELS[deptId]?.label || deptId;

  // Parse ticket number from e.g. "RC-001" → "001" → "1" spoken naturally
  const numPart = ticket.split("-")[1] || ticket;
  const spokenNum = parseInt(numPart, 10); // removes leading zeros: "001" → 1

 const message =
    `Attention please. ` +
    `Now serving ticket number ${spokenNum}, ` +
    `${deptLabel} department, ` +
    `Window ${windowNum}. ` +
    `Ticket number ${spokenNum}, ${deptLabel}, ` +
    `please proceed to Window ${windowNum}. ` +
    `Thank you for your patience.`;

 window.speechSynthesis.cancel();
  
  // Small delay to ensure clean start
  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate   = 0.75;  // slower = clearer and more professional
    utterance.pitch  = 0.9;   // slightly lower = more authoritative
    utterance.volume = 1.0;
    
    // Use best available voice
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      v.lang === "en-US" && v.name.includes("Google")
    ) || voices.find(v =>
      v.lang === "en-US" && v.name.includes("Samantha")
    ) || voices.find(v =>
      v.lang === "en-US" && v.name.includes("Alex")
    ) || voices.find(v =>
      v.lang === "en-GB"
    ) || voices.find(v =>
      v.lang.startsWith("en")
    );
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
  }, 300);

  // Use a natural English voice if available
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    v.lang === "en-US" && (v.name.includes("Google") || v.name.includes("Samantha") || v.name.includes("Alex"))
  ) || voices.find(v => v.lang.startsWith("en"));
  if (preferred) utterance.voice = preferred;

  window.speechSynthesis.speak(utterance);
};

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&display=swap');

  .qd-root {
    position: fixed; inset: 0;
    background: #060d1f;
    color: #fff;
    font-family: 'Inter', sans-serif;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ── */
  .qd-header {
    background: #0d1530;
    border-bottom: 2px solid #1e3a6e;
    padding: 16px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  .qd-logo {
    display: flex; align-items: center; gap: 14px;
  }
  .qd-logo-icon {
    width: 48px; height: 48px;
    background: #1a56db;
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 26px;
  }
  .qd-logo-name {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 32px; letter-spacing: 1px;
  }
  .qd-hospital-name {
    font-size: 14px; color: #94a3b8; margin-top: 2px;
  }
  .qd-header-right {
    text-align: right;
  }
  .qd-clock {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 42px; color: #60a5fa; letter-spacing: 3px;
  }
  .qd-date {
    font-size: 13px; color: #475569; margin-top: 2px;
  }

  /* ── Body ── */
  .qd-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    background: #1e2d5a;
    flex: 1;
    overflow: hidden;
  }
  .qd-panel {
    background: #060d1f;
    padding: 28px 32px;
    overflow: hidden;
  }
  .qd-section-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: #334155;
    margin-bottom: 20px;
  }

  /* ── Now Serving Cards ── */
  .qd-serving-card {
    background: #0a1628;
    border: 1px solid #1e3a6e;
    border-left: 5px solid #1a56db;
    border-radius: 10px;
    padding: 18px 24px;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .qd-serving-card.new {
    animation: cardPop 0.4s ease;
  }
  @keyframes cardPop {
    0%   { transform: scale(0.96); opacity: 0; }
    60%  { transform: scale(1.02); }
    100% { transform: scale(1);    opacity: 1; }
  }
  .qd-ticket-num {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 52px;
    color: #60a5fa;
    line-height: 1;
    min-width: 130px;
  }
  .qd-ticket-dept {
    font-size: 18px; font-weight: 600; color: #e2e8f0;
    margin-bottom: 6px;
  }
  .qd-ticket-window {
    font-size: 14px; color: #475569;
  }
  .qd-ticket-window strong {
    color: #38bdf8; font-weight: 600;
  }
  .qd-pulse {
    width: 12px; height: 12px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 10px #22c55e;
    margin-left: auto;
    animation: greenPulse 2s infinite;
  }
  @keyframes greenPulse {
    0%,100% { opacity:1; transform: scale(1); }
    50%      { opacity:0.4; transform: scale(0.85); }
  }
  .qd-empty {
    color: #1e293b; font-size: 15px; padding: 16px 0;
  }

  /* ── Up Next Grid ── */
  .qd-next-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .qd-next-card {
    background: #0d1530;
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 14px 18px;
  }
  .qd-next-num {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 34px; color: #64748b; margin-bottom: 4px;
  }
  .qd-next-dept {
    font-size: 12px; color: #334155; font-weight: 500;
    text-transform: uppercase; letter-spacing: 1px;
  }

  /* ── Flash Overlay ── */
  .qd-flash {
    position: fixed; inset: 0;
    background: rgba(26,86,219,0.92);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    z-index: 100;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }
  .qd-flash.show { opacity: 1; }
  .qd-flash-label {
    font-size: 18px; font-weight: 600; color: #bfdbfe;
    letter-spacing: 3px; text-transform: uppercase;
    margin-bottom: 12px;
  }
  .qd-flash-num {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 120px; color: #fff; line-height: 1;
  }
  .qd-flash-dept {
    font-size: 28px; color: #93c5fd; margin-top: 8px;
  }
  .qd-flash-window {
    font-size: 20px; color: #bfdbfe; margin-top: 12px;
    letter-spacing: 1px;
  }

  /* ── Ticker ── */
  .qd-ticker-bar {
    background: #030712;
    border-top: 2px solid #1e2d5a;
    padding: 10px 0;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    overflow: hidden;
  }
  .qd-ticker-tag {
    background: #1a56db;
    color: #fff;
    font-size: 11px; font-weight: 600;
    letter-spacing: 2px;
    padding: 4px 16px;
    flex-shrink: 0;
    margin-right: 16px;
  }
  .qd-ticker-scroll {
    font-size: 13px; color: #334155;
    white-space: nowrap;
    animation: tickerScroll 30s linear infinite;
  }
  @keyframes tickerScroll {
    0%   { transform: translateX(100vw); }
    100% { transform: translateX(-200%); }
  }
`;

// ─── Main Component ───────────────────────────────────────────────────────────
export default function QueueDisplay({ hospitalId, hospitalName }) {
  const [serving,  setServing]  = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [flash,    setFlash]    = useState(null); // { ticket, dept, deptId, window }
  const [time,     setTime]     = useState(new Date());
  const prevServing = useRef([]);
  const [autoHospitalName, setAutoHospitalName] = useState(hospitalName || "SwiftCare Hospital Network");
  // ── Auto-fetch hospital name from Firestore ────────────────────────────────
  useEffect(() => {
    if (!hospitalId) return;
    const fetchHospital = async () => {
      try {
        const hDoc = await getDoc(doc(db, "sc_hospitals", hospitalId));
        if (hDoc.exists()) setAutoHospitalName(hDoc.data().name);
      } catch(err) { console.error(err); }
    };
    fetchHospital();
  }, [hospitalId]);

  // ── Clock ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Live Firestore feed ────────────────────────────────────────────────────
  useEffect(() => {
    if (!hospitalId) return;

    const today = new Date(); today.setHours(0, 0, 0, 0);
const q = query(
      collection(db, "sc_display"),
      where("hospitalId", "==", hospitalId)
    );
const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => p.status === "called" || p.status === "serving");

     const nowServing = all;
      const waiting    = [];
      // Detect newly called tickets → trigger flash + voice
      nowServing.forEach(p => {
        const wasServing = prevServing.current.find(s => s.id === p.id);
        if (!wasServing) {
          const deptInfo = DEPT_LABELS[p.deptId] || { label: p.deptLabel, window: 1 };
          triggerFlash({
            ticket: p.ticket,
            dept:   deptInfo.label,
            deptId: p.deptId,
            window: deptInfo.window,
          });
        }
      });

      prevServing.current = nowServing;
      setServing(nowServing);
      setUpcoming(waiting);
    });

    return unsub;
  }, [hospitalId]);

  // ── Flash + Voice ──────────────────────────────────────────────────────────
  const triggerFlash = useCallback((item) => {
    setFlash(item);
    announce(item.ticket, item.deptId, item.window);
    setTimeout(() => setFlash(null), 5000);
  }, []);

  // ── Formatted time/date ────────────────────────────────────────────────────
  const clockStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr  = time.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const tickerText = serving.length > 0
    ? `Now serving: ${serving.map(s => `${s.ticket} at Window ${DEPT_LABELS[s.deptId]?.window || ""}`).join("  ·  ")}  —  ${upcoming.length} patients waiting  —  Please have your ticket ready  —  Thank you for your patience  —  SwiftCare Queue Management`
    : `Welcome to ${autoHospitalName}  —  Please check in at Reception  —  Your ticket number will appear on this screen when it is your turn  —  Thank you for your patience`;
  return (
    <>
      <style>{CSS}</style>

      {/* Flash overlay */}
      <div className={`qd-flash ${flash ? "show" : ""}`}>
        {flash && (
          <>
            <div className="qd-flash-label">Now Serving</div>
            <div className="qd-flash-num">{flash.ticket}</div>
            <div className="qd-flash-dept">{flash.dept}</div>
            <div className="qd-flash-window">Please proceed to Window {flash.window}</div>
          </>
        )}
      </div>

      <div className="qd-root">
        {/* Header */}
        <div className="qd-header">
          <div className="qd-logo">
            <div className="qd-logo-icon">🏥</div>
            <div>
              <div className="qd-logo-name">SwiftCare</div>
              <div className="qd-hospital-name">{autoHospitalName}</div>
            </div>
          </div>
          <div className="qd-header-right">
            <div className="qd-clock">{clockStr}</div>
            <div className="qd-date">{dateStr}</div>
          </div>
        </div>

        {/* Body */}
        <div className="qd-body">
          {/* Now Serving */}
          <div className="qd-panel">
            <div className="qd-section-label">Now Serving</div>
            {serving.length === 0 ? (
              <div className="qd-empty">No patients currently being served</div>
            ) : (
              serving.map(p => {
                const deptInfo = DEPT_LABELS[p.deptId] || { label: p.deptLabel, window: "—" };
                return (
                  <div key={p.id} className="qd-serving-card new">
                    <div className="qd-ticket-num">{p.ticket}</div>
                    <div>
                      <div className="qd-ticket-dept">{deptInfo.label}</div>
                      <div className="qd-ticket-window">
                        Window <strong>{deptInfo.window}</strong>
                      </div>
                    </div>
                    <div className="qd-pulse" />
                  </div>
                );
              })
            )}
          </div>

          {/* Up Next */}
          <div className="qd-panel">
            <div className="qd-section-label">Up Next</div>
            {upcoming.length === 0 ? (
              <div className="qd-empty">Queue is clear</div>
            ) : (
              <div className="qd-next-grid">
                {upcoming.map(p => {
                  const deptInfo = DEPT_LABELS[p.deptId] || { label: p.deptLabel };
                  return (
                    <div key={p.id} className="qd-next-card">
                      <div className="qd-next-num">{p.ticket}</div>
                      <div className="qd-next-dept">{deptInfo.label}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Ticker */}
        <div className="qd-ticker-bar">
          <div className="qd-ticker-tag">LIVE</div>
          <div className="qd-ticker-scroll" key={tickerText}>{tickerText}</div>
        </div>
      </div>
    </>
  );
}

/*
───────────────────────────────────────────────────────────────────────────────
HOW TO ADD THIS TO App.jsx — 3 STEPS
───────────────────────────────────────────────────────────────────────────────

STEP 1 — Import QueueDisplay at the top of App.jsx:

  import QueueDisplay from "./QueueDisplay.jsx";

STEP 2 — Detect the ?display= URL param in your App() root component.
  Add this near the top of the App() function, before the return:

  const urlParams = new URLSearchParams(window.location.search);
  const displayHospitalId = urlParams.get("display");

STEP 3 — Add this as the FIRST check in your App() return, before the
  auth loading check:

  if (displayHospitalId) {
    return <QueueDisplay hospitalId={displayHospitalId} hospitalName="Buchanan Government Hospital" />;
  }

  ── Full placement in App() ──

  export default function App() {

    // ADD THIS:
    const urlParams = new URLSearchParams(window.location.search);
    const displayHospitalId = urlParams.get("display");
    if (displayHospitalId) {
      return <QueueDisplay hospitalId={displayHospitalId} hospitalName="Buchanan Government Hospital" />;
    }
    // END ADD

    const [user, setUser] = useState(null);
    // ... rest of your existing App code

  }

  ── How to use on hospital TV ──

  1. On the TV/monitor, open Chrome
  2. Go to: https://app.swiftcareliberia.org?display=YOUR_HOSPITAL_FIRESTORE_ID
     (Find the hospital ID in Firestore → sc_hospitals collection → document ID)
  3. Press F11 for fullscreen
  4. Done — updates live as staff call patients

───────────────────────────────────────────────────────────────────────────────
*/
