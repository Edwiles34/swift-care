// ReportsDashboard.jsx
// Drop-in replacement for the basic reports tab in HospitalAdmin.
// Shows: patients served, avg wait time, busiest departments, hourly flow chart.
//
// Usage in App.jsx HospitalAdmin reports tab:
//   import ReportsDashboard from "./ReportsDashboard.jsx";
//   {tab === "reports" && <ReportsDashboard hospitalId={hospitalId} queue={queue} />}

import { useState, useEffect } from "react";
import { collection, query, where, getDocs, orderBy } from "firebase/firestore";
import { db } from "./firebase.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmtMins = (mins) => {
  if (!mins || isNaN(mins)) return "—";
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `${Math.round(mins)} min`;
  return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
};

const DEPT_COLORS = {
  reception:  "#3b82f6", triage:     "#10b981", doctor:     "#6366f1",
  lab:        "#f59e0b", pharmacy:   "#ef4444", maternity:  "#ec4899",
  emergency:  "#dc2626", xray:       "#8b5cf6", dental:     "#14b8a6",
  billing:    "#84cc16", opd:        "#0891b2", pediatrics: "#7c3aed",
  surgical:   "#b45309", eyecenter:  "#0f766e", antenatal:  "#db2777",
  dressing:   "#16a34a", nutrition:  "#ca8a04", mortuary:   "#475569",
  maleward:   "#1d4ed8", femaleward: "#be185d",
};

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ReportsDashboard({ hospitalId, queue }) {
  const [reportDate, setReportDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [stats,    setStats]    = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [viewMode, setViewMode] = useState("today"); // "today" | "custom"

  useEffect(() => {
    if (hospitalId) generateReport(reportDate);
  }, [hospitalId, reportDate]);

  const generateReport = async (dateStr) => {
    setLoading(true);
    try {
      const start = new Date(dateStr); start.setHours(0,0,0,0);
      const end   = new Date(dateStr); end.setHours(23,59,59,999);

      const snap = await getDocs(query(
        collection(db, "sc_queue"),
        where("hospitalId", "==", hospitalId),
      ));

      const all = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => {
          const ts = p.createdAt?.toDate?.();
          return ts && ts >= start && ts <= end;
        });

      // ── Total counts ────────────────────────────────────────────────────
      const total     = all.length;
      const completed = all.filter(p => p.status === "completed").length;
      const waiting   = all.filter(p => p.status === "waiting").length;
      const serving   = all.filter(p => p.status === "serving" || p.status === "called").length;
      const skipped   = all.filter(p => p.status === "skipped").length;

      // ── Average wait time (createdAt → servedAt) ────────────────────────
      const waitTimes = all
        .filter(p => p.createdAt && p.servedAt)
        .map(p => {
          const created = p.createdAt?.toDate?.()?.getTime?.() || 0;
          const served  = p.servedAt?.toDate?.()?.getTime?.()  || 0;
          return (served - created) / 60000; // minutes
        })
        .filter(m => m > 0 && m < 480); // ignore outliers > 8hrs

      const avgWait = waitTimes.length > 0
        ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
        : null;

      const maxWait = waitTimes.length > 0 ? Math.max(...waitTimes) : null;
      const minWait = waitTimes.length > 0 ? Math.min(...waitTimes) : null;

      // ── Department breakdown ─────────────────────────────────────────────
      const deptMap = {};
      all.forEach(p => {
        const key = p.deptId || "unknown";
        if (!deptMap[key]) deptMap[key] = { label: p.deptLabel || key, total: 0, completed: 0, waitTimes: [] };
        deptMap[key].total++;
        if (p.status === "completed") deptMap[key].completed++;
        if (p.createdAt && p.servedAt) {
          const w = (p.servedAt?.toDate?.()?.getTime?.() - p.createdAt?.toDate?.()?.getTime?.()) / 60000;
          if (w > 0 && w < 480) deptMap[key].waitTimes.push(w);
        }
      });

      const departments = Object.entries(deptMap)
        .map(([id, d]) => ({
          id,
          label:   d.label,
          total:   d.total,
          completed: d.completed,
          avgWait: d.waitTimes.length > 0
            ? d.waitTimes.reduce((a, b) => a + b, 0) / d.waitTimes.length
            : null,
          color: DEPT_COLORS[id] || "#6366f1",
        }))
        .sort((a, b) => b.total - a.total);

      // ── Hourly breakdown ─────────────────────────────────────────────────
      const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
      all.forEach(p => {
        const ts = p.createdAt?.toDate?.();
        if (ts) hourly[ts.getHours()].count++;
      });
      const peakHour = hourly.reduce((a, b) => b.count > a.count ? b : a, hourly[0]);

      // ── Check-in types ───────────────────────────────────────────────────
      const selfCheckin  = all.filter(p => p.checkinType === "self").length;
      const staffCheckin = all.filter(p => p.checkinType === "receptionist").length;

      setStats({
        total, completed, waiting, serving, skipped,
        avgWait, maxWait, minWait,
        departments, hourly, peakHour,
        selfCheckin, staffCheckin,
        completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      });
    } catch(err) { console.error(err); }
    setLoading(false);
  };

  const maxHourlyCount = stats ? Math.max(...stats.hourly.map(h => h.count), 1) : 1;

  if (loading) return (
    <div style={{ textAlign:"center", padding:60, color:"var(--muted)" }}>
      Generating report…
    </div>
  );

  return (
    <div className="fade-in">

      {/* ── Date Selector ── */}
      <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:20, flexWrap:"wrap" }}>
        <button onClick={()=>{ setViewMode("today"); setReportDate(new Date().toISOString().split("T")[0]); }}
          style={{ padding:"8px 16px", borderRadius:8, border:"1px solid var(--border)",
            background: viewMode==="today" ? "var(--blue)" : "var(--surface)",
            color: viewMode==="today" ? "#fff" : "var(--text)",
            fontWeight:600, fontSize:13, cursor:"pointer", fontFamily:"var(--font)" }}>
          Today
        </button>
        <button onClick={()=>setViewMode("custom")}
          style={{ padding:"8px 16px", borderRadius:8, border:"1px solid var(--border)",
            background: viewMode==="custom" ? "var(--blue)" : "var(--surface)",
            color: viewMode==="custom" ? "#fff" : "var(--text)",
            fontWeight:600, fontSize:13, cursor:"pointer", fontFamily:"var(--font)" }}>
          Pick Date
        </button>
        {viewMode === "custom" && (
          <input type="date" value={reportDate}
            onChange={e => setReportDate(e.target.value)}
            style={{ padding:"8px 12px", border:"1px solid var(--border)", borderRadius:8,
              fontSize:13, background:"var(--surface)", color:"var(--text)", fontFamily:"var(--font)" }} />
        )}
        <div style={{ marginLeft:"auto", fontSize:13, color:"var(--muted)" }}>
          {new Date(reportDate).toLocaleDateString([], { weekday:"long", month:"long", day:"numeric", year:"numeric" })}
        </div>
      </div>

      {!stats || stats.total === 0 ? (
        <div style={{ textAlign:"center", padding:60, color:"var(--muted)" }}>
          <div style={{ fontSize:40, marginBottom:12 }}>📊</div>
          <div style={{ fontWeight:600, marginBottom:4 }}>No data for this date</div>
          <div style={{ fontSize:14 }}>No patients were checked in on this day.</div>
        </div>
      ) : (
        <>
          {/* ── Top Stats ── */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:20 }}>
            {[
              { label:"Total Patients",    val:stats.total,           color:"var(--blue)",  icon:"👥" },
              { label:"Completed",         val:stats.completed,       color:"var(--green)", icon:"✅" },
              { label:"Avg Wait Time",     val:fmtMins(stats.avgWait),color:"var(--amber)", icon:"⏱" },
              { label:"Completion Rate",   val:`${stats.completionRate}%`, color:"var(--indigo)", icon:"📈" },
            ].map(s => (
              <div key={s.label} style={{ background:"var(--surface)", border:"1px solid var(--border)",
                borderRadius:12, padding:"16px 20px", textAlign:"center" }}>
                <div style={{ fontSize:24, marginBottom:6 }}>{s.icon}</div>
                <div style={{ fontFamily:"var(--font-h)", fontSize:32, fontWeight:900, color:s.color }}>
                  {s.val}
                </div>
                <div style={{ fontSize:12, color:"var(--muted)", marginTop:4, textTransform:"uppercase",
                  letterSpacing:1 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* ── Secondary Stats ── */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:20 }}>
            {[
              { label:"Still Waiting",  val:stats.waiting,  color:"var(--blue)"  },
              { label:"In Progress",    val:stats.serving,  color:"var(--green)" },
              { label:"Skipped",        val:stats.skipped,  color:"var(--red)"   },
              { label:"Self Check-ins", val:stats.selfCheckin, color:"var(--muted)" },
            ].map(s => (
              <div key={s.label} style={{ background:"var(--surface2)", border:"1px solid var(--border)",
                borderRadius:8, padding:"12px 16px", textAlign:"center" }}>
                <div style={{ fontFamily:"var(--font-h)", fontSize:24, fontWeight:900, color:s.color }}>
                  {s.val}
                </div>
                <div style={{ fontSize:11, color:"var(--muted)", marginTop:2, textTransform:"uppercase",
                  letterSpacing:1 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* ── Wait Time Details ── */}
          {stats.avgWait && (
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)",
              borderRadius:12, padding:"16px 20px", marginBottom:20 }}>
              <div style={{ fontWeight:700, marginBottom:12 }}>⏱ Wait Time Analysis</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16 }}>
                {[
                  { label:"Average Wait", val:fmtMins(stats.avgWait), color:"var(--amber)" },
                  { label:"Shortest Wait", val:fmtMins(stats.minWait), color:"var(--green)" },
                  { label:"Longest Wait", val:fmtMins(stats.maxWait), color:"var(--red)" },
                ].map(s => (
                  <div key={s.label} style={{ textAlign:"center" }}>
                    <div style={{ fontSize:22, fontWeight:800, color:s.color }}>{s.val}</div>
                    <div style={{ fontSize:12, color:"var(--muted)", marginTop:2 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Hourly Chart ── */}
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)",
            borderRadius:12, padding:"16px 20px", marginBottom:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <div style={{ fontWeight:700 }}>📈 Hourly Patient Flow</div>
              <div style={{ fontSize:13, color:"var(--muted)" }}>
                Peak: {stats.peakHour.hour}:00 — {stats.peakHour.count} patients
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"flex-end", gap:4, height:120 }}>
              {stats.hourly.map(h => {
                const heightPct = maxHourlyCount > 0 ? (h.count / maxHourlyCount) * 100 : 0;
                const isPeak = h.hour === stats.peakHour.hour;
                return (
                  <div key={h.hour} style={{ flex:1, display:"flex", flexDirection:"column",
                    alignItems:"center", gap:4 }}>
                    {h.count > 0 && (
                      <div style={{ fontSize:9, color:"var(--muted)" }}>{h.count}</div>
                    )}
                    <div style={{
                      width:"100%",
                      height: `${Math.max(heightPct, h.count > 0 ? 8 : 2)}%`,
                      background: isPeak ? "var(--blue)" : h.count > 0 ? "#bfdbfe" : "var(--border)",
                      borderRadius:"3px 3px 0 0",
                      minHeight: h.count > 0 ? 8 : 2,
                      transition:"height 0.3s ease",
                    }} />
                    {h.hour % 3 === 0 && (
                      <div style={{ fontSize:9, color:"var(--muted)", whiteSpace:"nowrap" }}>
                        {h.hour}:00
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Department Breakdown ── */}
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)",
            borderRadius:12, padding:"16px 20px", marginBottom:20 }}>
            <div style={{ fontWeight:700, marginBottom:16 }}>🏥 Department Breakdown</div>
            {stats.departments.map((d, i) => (
              <div key={d.id} style={{ marginBottom:12 }}>
                <div style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"center", marginBottom:4 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <div style={{ width:10, height:10, borderRadius:"50%",
                      background:d.color, flexShrink:0 }} />
                    <span style={{ fontSize:14, fontWeight:600 }}>{d.label}</span>
                  </div>
                  <div style={{ display:"flex", gap:16, fontSize:13 }}>
                    <span style={{ color:"var(--blue)" }}>{d.total} patients</span>
                    <span style={{ color:"var(--green)" }}>{d.completed} done</span>
                    {d.avgWait && (
                      <span style={{ color:"var(--amber)" }}>~{fmtMins(d.avgWait)} wait</span>
                    )}
                  </div>
                </div>
                <div style={{ background:"var(--border)", borderRadius:4, height:8, overflow:"hidden" }}>
                  <div style={{
                    height:"100%", borderRadius:4,
                    background: d.color,
                    width: `${(d.total / stats.total) * 100}%`,
                    transition:"width 0.5s ease",
                  }} />
                </div>
              </div>
            ))}
          </div>

          {/* ── Check-in Method ── */}
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)",
            borderRadius:12, padding:"16px 20px" }}>
            <div style={{ fontWeight:700, marginBottom:12 }}>📋 Check-in Method</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              {[
                { label:"Self Check-in (Kiosk)", val:stats.selfCheckin,
                  pct: Math.round((stats.selfCheckin/stats.total)*100), color:"var(--blue)" },
                { label:"Staff Assisted", val:stats.staffCheckin,
                  pct: Math.round((stats.staffCheckin/stats.total)*100), color:"var(--green)" },
              ].map(s => (
                <div key={s.label} style={{ background:"var(--surface2)", borderRadius:8,
                  padding:"12px 16px", border:"1px solid var(--border)" }}>
                  <div style={{ fontWeight:700, fontSize:20, color:s.color }}>{s.val}</div>
                  <div style={{ fontSize:13, color:"var(--muted)", marginTop:2 }}>{s.label}</div>
                  <div style={{ marginTop:8, background:"var(--border)", borderRadius:4, height:6 }}>
                    <div style={{ height:"100%", borderRadius:4, background:s.color,
                      width:`${s.pct}%` }} />
                  </div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:4 }}>{s.pct}%</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
