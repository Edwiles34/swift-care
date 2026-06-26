import React, { useState, useEffect, useCallback, useRef } from "react";
 import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, sendPasswordResetEmail,
} from "firebase/auth";
import {
  collection, addDoc, getDocs, query, where, orderBy,
  serverTimestamp, doc, updateDoc, setDoc, getDoc,
  deleteDoc, onSnapshot, Timestamp,
} from "firebase/firestore";
import { auth, db } from "./firebase.js";
import QueueDisplay from "./QueueDisplay.jsx";
import ReportsDashboard from "./ReportsDashboard.jsx";
import { initializeApp } from "firebase/app";
import { getAuth as getSecondaryAuth } from "firebase/auth";

// ─── Constants ────────────────────────────────────────────────────────────────
 // TODO: move to Firestore
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// ─── Twilio Verify via Netlify Function ───────────────────────────────────────
const TWILIO_FN = "https://us-central1-swiftcare-26073.cloudfunctions.net/twilioVerify";

const sendOTP = async (phoneNumber) => {
  const res = await fetch(TWILIO_FN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", phone: phoneNumber }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to send OTP");
  return data;
};

const verifyOTP = async (phoneNumber, code) => {
  const res = await fetch(TWILIO_FN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "verify", phone: phoneNumber, code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to verify OTP");
  return data.approved;
};

// ─── Audit Log Helper ─────────────────────────────────────────────────────────
const writeAuditLog = async (action, details = {}) => {
  try {
    await addDoc(collection(db, "sc_audit_log"), {
      action,
      ...details,
      timestamp: serverTimestamp(),
      userAgent: navigator.userAgent,
    });
  } catch (err) {
    console.error("Audit log error:", err);
  }
};

// ─── Login Attempt Tracker (localStorage) ─────────────────────────────────────
const getLoginAttempts = (email) => {
  try {
    const data = JSON.parse(localStorage.getItem(`sc_attempts_${email}`) || "{}");
    return data;
  } catch { return {}; }
};

const recordFailedAttempt = (email) => {
  const data = getLoginAttempts(email);
  const attempts = (data.count || 0) + 1;
  const lockedUntil = attempts >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOCKOUT_DURATION_MS : data.lockedUntil;
  localStorage.setItem(`sc_attempts_${email}`, JSON.stringify({ count: attempts, lockedUntil }));
  return attempts;
};

const clearLoginAttempts = (email) => {
  localStorage.removeItem(`sc_attempts_${email}`);
};

const isLockedOut = (email) => {
  const data = getLoginAttempts(email);
  if (data.lockedUntil && Date.now() < data.lockedUntil) return data.lockedUntil;
  if (data.lockedUntil && Date.now() >= data.lockedUntil) clearLoginAttempts(email);
  return false;
};

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCWAEzL_41qvlq_PFAK1yZy-kc_W-Z66yc",
  authDomain:        "swiftcare-26073.firebaseapp.com",
  projectId:         "swiftcare-26073",
  storageBucket:     "swiftcare-26073.firebasestorage.app",
  messagingSenderId: "205955009932",
  appId:             "1:205955009932:web:748c297eeecaeef0eb1aa9",
};

const PLANS = {
  basic:    { label: "Basic",    price: 99,  color: "#3b82f6", maxDepts: 3  },
  standard: { label: "Standard", price: 249, color: "#6366f1", maxDepts: 10 },
  premium:  { label: "Premium",  price: 499, color: "#8b5cf6", maxDepts: 999},
};

const DEPARTMENTS = [
  { id: "reception",  label: "Reception",          icon: "HC", color: "#3b82f6" },
  { id: "triage",     label: "Triage / Nurse",     icon: "TR", color: "#10b981" },
  { id: "doctor",     label: "Doctor",              icon: "DR", color: "#6366f1" },
  { id: "lab",        label: "Laboratory",          icon: "LB", color: "#f59e0b" },
  { id: "pharmacy",   label: "Pharmacy",            icon: "PH", color: "#ef4444" },
  { id: "maternity",  label: "Maternity",           icon: "MT", color: "#ec4899" },
  { id: "emergency",  label: "Emergency",           icon: "ER", color: "#dc2626" },
  { id: "xray",       label: "X-Ray / Imaging",     icon: "XR", color: "#8b5cf6" },
  { id: "dental",     label: "Dental",              icon: "DN", color: "#14b8a6" },
  { id: "billing",    label: "Billing / Cashier",   icon: "BL", color: "#84cc16" },
  { id: "opd",        label: "OPD (Outpatient)",    icon: "OP", color: "#0891b2" },
  { id: "maleward",   label: "Male Ward",           icon: "MW", color: "#1d4ed8" },
  { id: "femaleward", label: "Female Ward",         icon: "FW", color: "#be185d" },
  { id: "pediatrics", label: "Pediatrics",          icon: "PD", color: "#7c3aed" },
  { id: "surgical",   label: "Surgical / Theater",  icon: "SG", color: "#b45309" },
  { id: "eyecenter",  label: "Eye Center",          icon: "EY", color: "#0f766e" },
  { id: "antenatal",  label: "Antenatal Care",      icon: "AN", color: "#db2777" },
  { id: "dressing",   label: "Wound Dressing",      icon: "WD", color: "#16a34a" },
  { id: "nutrition",  label: "Nutrition / Feeding", icon: "NT", color: "#ca8a04" },
  { id: "mortuary",   label: "Mortuary",            icon: "MO", color: "#475569" },
];


const STATUS_COLORS = {
  waiting:    { bg: "#dbeafe", color: "#1d4ed8", label: "Waiting"     },
  called:     { bg: "#fef3c7", color: "#d97706", label: "Called"      },
  serving:    { bg: "#d1fae5", color: "#065f46", label: "In Progress" },
  completed:  { bg: "#f3f4f6", color: "#6b7280", label: "Completed"   },
  skipped:    { bg: "#fee2e2", color: "#991b1b", label: "Skipped"     },
};

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Poppins:wght@700;800;900&display=swap');

  :root {
    --blue:     #2563eb;
    --blue-d:   #1d4ed8;
    --blue-l:   #eff6ff;
    --indigo:   #6366f1;
    --bg:       #f0f4f8;
    --surface:  #ffffff;
    --surface2: #f8fafc;
    --border:   #e2e8f0;
    --text:     #0f172a;
    --muted:    #64748b;
    --green:    #10b981;
    --red:      #ef4444;
    --amber:    #f59e0b;
    --radius:   12px;
    --font:     'Inter', sans-serif;
    --font-h:   'Poppins', sans-serif;
    --shadow:   0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md:0 4px 6px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.04);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--font); }
  input, button, select, textarea { font-family: var(--font); }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translate(-50%, 12px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.5; }
  }
  @keyframes slideIn {
    from { transform: translateX(-100%); opacity: 0; }
    to   { transform: translateX(0); opacity: 1; }
  }

  .fade-in { animation: fadeIn 0.3s ease forwards; }
  .pulse   { animation: pulse 2s infinite; }

  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  @media (max-width: 768px) {
    .hide-mobile { display: none !important; }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtTime = (ts) => {
  if (!ts) return "—";
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const fmtDate = (ts) => {
  if (!ts) return "—";
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
};

const waitTime = (ts) => {
  if (!ts) return "—";
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "Just arrived";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins/60)}h ${mins%60}m`;
};

const genTicket = (deptId, count) => {
  const prefix = deptId.substring(0,2).toUpperCase();
  // Time-based ticket (HHMM) — unique per dept per minute, needs no queue read
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2,"0") + String(now.getMinutes()).padStart(2,"0");
  return `${prefix}-${hhmm}`;
};

// ─── Shared UI ────────────────────────────────────────────────────────────────
function Toast({ message, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  const colors = {
    success: { bg:"#dcfce7", color:"#166534", border:"#86efac" },
    error:   { bg:"#fee2e2", color:"#991b1b", border:"#fca5a5" },
    warn:    { bg:"#fef3c7", color:"#92400e", border:"#fcd34d" },
    info:    { bg:"#dbeafe", color:"#1e40af", border:"#93c5fd" },
  };
  const c = colors[type] || colors.info;
  return (
    <div style={{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)",
      background:c.bg, color:c.color, border:`1px solid ${c.border}`,
      padding:"12px 20px", borderRadius:12, fontWeight:600, zIndex:9999,
      maxWidth:380, textAlign:"center", boxShadow:"0 8px 32px rgba(0,0,0,0.15)",
      animation:"fadeUp 0.3s ease", fontSize:14 }}>
      {message}
    </div>
  );
}

function Btn({ children, onClick, variant="primary", style={}, disabled=false, size="md" }) {
  const sizes = { sm:"7px 14px", md:"10px 18px", lg:"13px 24px" };
  const variants = {
    primary: { background:"var(--blue)", color:"#fff", border:"none" },
    success: { background:"var(--green)", color:"#fff", border:"none" },
    danger:  { background:"var(--red)",  color:"#fff", border:"none" },
    ghost:   { background:"transparent", color:"var(--text)", border:"1px solid var(--border)" },
    outline: { background:"var(--blue-l)", color:"var(--blue)", border:"1px solid #bfdbfe" },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: sizes[size], border:"none", borderRadius:8, fontWeight:600,
      fontSize: size==="sm"?12:size==="lg"?16:14, cursor:disabled?"not-allowed":"pointer",
      opacity:disabled?0.5:1, transition:"all 0.15s", ...variants[variant], ...style
    }}>{children}</button>
  );
}

function Input({ placeholder, value, onChange, type="text", style={}, required=false }) {
  return (
    <input type={type} placeholder={placeholder} value={value} onChange={onChange} required={required}
      style={{ background:"#fff", border:"1px solid var(--border)", borderRadius:8,
        padding:"10px 13px", color:"var(--text)", fontSize:14, width:"100%", outline:"none",
        transition:"border-color 0.2s", ...style }}
      onFocus={e=>e.target.style.borderColor="var(--blue)"}
      onBlur={e=>e.target.style.borderColor="var(--border)"}
    />
  );
}

function Card({ children, style={} }) {
  return (
    <div style={{ background:"var(--surface)", borderRadius:"var(--radius)",
      boxShadow:"var(--shadow)", border:"1px solid var(--border)", padding:20, ...style }}>
      {children}
    </div>
  );
}

function Badge({ status }) {
  const s = STATUS_COLORS[status] || STATUS_COLORS.waiting;
  return (
    <span style={{ padding:"3px 10px", borderRadius:20, fontSize:12, fontWeight:600,
      background:s.bg, color:s.color }}>
      {s.label}
    </span>
  );
}

function PlanBadge({ plan }) {
  const p = PLANS[plan] || PLANS.basic;
  return (
    <span style={{ padding:"3px 10px", borderRadius:20, fontSize:12, fontWeight:700,
      background:`${p.color}22`, color:p.color, border:`1px solid ${p.color}44` }}>
      {p.label}
    </span>
  );
}

// ─── Selfie Capture Component ─────────────────────────────────────────────────
function SelfieCapture({ onCapture, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [captured, setCaptured] = useState(null);
  const [camError, setCamError] = useState(null);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 320, height: 320 }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setStreaming(true);
      }
    } catch (err) {
      setCamError("Camera access denied. Please allow camera and try again.");
    }
  };

  const stopCamera = () => {
    const stream = videoRef.current?.srcObject;
    stream?.getTracks().forEach(t => t.stop());
  };

  const takeSelfie = () => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    canvas.width = 320; canvas.height = 320;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, 320, 320);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    setCaptured(dataUrl);
    stopCamera();
  };

  const retake = () => {
    setCaptured(null);
    startCamera();
  };

  if (camError) return (
    <div style={{textAlign:"center",padding:24}}>
      <div style={{fontSize:40,marginBottom:12}}>📷</div>
      <div style={{color:"var(--red)",fontSize:14,marginBottom:16}}>{camError}</div>
      <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
    </div>
  );

  return (
    <div style={{textAlign:"center"}}>
      <div style={{fontWeight:700,fontSize:16,color:"var(--blue)",marginBottom:8}}>
        📸 Staff Identity Verification
      </div>
      <div style={{fontSize:13,color:"var(--muted)",marginBottom:16}}>
        Take a selfie to confirm your identity before logging in
      </div>

      {!captured ? (
        <>
          <div style={{position:"relative",width:220,height:220,margin:"0 auto 16px",
            borderRadius:"50%",overflow:"hidden",border:"3px solid var(--blue)",
            background:"#000"}}>
            <video ref={videoRef} style={{width:"100%",height:"100%",objectFit:"cover"}}
              autoPlay playsInline muted />
            {/* Face guide overlay */}
            <div style={{position:"absolute",inset:0,border:"3px dashed rgba(255,255,255,0.4)",
              borderRadius:"50%",pointerEvents:"none"}} />
          </div>
          <canvas ref={canvasRef} style={{display:"none"}} />
          <div style={{display:"flex",gap:8,justifyContent:"center"}}>
            <Btn onClick={takeSelfie} disabled={!streaming}>
              📸 Take Selfie
            </Btn>
            <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
          </div>
        </>
      ) : (
        <>
          <div style={{width:220,height:220,margin:"0 auto 16px",
            borderRadius:"50%",overflow:"hidden",border:"3px solid var(--green)"}}>
            <img src={captured} alt="selfie" style={{width:"100%",height:"100%",objectFit:"cover"}} />
          </div>
          <div style={{color:"var(--green)",fontWeight:600,fontSize:14,marginBottom:16}}>
            ✅ Selfie captured!
          </div>
          <div style={{display:"flex",gap:8,justifyContent:"center"}}>
            <Btn variant="success" onClick={()=>onCapture(captured)}>Confirm & Sign In →</Btn>
            <Btn variant="ghost" onClick={retake}>Retake</Btn>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onToast }) {
  const [mode, setMode]         = useState("staff");
  const [loading, setLoading]   = useState(false);

  // Staff ID login state
  const [staffId, setStaffId]   = useState("");
  const [loginStep, setLoginStep] = useState("id"); // "id" | "selfie" | "otp" | "admin_approval"
  const [selfieData, setSelfieData] = useState(null);
  const [otp, setOtp]           = useState("");
  const [otpSent, setOtpSent]   = useState(false);
  const [staffDoc, setStaffDoc] = useState(null); // found staff record

  // Patient self check-in state
  const [hospitals, setHospitals] = useState([]);
  const [selHospital, setSelHospital] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientAge, setPatientAge]   = useState("");
  const [patientPhone, setPatientPhone] = useState("");
  const [patientGender, setPatientGender] = useState("");
  const [selDept, setSelDept]   = useState("");
  const [checkedIn, setCheckedIn] = useState(null);
  const [loadingHospitals, setLoadingHospitals] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [smsConsentError, setSmsConsentError] = useState("");
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail]                 = useState("");
  const [resetSent, setResetSent]                   = useState(false);
  const [resetLoading, setResetLoading]             = useState(false);

  const handlePasswordReset = async () => {
    if (!resetEmail.trim()) return onToast("Enter your email address", "error");
    setResetLoading(true);
    try {
      await sendPasswordResetEmail(auth, resetEmail.trim().toLowerCase());
      setResetSent(true);
      onToast("Password reset email sent ✓", "success");
    } catch(err) {
      onToast(err.message.replace("Firebase: ",""), "error");
    }
    setResetLoading(false);
  };

  useEffect(() => {
    if (mode === "patient") loadHospitals();
  }, [mode]);

  const loadHospitals = async () => {
    setLoadingHospitals(true);
    try {
      const snap = await getDocs(query(collection(db,"sc_hospitals"),where("active","==",true)));
      setHospitals(snap.docs.map(d=>({id:d.id,...d.data()})));
    } catch(err) { console.error(err); }
    setLoadingHospitals(false);
  };

  // ── STEP 1: Verify Staff ID ────────────────────────────────────────────────
  const verifyStaffId = async () => {
    if (!staffId.trim()) return onToast("Enter your Staff ID","error");

    // Check lockout
    const lockout = isLockedOut(staffId);
    if (lockout) {
      const mins = Math.ceil((lockout - Date.now()) / 60000);
      return onToast(`Account locked. Try again in ${mins} minute${mins!==1?"s":""}.`, "error");
    }

    setLoading(true);

    // Super admin bypass — check before any Firestore lookup
    if (staffId.trim().toUpperCase() === "SWIFT-SUPER") {
      try {
        await signInWithEmailAndPassword(auth, "e37wiles@gmail.com", "Swift2029!");
        onToast("Welcome, Super Admin!", "success");
      } catch(err) { onToast("Super admin login failed: " + err.message, "error"); }
      setLoading(false); return;
    }

    try {
      // Look up staff by staffId field in sc_staff collection
      const snap = await getDocs(query(
        collection(db,"sc_staff"),
        where("staffId","==", staffId.trim().toUpperCase())
      ));
      if (snap.empty) {
        const attempts = recordFailedAttempt(staffId);
        const remaining = MAX_LOGIN_ATTEMPTS - attempts;
        await writeAuditLog("staff_login_failed", { staffId, attempts, reason: "invalid_id" });
        if (remaining <= 0) {
          onToast(`Account locked for 15 minutes after ${MAX_LOGIN_ATTEMPTS} failed attempts.`, "error");
        } else {
          onToast(`Staff ID not found. ${remaining} attempt${remaining!==1?"s":""} remaining.`, "error");
        }
      } else {
        const sd = { id: snap.docs[0].id, ...snap.docs[0].data() };
        setStaffDoc(sd);
        clearLoginAttempts(staffId);
        setLoginStep("selfie");
      }
    } catch(err) { onToast(err.message, "error"); }
    setLoading(false);
  };

  // ── STEP 2: After Selfie ───────────────────────────────────────────────────
  const afterSelfie = async (selfieImg) => {
    setSelfieData(selfieImg);
    await writeAuditLog("selfie_captured", { staffId: staffId || "", hospitalId: staffDoc?.hospitalId || "" });

    if (staffDoc?.phone) {
      // Staff has phone → send OTP
      setLoading(true);
      try {
        await sendOTP(staffDoc.phone);
        setOtpSent(true);
        setLoginStep("otp");
        onToast(`OTP sent to ${staffDoc.phone.replace(/\d(?=\d{4})/g, "*")}`, "info");
      } catch(err) {
        onToast("Failed to send OTP: " + err.message, "error");
      }
      setLoading(false);
    } else {
      // Staff has no phone → Admin approval flow
      setLoginStep("admin_approval");
      await writeAuditLog("admin_approval_requested", {
        staffId: staffId || "",
        staffName: staffDoc?.name || staffId || "",
        hospitalId: staffDoc?.hospitalId || "",
      });
      // Notify admin via Firestore
      await addDoc(collection(db,"sc_login_requests"),{
        staffId: staffDoc.id || "",
        staffName: staffDoc.name || staffId || "",
        hospitalId: staffDoc.hospitalId || "",
        status: "pending",
        createdAt: serverTimestamp(),
      });
      onToast("Approval request sent to your Hospital Admin", "info");
    }
  };

  // ── STEP 3a: Verify OTP ────────────────────────────────────────────────────
  const verifyOTPAndLogin = async () => {
    if (!otp || otp.length < 4) return onToast("Enter the OTP code", "error");
    setLoading(true);
    try {
      const approved = await verifyOTP(staffDoc.phone, otp);
      if (approved) {
        await signInWithEmailAndPassword(auth, staffDoc.email, staffDoc.email);
        await writeAuditLog("staff_login_success", {
          staffId, email: staffDoc.email,
          hospitalId: staffDoc.hospitalId, method: "otp"
        });
        onToast("✅ Login successful! Welcome back.", "success");
      } else {
        onToast("Invalid OTP code. Please try again.", "error");
        await writeAuditLog("otp_failed", { staffId, hospitalId: staffDoc.hospitalId });
      }
    } catch(err) { onToast(err.message, "error"); }
    setLoading(false);
  };

  // ── STEP 3b: Poll for Admin Approval ──────────────────────────────────────
  useEffect(() => {
    if (loginStep !== "admin_approval" || !staffDoc) return;
    const interval = setInterval(async () => {
      const snap = await getDocs(query(
        collection(db,"sc_login_requests"),
        where("staffId","==",staffDoc.id),
        where("status","==","approved")
      ));
      if (!snap.empty) {
        clearInterval(interval);
        await signInWithEmailAndPassword(auth, staffDoc.email, staffDoc.email);
        await writeAuditLog("staff_login_success", {
          staffId, email: staffDoc.email,
          hospitalId: staffDoc.hospitalId, method: "admin_approval"
        });
        onToast("✅ Admin approved! Logging you in.", "success");
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [loginStep, staffDoc]);

  const patientCheckIn = async () => {
    if (!selHospital||!patientName||!patientAge||!selDept)
      return onToast("Please fill in all required fields","error");
    if (!smsConsent) {
      setSmsConsentError("You must agree to receive SMS updates to complete check-in.");
      return;
    }
    setSmsConsentError("");
    try {
      const hospital = hospitals.find(h=>h.id===selHospital);
      const dept = DEPARTMENTS.find(d=>d.id===selDept);
      // No queue read needed — ticket is time-based (keeps sc_queue reads staff-only)
      const ticket = genTicket(selDept, 0);
      const docRef = await addDoc(collection(db,"sc_queue"),{
        hospitalId:selHospital, hospitalName:hospital?.name||"",
        deptId:selDept, deptLabel:dept?.label||selDept,
      patientName: patientName.trim().substring(0, 100).replace(/[<>{}]/g, ""),
        patientAge: Math.min(Math.max(Number(patientAge), 0), 150),
        patientPhone: patientPhone.trim().substring(0, 20).replace(/[^0-9+\-\s]/g, "") || null,
        patientGender: patientGender || null,
        ticket, status:"waiting",
        createdAt:serverTimestamp(),
        calledAt:null, servedAt:null, completedAt:null,
        checkinType:"self", position:0,
        smsConsent: true,
        smsConsentTimestamp: new Date().toISOString(),
        smsConsentMethod: "kiosk-checkbox",
        smsConsentVersion: "v1.0",
      });
      setCheckedIn({ ticket, dept:dept?.label, hospital:hospital?.name, id:docRef.id });
    } catch(err) { onToast(err.message,"error"); }
  };

  const resetLogin = () => {
    setLoginStep("id"); setStaffId(""); setSelfieData(null);
    setOtp(""); setOtpSent(false); setStaffDoc(null);
  };

  return (
    <div style={{ minHeight:"100dvh", background:"linear-gradient(135deg,#1e40af,#3b82f6,#06b6d4)",
      display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
      <div style={{ width:"100%", maxWidth:440 }}>

        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:12, marginBottom:8 }}>
            <div style={{ width:52, height:52, background:"#fff", borderRadius:16,
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:28,
              boxShadow:"0 4px 16px rgba(0,0,0,0.15)" }}>🏥</div>
            <div>
              <div style={{ fontFamily:"var(--font-h)", fontSize:32, fontWeight:900,
                color:"#fff", letterSpacing:-0.5 }}>SwiftCare</div>
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.8)", letterSpacing:2,
                textTransform:"uppercase" }}>Patient Queue Management</div>
            </div>
          </div>
        </div>

        {/* Toggle */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4,
          background:"rgba(255,255,255,0.15)", borderRadius:12, padding:4, marginBottom:16 }}>
          {[
            {key:"patient", label:"👤 Patient Check-In"},
            {key:"staff",   label:"🔑 Staff Login"},
          ].map(m=>(
            <button key={m.key} onClick={()=>{setMode(m.key); resetLogin();}} style={{
              padding:"11px 0", border:"none", borderRadius:10, fontWeight:700, fontSize:14,
              cursor:"pointer", fontFamily:"var(--font)", transition:"all 0.2s",
              background: mode===m.key ? "#fff" : "transparent",
              color: mode===m.key ? "var(--blue)" : "rgba(255,255,255,0.9)",
            }}>{m.label}</button>
          ))}
        </div>

        {/* Patient Check-In */}
        {mode==="patient" && !checkedIn && (
          <Card>
            <div style={{ fontWeight:700, fontSize:18, marginBottom:16, color:"var(--blue)" }}>
              👤 Patient Self Check-In
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {loadingHospitals ? (
                <div style={{ textAlign:"center", color:"var(--muted)", padding:20 }}>Loading hospitals…</div>
              ) : (
                <select value={selHospital} onChange={e=>setSelHospital(e.target.value)}
                  style={{ padding:"10px 13px", border:"1px solid var(--border)", borderRadius:8,
                    fontSize:14, background:"#fff", color:selHospital?"var(--text)":"var(--muted)" }}>
                  <option value="">Select hospital / clinic *</option>
                  {hospitals.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
              )}
              <Input placeholder="Full name *" value={patientName} onChange={e=>setPatientName(e.target.value)} />
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                <Input placeholder="Age *" value={patientAge} onChange={e=>setPatientAge(e.target.value)} type="number" />
                <select value={patientGender} onChange={e=>setPatientGender(e.target.value)}
                  style={{ padding:"10px 13px", border:"1px solid var(--border)", borderRadius:8,
                    fontSize:14, background:"#fff", color:patientGender?"var(--text)":"var(--muted)" }}>
                  <option value="">Gender</option>
                  <option>Male</option><option>Female</option><option>Other</option>
                </select>
              </div>
              <Input placeholder="Phone number (optional)" value={patientPhone} onChange={e=>setPatientPhone(e.target.value)} type="tel" />
              {/* SMS Consent — required for Twilio toll-free compliance */}
              <label style={{ display:"flex", alignItems:"flex-start", gap:10, cursor:"pointer",
                padding:"12px 14px", background:"#f0f9ff", border:`1px solid ${smsConsentError?"var(--red)":"#bae6fd"}`,
                borderRadius:8 }}>
                <input type="checkbox" checked={smsConsent}
                  onChange={e=>{ setSmsConsent(e.target.checked); if(e.target.checked) setSmsConsentError(""); }}
                  style={{ marginTop:3, width:17, height:17, flexShrink:0, accentColor:"var(--blue)", cursor:"pointer" }} />
                <span style={{ fontSize:13, color:"#334155", lineHeight:1.5 }}>
                  I agree to receive SMS notifications about my queue position and appointment
                  updates from <strong>{hospitals.find(h=>h.id===selHospital)?.name || "this hospital"}</strong> via
                  SwiftCare. Msg &amp; data rates may apply. Reply <strong>STOP</strong> to opt out.
                </span>
              </label>
              {smsConsentError && (
                <div style={{ fontSize:13, color:"var(--red)", fontWeight:600, marginTop:-4, paddingLeft:2 }}>
                  ⚠ {smsConsentError}
                </div>
              )}
              <select value={selDept} onChange={e=>setSelDept(e.target.value)}
                style={{ padding:"10px 13px", border:"1px solid var(--border)", borderRadius:8,
                  fontSize:14, background:"#fff", color:selDept?"var(--text)":"var(--muted)" }}>
                <option value="">Select department *</option>
                {DEPARTMENTS.map(d=><option key={d.id} value={d.id}>{d.icon} {d.label}</option>)}
              </select>
              <Btn style={{ width:"100%", padding:"13px 0", fontSize:15 }} onClick={patientCheckIn}>
                ✅ Join Queue
              </Btn>
            </div>
          </Card>
        )}

        {/* Check-In Confirmation */}
        {mode==="patient" && checkedIn && (
          <Card style={{ textAlign:"center" }}>
            <div style={{ fontSize:60, marginBottom:12 }}>✅</div>
            <div style={{ fontFamily:"var(--font-h)", fontSize:22, fontWeight:900,
              color:"var(--blue)", marginBottom:4 }}>You're in the queue!</div>
            <div style={{ fontSize:14, color:"var(--muted)", marginBottom:24 }}>
              {checkedIn.hospital} · {checkedIn.dept}
            </div>
            <div style={{ background:"var(--blue-l)", borderRadius:16, padding:"24px 32px", marginBottom:24 }}>
              <div style={{ fontSize:13, color:"var(--muted)", marginBottom:4 }}>Your Ticket Number</div>
              <div style={{ fontFamily:"var(--font-h)", fontSize:56, fontWeight:900,
                color:"var(--blue)", letterSpacing:4 }}>{checkedIn.ticket}</div>
            </div>
            <div style={{ fontSize:14, color:"var(--muted)", marginBottom:20 }}>
              Please wait — you will be called when it's your turn.
            </div>
            <Btn variant="outline" onClick={()=>{ setCheckedIn(null); setPatientName(""); setPatientAge(""); setPatientPhone(""); setPatientGender(""); setSelDept(""); setSmsConsent(false); setSmsConsentError("");}}>
              Check In Another Patient
            </Btn>
          </Card>
        )}

        {/* ── STAFF LOGIN STEPS ── */}
        {mode==="staff" && (
          <Card>
            {/* STEP 1: Enter Staff ID */}
            {loginStep==="id" && (
              <>
                <div style={{ fontWeight:700, fontSize:18, marginBottom:4, color:"var(--blue)" }}>
                  🔑 Staff Login
                </div>
                <div style={{fontSize:12,color:"var(--muted)",marginBottom:16,display:"flex",alignItems:"center",gap:6}}>
                  <span>🛡️</span> Secure 3-step identity verification
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  <Input placeholder="Enter your Staff ID (e.g. JFK-001)"
                    value={staffId} onChange={e=>setStaffId(e.target.value.toUpperCase())} />
                  <Btn style={{width:"100%",padding:"13px 0",fontSize:15,opacity:loading?0.6:1}}
                    onClick={verifyStaffId} disabled={loading}>
                    {loading ? "Verifying…" : "Next: Verify Identity →"}
                  </Btn>
                  <div style={{textAlign:"center",marginTop:8,width:"100%"}}>
                    <button onClick={()=>setShowForgotPassword(true)}
                      style={{background:"none",border:"none",color:"var(--muted)",
                        fontSize:13,cursor:"pointer",textDecoration:"underline",
                        display:"block",width:"100%",textAlign:"center"}}>
                      Forgot password?
                    </button>
                  </div>
                  {showForgotPassword && (
                    <div style={{marginTop:12,padding:"16px",background:"rgba(255,255,255,0.12)",
                      borderRadius:10,border:"1px solid rgba(255,255,255,0.2)"}}>
                      {!resetSent ? (
                        <>
                          <div style={{fontSize:13,color:"var(--text)",marginBottom:10,fontWeight:600}}>
                            🔑 Reset your password
                          </div>
                          <div style={{fontSize:12,color:"var(--muted)",marginBottom:10}}>
                            Enter your email address and we'll send you a reset link.
                          </div>
                          <input
                            type="email"
                            placeholder="Your email address"
                            value={resetEmail}
                            onChange={e=>setResetEmail(e.target.value)}
                            style={{width:"100%",padding:"10px 13px",borderRadius:8,border:"none",
                              fontSize:14,marginBottom:10,outline:"none"}}
                          />
                          <div style={{display:"flex",gap:8}}>
                            <Btn style={{flex:1}} onClick={handlePasswordReset} disabled={resetLoading}>
                              {resetLoading?"Sending…":"📧 Send Reset Email"}
                            </Btn>
                            <Btn variant="ghost" style={{flex:1}}
                              onClick={()=>{setShowForgotPassword(false);setResetEmail("");setResetSent(false);}}>
                              Cancel
                            </Btn>
                          </div>
                        </>
                      ) : (
                        <div style={{textAlign:"center"}}>
                          <div style={{fontSize:24,marginBottom:8}}>📧</div>
                          <div style={{color:"rgba(255,255,255,0.9)",fontWeight:600,marginBottom:4}}>
                            Reset email sent!
                          </div>
                          <div style={{fontSize:12,color:"rgba(255,255,255,0.7)",marginBottom:12}}>
                            Check your inbox and follow the link to reset your password.
                          </div>
                          <Btn variant="ghost"
                            onClick={()=>{setShowForgotPassword(false);setResetEmail("");setResetSent(false);}}>
                            Back to Login
                          </Btn>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {/* Progress indicators */}
                <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:16}}>
                  {["Staff ID","Selfie","SMS Code"].map((s,i)=>(
                    <div key={s} style={{textAlign:"center"}}>
                      <div style={{width:28,height:28,borderRadius:"50%",margin:"0 auto 4px",
                        background: i===0 ? "var(--blue)" : "rgba(255,255,255,0.2)",
                        display:"flex",alignItems:"center",justifyContent:"center",
                        fontSize:12,fontWeight:700,color:"#fff"}}>
                        {i+1}
                      </div>
                      <div style={{fontSize:10,color:"var(--muted)",whiteSpace:"nowrap"}}>{s}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* STEP 2: Selfie */}
            {loginStep==="selfie" && (
              <SelfieCapture
                onCapture={afterSelfie}
                onCancel={resetLogin}
              />
            )}

            {/* STEP 3a: OTP */}
            {loginStep==="otp" && (
              <>
                <div style={{textAlign:"center",marginBottom:16}}>
                  <div style={{fontSize:40,marginBottom:8}}>📱</div>
                  <div style={{fontWeight:700,fontSize:18,color:"var(--blue)",marginBottom:4}}>
                    Enter SMS Code
                  </div>
                  <div style={{fontSize:13,color:"var(--muted)"}}>
                    A 6-digit code was sent to your registered phone number
                  </div>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  <input
                    type="number"
                    placeholder="000000"
                    value={otp}
                    onChange={e=>setOtp(e.target.value)}
                    maxLength={6}
                    style={{
                      background:"#fff", border:"2px solid var(--blue)", borderRadius:12,
                      padding:"16px", color:"var(--text)", fontSize:28, width:"100%",
                      outline:"none", textAlign:"center", fontWeight:700, letterSpacing:8,
                      fontFamily:"var(--font-h)"
                    }}
                  />
                  <Btn style={{width:"100%",padding:"13px 0",fontSize:15,opacity:loading?0.6:1}}
                    onClick={verifyOTPAndLogin} disabled={loading}>
                    {loading ? "Verifying…" : "✅ Confirm & Login"}
                  </Btn>
                  <Btn variant="ghost" style={{width:"100%"}} onClick={async()=>{
                    setLoading(true);
                    try { await sendOTP(staffDoc.phone); onToast("New code sent!","success"); }
                    catch(e) { onToast(e.message,"error"); }
                    setLoading(false);
                  }}>Resend Code</Btn>
                  <Btn variant="ghost" style={{width:"100%"}} onClick={resetLogin}>← Start Over</Btn>
                </div>
              </>
            )}

            {/* STEP 3b: Admin Approval */}
            {loginStep==="admin_approval" && (
              <div style={{textAlign:"center",padding:"8px 0"}}>
                <div style={{fontSize:48,marginBottom:12}}>⏳</div>
                <div style={{fontWeight:700,fontSize:18,color:"var(--blue)",marginBottom:8}}>
                  Waiting for Admin Approval
                </div>
                <div style={{fontSize:13,color:"var(--muted)",marginBottom:20,lineHeight:1.6}}>
                  Your Hospital Admin has been notified.<br/>
                  They will approve your login from their device.
                </div>
                <div style={{background:"var(--blue-l)",borderRadius:12,padding:"12px 16px",marginBottom:16}}>
                  <div style={{fontSize:12,color:"var(--blue)",fontWeight:600}}>
                    👤 {staffDoc?.name || staffId}
                  </div>
                  <div style={{fontSize:11,color:"var(--muted)"}}>Approval pending…</div>
                </div>
                <div style={{display:"flex",gap:4,justifyContent:"center",marginBottom:16}}>
                  {[0,1,2].map(i=>(
                    <div key={i} style={{
                      width:8,height:8,borderRadius:"50%",background:"var(--blue)",
                      animation:`pulse 1.4s ease-in-out ${i*0.2}s infinite`
                    }}/>
                  ))}
                </div>
                <Btn variant="ghost" style={{width:"100%"}} onClick={resetLogin}>← Cancel</Btn>
              </div>
            )}
          </Card>
        )}

        <div style={{ textAlign:"center", marginTop:20, fontSize:12, color:"rgba(255,255,255,0.7)" }}>
          SwiftCare · Powered by secure cloud technology
        </div>
      </div>
    </div>
  );
}

// ─── Super Admin Panel ────────────────────────────────────────────────────────
function SuperAdminPanel({ user, onToast }) {
  const [tab, setTab]         = useState("hospitals");
  const [hospitals, setHospitals] = useState([]);
  const [loading, setLoading] = useState(true);

  const [hoName,    setHoName]    = useState("");
  const [hoEmail,   setHoEmail]   = useState("");
  const [hoPass,    setHoPass]    = useState("");
  const [hoPlan,    setHoPlan]    = useState("basic");
  const [hoDue,     setHoDue]     = useState("");
  const [hoPhone,   setHoPhone]   = useState("");
  const [hoAddress, setHoAddress] = useState("");

  useEffect(() => { loadHospitals(); }, []);

  const loadHospitals = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db,"sc_hospitals"));
      const list = snap.docs.map(d=>({id:d.id,...d.data()}));
      const withCounts = await Promise.all(list.map(async h => {
        const staffSnap = await getDocs(query(collection(db,"sc_staff"),where("hospitalId","==",h.id)));
        const qSnap = await getDocs(query(collection(db,"sc_queue"),where("hospitalId","==",h.id)));
        return {...h, staffCount:staffSnap.size, queueCount:qSnap.size};
      }));
      setHospitals(withCounts);
    } catch(err) { onToast(err.message,"error"); }
    setLoading(false);
  };

  const createHospital = async () => {
    if (!hoName||!hoEmail||!hoPass) return onToast("Fill in all required fields","error");
    try {
      const firebaseConfig = FIREBASE_CONFIG;
      const secondaryApp = initializeApp(firebaseConfig, "sc_secondary_"+Date.now());
      const secondaryAuth = getSecondaryAuth(secondaryApp);
      const cred = await createUserWithEmailAndPassword(secondaryAuth, hoEmail, hoPass);
      await secondaryAuth.signOut();

      const hoRef = await addDoc(collection(db,"sc_hospitals"),{
        name:hoName, adminEmail:hoEmail, adminUid:cred.user.uid,
        plan:hoPlan, active:true, phone:hoPhone||null, address:hoAddress||null,
        nextPaymentDue:hoDue||null, monthlyFee:PLANS[hoPlan].price,
        createdAt:serverTimestamp(),
      });
      await setDoc(doc(db,"sc_staff",cred.user.uid),{
        email:hoEmail, role:"admin", hospitalId:hoRef.id, createdAt:serverTimestamp(),
      });
      onToast(`${hoName} created ✓`,"success");
      setHoName(""); setHoEmail(""); setHoPass(""); setHoPhone(""); setHoAddress(""); setHoDue("");
      loadHospitals();
    } catch(err) { onToast(err.message.replace("Firebase: ",""),"error"); }
  };

  const toggleHospital = async (h) => {
    await updateDoc(doc(db,"sc_hospitals",h.id),{active:!h.active});
    onToast(`${h.name} ${h.active?"suspended":"reactivated"} ✓`, h.active?"warn":"success");
    loadHospitals();
  };

  const markPaid = async (h) => {
    const next = new Date(); next.setMonth(next.getMonth()+1);
    await updateDoc(doc(db,"sc_hospitals",h.id),{
      lastPaid:new Date().toISOString(),
      nextPaymentDue:next.toISOString().split("T")[0], active:true,
    });
    onToast(`Payment recorded for ${h.name} ✓`,"success");
    loadHospitals();
  };

  const deleteHospital = async (h) => {
    const confirm = window.confirm(
      `⚠️ DELETE "${h.name}"?\n\nThis will permanently delete the hospital and all its data. This cannot be undone.\n\nType OK to confirm.`
    );
    if (!confirm) return;
    try {
      // Delete all queue entries for this hospital
      const qSnap = await getDocs(query(collection(db,"sc_queue"),where("hospitalId","==",h.id)));
      await Promise.all(qSnap.docs.map(d=>deleteDoc(doc(db,"sc_queue",d.id))));
      // Delete all staff for this hospital
      const sSnap = await getDocs(query(collection(db,"sc_staff"),where("hospitalId","==",h.id)));
      await Promise.all(sSnap.docs.map(d=>deleteDoc(doc(db,"sc_staff",d.id))));
      // Delete hospital doc
      await deleteDoc(doc(db,"sc_hospitals",h.id));
      onToast(`${h.name} deleted permanently`,"warn");
      loadHospitals();
    } catch(err) { onToast(err.message,"error"); }
  };

  const totalMRR = hospitals.filter(h=>h.active).reduce((a,h)=>a+(PLANS[h.plan]?.price||0),0);

  return (
    <div style={{ minHeight:"100dvh", background:"var(--bg)" }}>
      {/* Header */}
      <div style={{ background:"#fff", borderBottom:"1px solid var(--border)",
        padding:"14px 24px", display:"flex", justifyContent:"space-between", alignItems:"center",
        boxShadow:"var(--shadow)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:38, height:38, background:"var(--blue)", borderRadius:10,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>🏥</div>
          <div>
            <div style={{ fontFamily:"var(--font-h)", fontWeight:900, fontSize:18, color:"var(--blue)" }}>
              SwiftCare
            </div>
            <div style={{ fontSize:11, color:"var(--muted)" }}>Super Admin</div>
          </div>
        </div>
        <Btn variant="ghost" size="sm" onClick={()=>signOut(auth)}>Sign Out</Btn>
      </div>

      {/* MRR Bar */}
      <div style={{ background:"linear-gradient(135deg,#1e40af,#3b82f6)",
        padding:"16px 24px", display:"flex", gap:48, flexWrap:"wrap" }}>
        {[
          {label:"MONTHLY REVENUE", val:`$${totalMRR.toLocaleString()}`},
          {label:"ACTIVE HOSPITALS", val:hospitals.filter(h=>h.active).length},
          {label:"TOTAL HOSPITALS",  val:hospitals.length},
        ].map(s=>(
          <div key={s.label}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:2,color:"rgba(255,255,255,0.7)"}}>{s.label}</div>
            <div style={{fontFamily:"var(--font-h)",fontSize:28,fontWeight:900,color:"#fff"}}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:4, padding:"16px 24px 0",
        borderBottom:"1px solid var(--border)", background:"#fff" }}>
        {[
          {key:"hospitals", label:"🏥 Hospitals"},
          {key:"create",    label:"➕ New Hospital"},
          {key:"revenue",   label:"💰 Revenue"},
          {key:"auditlog",  label:"🔍 Audit Log"},
        ].map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)} style={{
            padding:"10px 20px", border:"none", fontWeight:600, fontSize:13,
            cursor:"pointer", fontFamily:"var(--font)", background:"transparent",
            color: tab===t.key ? "var(--blue)" : "var(--muted)",
            borderBottom: tab===t.key ? "2px solid var(--blue)" : "2px solid transparent",
            borderRadius:"8px 8px 0 0",
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding:24, maxWidth:900, margin:"0 auto" }}>
        {loading ? (
          <div style={{textAlign:"center",padding:60,color:"var(--muted)"}}>Loading…</div>
        ) : (
          <>
            {/* Hospitals List */}
            {tab==="hospitals" && (
              <div className="fade-in">
                <div style={{fontWeight:700,marginBottom:16}}>{hospitals.length} hospitals registered</div>
                {hospitals.length===0 && (
                  <Card style={{textAlign:"center",padding:40,color:"var(--muted)"}}>
                    No hospitals yet — create your first one!
                  </Card>
                )}
                {hospitals.map(h=>(
                  <Card key={h.id} style={{marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                      <div style={{flex:1,minWidth:180}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                          <div style={{fontWeight:700,fontSize:16}}>{h.name}</div>
                          <span style={{padding:"2px 8px",borderRadius:20,fontSize:11,fontWeight:700,
                            background:h.active?"#dcfce7":"#fee2e2",
                            color:h.active?"#166534":"#991b1b"}}>
                            {h.active?"Active":"Suspended"}
                          </span>
                        </div>
                        <div style={{fontSize:12,color:"var(--muted)"}}>{h.adminEmail}</div>
                        <div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>
                          {h.staffCount||0} staff · {h.queueCount||0} total patients
                        </div>
                        {h.address && <div style={{fontSize:12,color:"var(--muted)"}}>{h.address}</div>}
                      </div>
                      <div style={{textAlign:"center"}}>
                        <PlanBadge plan={h.plan} />
                        <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>
                          ${PLANS[h.plan]?.price}/mo
                        </div>
                      </div>
                      <div style={{textAlign:"center",minWidth:90}}>
                        <div style={{fontSize:11,color:"var(--muted)"}}>Next Due</div>
                        <div style={{fontSize:13,fontWeight:600,
                          color:h.nextPaymentDue&&new Date(h.nextPaymentDue)<new Date()?"var(--red)":"var(--text)"}}>
                          {h.nextPaymentDue?new Date(h.nextPaymentDue).toLocaleDateString([]
                            ,{month:"short",day:"numeric"}):"—"}
                        </div>
                      </div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <Btn variant="success" size="sm" onClick={()=>markPaid(h)}>💳 Paid</Btn>
                        <Btn variant={h.active?"danger":"success"} size="sm" onClick={()=>toggleHospital(h)}>
                          {h.active?"🔒 Suspend":"✅ Activate"}
                        </Btn>
                        <Btn variant="danger" size="sm" onClick={()=>deleteHospital(h)}
                          style={{background:"#7f1d1d",opacity:0.85}}>
                          🗑 Delete
                        </Btn>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {/* Create Hospital */}
            {tab==="create" && (
              <div className="fade-in">
                <Card style={{maxWidth:520}}>
                  <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:20,
                    color:"var(--blue)",marginBottom:20}}>Create New Hospital</div>
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    <Input placeholder="Hospital / Clinic name *" value={hoName} onChange={e=>setHoName(e.target.value)} />
                    <Input placeholder="Address" value={hoAddress} onChange={e=>setHoAddress(e.target.value)} />
                    <Input placeholder="Phone number" value={hoPhone} onChange={e=>setHoPhone(e.target.value)} type="tel" />
                    <Input placeholder="Admin email *" value={hoEmail} onChange={e=>setHoEmail(e.target.value)} type="email" />
                    <Input placeholder="Admin password *" value={hoPass} onChange={e=>setHoPass(e.target.value)} type="password" />
                    <select value={hoPlan} onChange={e=>setHoPlan(e.target.value)}
                      style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,fontSize:14,background:"#fff"}}>
                      {Object.entries(PLANS).map(([k,v])=>(
                        <option key={k} value={k}>{v.label} — ${v.price}/mo</option>
                      ))}
                    </select>
                    <div>
                      <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>First payment due date</div>
                      <Input type="date" value={hoDue} onChange={e=>setHoDue(e.target.value)} />
                    </div>
                    <Btn style={{width:"100%",padding:"13px 0"}} onClick={createHospital}>
                      ➕ Create Hospital Account
                    </Btn>
                  </div>
                </Card>
              </div>
            )}

            {/* Revenue */}
            {tab==="revenue" && (
              <div className="fade-in">
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,marginBottom:24}}>
                  {Object.entries(PLANS).map(([key,plan])=>{
                    const count = hospitals.filter(h=>h.plan===key&&h.active).length;
                    return (
                      <Card key={key} style={{textAlign:"center"}}>
                        <div style={{fontSize:12,color:"var(--muted)",marginBottom:4,letterSpacing:1,textTransform:"uppercase"}}>
                          {plan.label}
                        </div>
                        <div style={{fontFamily:"var(--font-h)",fontSize:32,fontWeight:900,color:plan.color}}>
                          ${(count*plan.price).toLocaleString()}
                        </div>
                        <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>
                          {count} hospital{count!==1?"s":""}
                        </div>
                      </Card>
                    );
                  })}
                </div>
                <Card>
                  <div style={{fontWeight:700,marginBottom:16}}>Payment Status</div>
                  {hospitals.map(h=>{
                    const overdue = h.nextPaymentDue && new Date(h.nextPaymentDue)<new Date();
                    return (
                      <div key={h.id} style={{display:"flex",justifyContent:"space-between",
                        alignItems:"center",padding:"10px 0",borderBottom:"1px solid var(--border)"}}>
                        <div>
                          <div style={{fontWeight:600}}>{h.name}</div>
                          <div style={{fontSize:12,color:"var(--muted)"}}>{h.adminEmail}</div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:12}}>
                          <PlanBadge plan={h.plan} />
                          <span style={{fontSize:13,fontWeight:700,
                            color:overdue?"var(--red)":"var(--green)"}}>
                            {overdue?"⚠ OVERDUE":"✓ Current"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </Card>
              </div>
            )}

            {/* Audit Log */}
            {tab==="auditlog" && (
              <AuditLogPanel />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Audit Log Panel ──────────────────────────────────────────────────────────
function AuditLogPanel() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const snap = await getDocs(query(
          collection(db,"sc_audit_log"),
          orderBy("timestamp","desc"),
        ));
        setLogs(snap.docs.map(d=>({id:d.id,...d.data()})));
      } catch(err) { console.error(err); }
      setLoading(false);
    };
    load();
  }, []);

  const actionColors = {
    staff_login:         { bg:"#dcfce7", color:"#166534", label:"Login ✓" },
    staff_login_failed:  { bg:"#fee2e2", color:"#991b1b", label:"Login Failed ✗" },
    session_timeout:     { bg:"#fef3c7", color:"#92400e", label:"Session Timeout" },
    queue_status_update: { bg:"#dbeafe", color:"#1e40af", label:"Queue Update" },
  };

  if (loading) return <div style={{textAlign:"center",padding:40,color:"var(--muted)"}}>Loading audit log…</div>;

  return (
    <div className="fade-in">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontWeight:700}}>🔍 Security Audit Log ({logs.length} entries)</div>
        <div style={{fontSize:12,color:"var(--muted)"}}>All staff actions are recorded</div>
      </div>
      {logs.length === 0 && (
        <Card style={{textAlign:"center",padding:40,color:"var(--muted)"}}>No audit entries yet.</Card>
      )}
      {logs.map(log => {
        const ac = actionColors[log.action] || { bg:"#f3f4f6", color:"#374151", label: log.action };
        const ts = log.timestamp?.toDate?.();
        return (
          <Card key={log.id} style={{marginBottom:8,padding:"12px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <span style={{padding:"3px 10px",borderRadius:20,fontSize:12,fontWeight:700,
                background:ac.bg,color:ac.color,whiteSpace:"nowrap"}}>{ac.label}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:600,color:"var(--text)"}}>
                  {log.email || log.staffEmail || "—"}
                </div>
                {log.hospitalId && (
                  <div style={{fontSize:12,color:"var(--muted)"}}>Hospital: {log.hospitalId}</div>
                )}
                {log.attempts && (
                  <div style={{fontSize:12,color:"var(--red)"}}>Attempts: {log.attempts}</div>
                )}
                {log.newStatus && (
                  <div style={{fontSize:12,color:"var(--muted)"}}>Status → {log.newStatus}</div>
                )}
              </div>
              <div style={{fontSize:12,color:"var(--muted)",textAlign:"right",whiteSpace:"nowrap"}}>
                {ts ? ts.toLocaleString() : "—"}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Hospital Admin Dashboard ─────────────────────────────────────────────────
function HospitalAdmin({ user, hospitalId, hospitalData, onToast }) {
  const [tab, setTab]       = useState("queue");
  const [queue, setQueue]   = useState([]);
  const [staff, setStaff]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterDept, setFilterDept] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [transferPatient, setTransferPatient] = useState(null);
  const [transferDept, setTransferDept] = useState("");
  const [transferring, setTransferring] = useState(false);

  // New staff form
  const [staffEmail, setStaffEmail]   = useState("");
  const [staffPass,  setStaffPass]    = useState("");
  const [staffRole,  setStaffRole]    = useState("receptionist");
  const [staffDept,  setStaffDept]    = useState("reception");
  const [staffName,  setStaffName]    = useState("");
  const [staffPhone, setStaffPhone]   = useState("");
  
const [staffCustomId, setStaffCustomId] = useState("");
  const [loginRequests, setLoginRequests] = useState([]);
  const [editingStaff, setEditingStaff]   = useState(null);
  const [editName,     setEditName]       = useState("");
  const [editPhone,    setEditPhone]      = useState("");
  const [editRole,     setEditRole]       = useState("");
  const [editDept,     setEditDept]       = useState("");
  const [editStaffId,  setEditStaffId]    = useState("");
  const [savingStaff,  setSavingStaff]    = useState(false);

  // Add patient form
  const [patName,    setPatName]    = useState("");
  const [patAge,     setPatAge]     = useState("");
  const [patPhone,   setPatPhone]   = useState("");
  const [patGender,  setPatGender]  = useState("");
  const [patDept,    setPatDept]    = useState("");
  const [patNotes,   setPatNotes]   = useState("");
  const [patSmsConsent, setPatSmsConsent] = useState(false);
  const [patSmsConsentError, setPatSmsConsentError] = useState("");

  useEffect(() => {
    const q = query(collection(db,"sc_queue"),
      where("hospitalId","==",hospitalId), orderBy("createdAt","desc"));
    const unsub = onSnapshot(q, snap=>{
      setQueue(snap.docs.map(d=>({id:d.id,...d.data()})));
      setLoading(false);
    });
    loadStaff();
    return unsub;
  }, [hospitalId]);

  const transferPatientDept = async () => {
    if (!transferDept) return onToast("Select a department", "error");
    setTransferring(true);
    try {
      const dept = DEPARTMENTS.find(d => d.id === transferDept);
      await updateDoc(doc(db, "sc_queue", transferPatient.id), {
        deptId: transferDept,
        deptLabel: dept?.label || transferDept,
        status: "waiting",
        transferredAt: serverTimestamp(),
        transferredFrom: transferPatient.deptId,
      });
      onToast(`${transferPatient.patientName} transferred to ${dept?.label} ✓`, "success");
      setTransferPatient(null);
      setTransferDept("");
    } catch(err) { onToast(err.message, "error"); }
    setTransferring(false);
  };

  const loadStaff = async () => {
    const snap = await getDocs(query(collection(db,"sc_staff"),where("hospitalId","==",hospitalId)));
    setStaff(snap.docs.map(d=>({id:d.id,...d.data()})));
  };

  const addPatient = async () => {
    if (!patName||!patAge||!patDept) return onToast("Name, age and department are required","error");
    if (!patSmsConsent) {
      setPatSmsConsentError("SMS consent must be confirmed before adding a patient.");
      return;
    }
    setPatSmsConsentError("");
    try {
      const dept = DEPARTMENTS.find(d=>d.id===patDept);
      const today = new Date(); today.setHours(0,0,0,0);
      const todayQ = queue.filter(q=>{
        const ts=q.createdAt?.toDate?.();
        return ts&&ts>=today&&q.deptId===patDept;
      });
     const ticket = genTicket(patDept, todayQ.length);
      await addDoc(collection(db,"sc_queue"),{
        hospitalId, hospitalName:hospitalData?.name||"",
        deptId:patDept, deptLabel:dept?.label||patDept,
        patientName: patName.trim().substring(0, 100).replace(/[<>{}]/g, ""),
        patientAge: Math.min(Math.max(Number(patAge), 0), 150),
        patientPhone: patPhone.trim().substring(0, 20).replace(/[^0-9+\-\s]/g, "") || null,
        patientGender: patGender || null,
        notes: patNotes.trim().substring(0, 500).replace(/[<>{}]/g, "") || null,
        ticket, status:"waiting",
        createdAt:serverTimestamp(), calledAt:null, servedAt:null, completedAt:null,
        checkinType:"receptionist", addedBy:user.email,
        position:todayQ.length+1,
        smsConsent: true,
        smsConsentTimestamp: new Date().toISOString(),
        smsConsentMethod: "staff-assisted-checkbox",
        smsConsentVersion: "v1.0",
      });
      setPatName(""); setPatAge(""); setPatPhone(""); setPatGender(""); setPatDept(""); setPatNotes(""); setPatSmsConsent(false); setPatSmsConsentError("");
      onToast(`${patName} added to ${dept?.label} queue ✓`,"success");
    } catch(err) { onToast(err.message,"error"); }
  };

  const addStaff = async () => {
    if (!staffEmail||!staffName||!staffCustomId)
      return onToast("Fill in name, Staff ID and email","error");
    try {
      // Create Firestore record first — Auth account created by Super Admin or on first login
      const newStaffRef = doc(collection(db,"sc_staff"));
      await setDoc(newStaffRef,{
        email:     staffEmail.trim().toLowerCase(),
        name:      staffName.trim(),
        role:      staffRole,
        deptId:    staffDept,
        hospitalId,
        createdAt: serverTimestamp(),
        staffId:   staffCustomId.trim().toUpperCase(),
        phone:     staffPhone.trim() || null,
        status:    "pending",
        tempPassword: staffPass.trim() || null,
      });
      setStaff(p=>[...p,{
        id:newStaffRef.id, email:staffEmail, name:staffName,
        role:staffRole, deptId:staffDept, staffId:staffCustomId, phone:staffPhone
      }]);
      setStaffEmail(""); setStaffPass(""); setStaffName("");
      setStaffRole("receptionist"); setStaffDept("reception");
      setStaffPhone(""); setStaffCustomId("");
      onToast(`${staffName} added ✓ — Super Admin must activate their login account`, "success");
    } catch(err) { onToast(err.message.replace("Firebase: ",""),"error"); }
  };

  // Load pending login approval requests
  useEffect(() => {
    const q = query(collection(db,"sc_login_requests"),
      where("hospitalId","==",hospitalId), where("status","==","pending"));
    const unsub = onSnapshot(q, snap=>{
      setLoginRequests(snap.docs.map(d=>({id:d.id,...d.data()})));
    });
    return unsub;
  }, [hospitalId]);

  const startEditStaff = (s) => {
    setEditingStaff(s);
    setEditName(s.name || "");
    setEditPhone(s.phone || "");
    setEditRole(s.role || "receptionist");
    setEditDept(s.deptId || "reception");
    setEditStaffId(s.staffId || "");
  };

  const saveEditStaff = async () => {
    if (!editName.trim() || !editStaffId.trim())
      return onToast("Name and Staff ID are required", "error");
    setSavingStaff(true);
    try {
      await updateDoc(doc(db, "sc_staff", editingStaff.id), {
        name:    editName.trim(),
        phone:   editPhone.trim() || null,
        role:    editRole,
        deptId:  editDept,
        staffId: editStaffId.trim().toUpperCase(),
      });
      setStaff(p => p.map(s =>
        s.id === editingStaff.id
          ? { ...s, name: editName.trim(), phone: editPhone.trim()||null,
              role: editRole, deptId: editDept, staffId: editStaffId.trim().toUpperCase() }
          : s
      ));
      setEditingStaff(null);
      onToast("Staff profile updated ✓", "success");
    } catch (err) { onToast(err.message, "error"); }
    setSavingStaff(false);
  };

  const deleteStaff = async (s) => {
    const confirmed = window.confirm(
      `⚠️ DELETE "${s.name || s.email}"?\n\nThis will permanently remove their account. They will no longer be able to log in.\n\nThis cannot be undone.`
    );
    if (!confirmed) return;
    try {
      await deleteDoc(doc(db, "sc_staff", s.id));
      setStaff(p => p.filter(x => x.id !== s.id));
      onToast(`${s.name || s.email} removed ✓`, "warn");
    } catch (err) { onToast(err.message, "error"); }
  };

  const approveLoginRequest = async (req) => {
    await updateDoc(doc(db,"sc_login_requests",req.id),{
      status:"approved", approvedAt:serverTimestamp()
    });
    await writeAuditLog("admin_approved_login",{
      staffId:req.staffId, staffName:req.staffName, hospitalId
    });
    onToast(`${req.staffName} approved ✓`,"success");
  };

  const denyLoginRequest = async (req) => {
    await updateDoc(doc(db,"sc_login_requests",req.id),{
      status:"denied", deniedAt:serverTimestamp()
    });
    onToast(`${req.staffName} login denied`,"warn");
  };

 const updateStatus = async (id, status) => {
    const updates = { status };
    if (status==="called")    updates.calledAt    = serverTimestamp();
    if (status==="serving")   updates.servedAt    = serverTimestamp();
    if (status==="completed") updates.completedAt = serverTimestamp();
    await updateDoc(doc(db,"sc_queue",id), updates);

    // Write to public display collection — ticket/dept only, no patient PII
    if (status === "called" || status === "serving") {
      const qDoc = queue.find(q => q.id === id);
      if (qDoc) {
        await setDoc(doc(db, "sc_display", `${qDoc.hospitalId}_${qDoc.deptId}`), {
          ticket: qDoc.ticket,
          deptId: qDoc.deptId,
          deptLabel: qDoc.deptLabel,
          hospitalId: qDoc.hospitalId,
          status,
          updatedAt: serverTimestamp(),
        });
      }
    }
   
    if (status === "completed" || status === "skipped") {
      const qDoc = queue.find(q => q.id === id);
      if (qDoc) {
        await updateDoc(doc(db, "sc_display", `${qDoc.hospitalId}_${qDoc.deptId}`), {
          status: "clear",
          updatedAt: serverTimestamp(),
        });
      }
    }
  };

  const todayQueue = queue.filter(q=>{
    const ts=q.createdAt?.toDate?.();
    if (!ts) return false;
    const today=new Date(); today.setHours(0,0,0,0);
    return ts>=today;
  });

  const filtered = todayQueue.filter(q=>
    (filterDept==="all"||q.deptId===filterDept) &&
    (filterStatus==="all"||q.status===filterStatus)
  );

  const waiting   = todayQueue.filter(q=>q.status==="waiting").length;
  const serving   = todayQueue.filter(q=>q.status==="serving").length;
  const completed = todayQueue.filter(q=>q.status==="completed").length;

  // ── Billing ───────────────────────────────────────────────────────────────
  const [bills, setBills]           = useState([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [selPatientBill, setSelPatientBill] = useState("");
  const [billServices, setBillServices]     = useState([{name:"",cost:""}]);
  const [billNotes, setBillNotes]   = useState("");
  const [showBill, setShowBill]     = useState(null);
  const LRD_RATE = 194;

  const loadBills = async () => {
    setBillsLoading(true);
    try {
      const snap = await getDocs(query(
        collection(db, "sc_bills"),
        where("hospitalId", "==", hospitalId),
        orderBy("createdAt", "desc")
      ));
      setBills(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch(err) { console.error("loadBills error:", err); }
    setBillsLoading(false);
  };

  useEffect(() => {
    if (tab === "billing") loadBills();
  }, [tab]);

  const addBillRow    = () => setBillServices(p=>[...p,{name:"",cost:""}]);
  const updateBillRow = (i,field,val) => setBillServices(p=>p.map((r,idx)=>idx===i?{...r,[field]:val}:r));
  const removeBillRow = (i) => setBillServices(p=>p.filter((_,idx)=>idx!==i));

  const saveBill = async () => {
    if (!selPatientBill) return onToast("Select a patient","error");
    const validServices = billServices.filter(s=>s.name&&s.cost);
    if (!validServices.length) return onToast("Add at least one service","error");
    const totalUSD = validServices.reduce((a,s)=>a+parseFloat(s.cost||0),0);
    const patient = queue.find(q=>q.id===selPatientBill);
    try {
      const ref = await addDoc(collection(db,"sc_bills"),{
        hospitalId, patientName:patient?.patientName||"Unknown",
        patientPhone:patient?.patientPhone||null,
        services:validServices, totalUSD,
        totalLRD: totalUSD*LRD_RATE,
        notes:billNotes||null,
        status:"unpaid", createdAt:serverTimestamp(),
        queueId:selPatientBill,
      });
      setBills(p=>[{id:ref.id,patientName:patient?.patientName,services:validServices,
        totalUSD,totalLRD:totalUSD*LRD_RATE,status:"unpaid",createdAt:new Date()},...p]);
      setBillServices([{name:"",cost:""}]); setBillNotes(""); setSelPatientBill("");
      onToast("Invoice created ✓","success");
    } catch(err) { onToast(err.message,"error"); }
  };

  const markBillPaid = async (id) => {
    await updateDoc(doc(db,"sc_bills",id),{status:"paid",paidAt:serverTimestamp()});
    setBills(p=>p.map(b=>b.id===id?{...b,status:"paid"}:b));
    onToast("Marked as paid ✓","success");
  };

  const printBill = (bill) => {
    const win = window.open("","_blank");
    win.document.write(`<!DOCTYPE html><html><head><title>Invoice — ${bill.patientName}</title>
    <style>body{font-family:Arial,sans-serif;padding:40px;max-width:600px;margin:0 auto}
    .logo{font-size:24px;font-weight:900;color:#2563eb;margin-bottom:4px}
    .sub{font-size:12px;color:#64748b;margin-bottom:32px}
    h2{margin-bottom:16px}table{width:100%;border-collapse:collapse;margin-bottom:24px}
    th{background:#2563eb;color:#fff;padding:10px;text-align:left}
    td{padding:9px;border-bottom:1px solid #eee}
    .total{font-size:20px;font-weight:700;text-align:right}
    .paid{color:#10b981;font-weight:700}
    @media print{body{padding:20px}}</style></head><body>
    <div class="logo">🏥 SwiftCare</div>
    <div class="sub">${hospitalData?.name||"Hospital"} · ${new Date().toLocaleDateString()}</div>
    <h2>Invoice — ${bill.patientName}</h2>
    <table><thead><tr><th>Service</th><th>Cost (USD)</th><th>Cost (LRD)</th></tr></thead>
    <tbody>${bill.services.map(s=>`<tr><td>${s.name}</td><td>$${parseFloat(s.cost).toFixed(2)}</td><td>L$${(parseFloat(s.cost)*LRD_RATE).toFixed(2)}</td></tr>`).join("")}
    </tbody></table>
    <div class="total">Total: $${bill.totalUSD.toFixed(2)} USD / L$${bill.totalLRD.toFixed(2)} LRD</div>
    ${bill.status==="paid"?'<div class="paid" style="margin-top:12px">✓ PAID</div>':""}
    ${bill.notes?`<div style="margin-top:16px;color:#64748b;font-size:13px">Notes: ${bill.notes}</div>`:""}
    <script>window.onload=()=>window.print()<\/script></body></html>`);
    win.document.close();
  };

  // ── Patient Records ───────────────────────────────────────────────────────
  const [patients, setPatients]       = useState([]);
  const [patSearch, setPatSearch]     = useState("");
  const [selPatient, setSelPatient]   = useState(null);
  const [patHistory, setPatHistory]   = useState([]);
  const [loadingPats, setLoadingPats] = useState(false);
  const [patFilterDept, setPatFilterDept] = useState("all");
  const [patFilterDate, setPatFilterDate] = useState("");

  const searchPatients = async () => {
    if (!patSearch.trim()) return;
    setLoadingPats(true);
    try {
      const snap = await getDocs(query(collection(db,"sc_queue"),
        where("hospitalId","==",hospitalId)));
      const all = snap.docs.map(d=>({id:d.id,...d.data()}));
      const term = patSearch.toLowerCase();
      const unique = {};
      all.filter(p=>p.patientName?.toLowerCase().includes(term)||p.patientPhone?.includes(term))
        .forEach(p=>{ if (!unique[p.patientPhone||p.patientName]) unique[p.patientPhone||p.patientName]=p; });
      setPatients(Object.values(unique));
    } catch(err) { onToast(err.message,"error"); }
    setLoadingPats(false);
  };

  const loadPatientHistory = async (patient) => {
    setSelPatient(patient);
    setPatHistory([]);
    try {
      const snap = await getDocs(query(
        collection(db, "sc_queue"),
        where("hospitalId", "==", hospitalId)
      ));
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const history = all.filter(v => {
        if (patient.patientPhone) {
          return v.patientPhone === patient.patientPhone ||
                 v.patientName?.toLowerCase() === patient.patientName?.toLowerCase();
        }
        return v.patientName?.toLowerCase() === patient.patientName?.toLowerCase();
      }).sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      setPatHistory(history);
    } catch (err) {
      console.error("loadPatientHistory error:", err);
    }
  };

  const tabs = [
    {key:"queue",    label:"📋 Live Queue"},
    {key:"checkin",  label:"➕ Add Patient"},
    {key:"billing",  label:"💰 Billing"},
    {key:"records",  label:"📁 Records"},
    {key:"staff",    label:"👨‍⚕️ Staff"},
    {key:"reports",  label:"📊 Reports"},
  ];

  return (
    <div style={{ minHeight:"100dvh", background:"var(--bg)" }}>
      {/* Header */}
      <div style={{ background:"#fff", borderBottom:"1px solid var(--border)",
        padding:"14px 20px", display:"flex", justifyContent:"space-between",
        alignItems:"center", boxShadow:"var(--shadow)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36,height:36,background:"var(--blue)",borderRadius:9,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:18 }}>🏥</div>
          <div>
            <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:18,color:"var(--blue)"}}>
              SwiftCare
            </div>
            <div style={{fontSize:11,color:"var(--muted)"}}>{hospitalData?.name} · Admin</div>
          </div>
        </div>
        <Btn variant="ghost" size="sm" onClick={()=>signOut(auth)}>Sign Out</Btn>
      </div>

      {/* Stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:1,
        background:"var(--border)", borderBottom:"1px solid var(--border)" }}>
        {[
          {label:"Waiting",   val:waiting,   color:"var(--blue)"},
          {label:"In Progress", val:serving, color:"var(--green)"},
          {label:"Completed", val:completed, color:"var(--muted)"},
          {label:"Total Today",val:todayQueue.length, color:"var(--text)"},
        ].map(s=>(
          <div key={s.label} style={{background:"#fff",padding:"14px 20px",textAlign:"center"}}>
            <div style={{fontFamily:"var(--font-h)",fontSize:28,fontWeight:900,color:s.color}}>{s.val}</div>
            <div style={{fontSize:11,color:"var(--muted)",letterSpacing:1,textTransform:"uppercase"}}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:4,padding:"16px 20px 0",borderBottom:"1px solid var(--border)",background:"#fff"}}>
        {tabs.map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)} style={{
            padding:"9px 16px", border:"none", fontWeight:600, fontSize:13,
            cursor:"pointer", fontFamily:"var(--font)", background:"transparent",
            color: tab===t.key ? "var(--blue)" : "var(--muted)",
            borderBottom: tab===t.key ? "2px solid var(--blue)" : "2px solid transparent",
            borderRadius:"8px 8px 0 0",
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{padding:20, maxWidth:900, margin:"0 auto"}}>
        {/* Live Queue */}
       {tab==="queue" && (
          <div className="fade-in">

            {/* Transfer Modal */}
            {transferPatient && (
              <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",
                display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
                <Card style={{width:"100%",maxWidth:420}}>
                  <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:18,
                    color:"var(--blue)",marginBottom:8}}>↪ Transfer Patient</div>
                  <div style={{fontSize:13,color:"var(--muted)",marginBottom:16}}>
                    Transferring <strong>{transferPatient.patientName}</strong> from{" "}
                    <strong>{transferPatient.deptLabel}</strong>
                  </div>
                  <select value={transferDept} onChange={e=>setTransferDept(e.target.value)}
                    style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,
                      fontSize:14,background:"#fff",width:"100%",marginBottom:16,
                      color:transferDept?"var(--text)":"var(--muted)"}}>
                    <option value="">Select destination department *</option>
                    {DEPARTMENTS.filter(d=>d.id!==transferPatient.deptId).map(d=>(
                      <option key={d.id} value={d.id}>{d.icon} {d.label}</option>
                    ))}
                  </select>
                  <div style={{display:"flex",gap:8}}>
                    <Btn style={{flex:1,padding:"12px 0"}} onClick={transferPatientDept} disabled={transferring}>
                      {transferring?"Transferring…":"↪ Confirm Transfer"}
                    </Btn>
                    <Btn variant="ghost" style={{flex:1,padding:"12px 0"}}
                      onClick={()=>{setTransferPatient(null);setTransferDept("");}}>
                      Cancel
                    </Btn>
                  </div>
                </Card>
              </div>
            )}

            {/* Filters */}
            <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
              <select value={filterDept} onChange={e=>setFilterDept(e.target.value)}
                style={{padding:"8px 12px",border:"1px solid var(--border)",borderRadius:8,fontSize:13,background:"#fff"}}>
                <option value="all">All Departments</option>
                {DEPARTMENTS.map(d=><option key={d.id} value={d.id}>{d.icon} {d.label}</option>)}
              </select>
              <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}
                style={{padding:"8px 12px",border:"1px solid var(--border)",borderRadius:8,fontSize:13,background:"#fff"}}>
                <option value="all">All Statuses</option>
                {Object.entries(STATUS_COLORS).map(([k,v])=>(
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
              <div style={{marginLeft:"auto",fontSize:13,color:"var(--muted)",alignSelf:"center"}}>
                {filtered.length} patient{filtered.length!==1?"s":""}
              </div>
            </div>

            {loading ? (
              <div style={{textAlign:"center",padding:40,color:"var(--muted)"}}>Loading queue…</div>
            ) : filtered.length===0 ? (
              <Card style={{textAlign:"center",padding:40}}>
                <div style={{fontSize:32,marginBottom:8}}>😊</div>
                <div style={{fontWeight:600,marginBottom:4}}>Queue is empty</div>
                <div style={{fontSize:14,color:"var(--muted)"}}>No patients in queue right now.</div>
              </Card>
            ) : filtered.map(q=>{
              const dept = DEPARTMENTS.find(d=>d.id===q.deptId);
              return (
                <Card key={q.id} style={{marginBottom:10,borderLeft:`4px solid ${dept?.color||"var(--blue)"}`}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                    {/* Ticket */}
                    <div style={{background:dept?.color||"var(--blue)",color:"#fff",
                      borderRadius:10,padding:"8px 14px",textAlign:"center",minWidth:72}}>
                      <div style={{fontSize:10,fontWeight:600,opacity:0.8}}>TICKET</div>
                      <div style={{fontFamily:"var(--font-h)",fontSize:20,fontWeight:900}}>{q.ticket}</div>
                    </div>

                    {/* Patient info */}
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:15}}>{q.patientName}</div>
                      <div style={{fontSize:12,color:"var(--muted)"}}>
                        {q.patientAge}yr {q.patientGender&&`· ${q.patientGender}`} · {dept?.icon} {q.deptLabel}
                      </div>
                      <div style={{fontSize:12,color:"var(--muted)"}}>
                        Arrived: {fmtTime(q.createdAt)} · Waited: {waitTime(q.createdAt)}
                        {q.status==="waiting" && (() => {
                          const ahead = filtered.filter(x => x.status==="waiting" && x.createdAt?.toMillis?.() < q.createdAt?.toMillis?.()).length;
                          const estMins = ahead * 10;
                          return <span style={{color:"var(--blue)",marginLeft:6}}>· Est. wait: {estMins < 5 ? "< 5 min" : `~${estMins} min`}</span>;
                        })()}
                      </div>
                      {q.notes && <div style={{fontSize:12,color:"var(--blue)",marginTop:2}}>📝 {q.notes}</div>}
                    </div>

                    {/* Status & Actions */}
                    <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
                      <Badge status={q.status} />
                      <div style={{display:"flex",gap:6}}>
                        {q.status==="waiting" && (
                          <Btn size="sm" onClick={()=>updateStatus(q.id,"called")}>📢 Call</Btn>
                        )}
                        {q.status==="called" && (
                          <Btn size="sm" variant="success" onClick={()=>updateStatus(q.id,"serving")}>▶ Start</Btn>
                        )}
                        {q.status==="serving" && (
                          <Btn size="sm" variant="success" onClick={()=>updateStatus(q.id,"completed")}>✅ Done</Btn>
                        )}
                        {q.status==="completed" && (
                          <Btn size="sm" variant="ghost" onClick={()=>{
                            const dept = DEPARTMENTS.find(d=>d.id===q.deptId);
                            const win = window.open("","_blank");
                            win.document.write(`<!DOCTYPE html><html><head><title>Discharge Summary</title>
                            <style>body{font-family:Arial,sans-serif;padding:40px;max-width:600px;margin:0 auto}
                            .logo{font-size:24px;font-weight:900;color:#2563eb;margin-bottom:4px}
                            .sub{font-size:12px;color:#64748b;margin-bottom:32px}
                            h2{margin-bottom:16px;color:#0f172a}
                            .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee}
                            .label{color:#64748b;font-size:13px}
                            .value{font-weight:600;font-size:13px}
                            .badge{background:#dcfce7;color:#166534;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700}
                            @media print{body{padding:20px}}</style></head><body>
                            <div class="logo">🏥 SwiftCare</div>
                            <div class="sub">${hospitalData?.name||"Hospital"} · ${new Date().toLocaleDateString()}</div>
                            <h2>Discharge Summary</h2>
                            <div class="row"><span class="label">Patient Name</span><span class="value">${q.patientName}</span></div>
                            <div class="row"><span class="label">Age / Gender</span><span class="value">${q.patientAge}yr · ${q.patientGender||"—"}</span></div>
                            <div class="row"><span class="label">Phone</span><span class="value">${q.patientPhone||"—"}</span></div>
                            <div class="row"><span class="label">Department</span><span class="value">${dept?.icon} ${q.deptLabel}</span></div>
                            <div class="row"><span class="label">Ticket</span><span class="value">#${q.ticket}</span></div>
                            <div class="row"><span class="label">Arrived</span><span class="value">${fmtTime(q.createdAt)} · ${fmtDate(q.createdAt)}</span></div>
                            <div class="row"><span class="label">Completed</span><span class="value">${fmtTime(q.completedAt)}</span></div>
                            <div class="row"><span class="label">Status</span><span class="value"><span class="badge">✓ Discharged</span></span></div>
                            ${q.notes?`<div class="row"><span class="label">Notes</span><span class="value">${q.notes}</span></div>`:""}
                            <div style="margin-top:40px;font-size:12px;color:#64748b;text-align:center">
                              Generated by SwiftCare · ${hospitalData?.name||"Hospital"} · ${new Date().toLocaleString()}
                            </div>
                            <script>window.onload=()=>window.print()<\/script></body></html>`);
                            win.document.close();
                          }}>🖨 Discharge</Btn>
                        )}
                        {(q.status==="waiting"||q.status==="called") && (
                          <Btn size="sm" variant="ghost" onClick={()=>updateStatus(q.id,"skipped")}>⏭ Skip</Btn>
                        )}
                        {q.status==="waiting" && (
                          <Btn size="sm" variant="outline" onClick={()=>setTransferPatient(q)}>↪ Transfer</Btn>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {/* Add Patient (Receptionist) */}
        {tab==="checkin" && (
          <div className="fade-in">
            <Card style={{maxWidth:520}}>
              <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:18,
                color:"var(--blue)",marginBottom:16}}>Add Patient to Queue</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <Input placeholder="Patient full name *" value={patName} onChange={e=>setPatName(e.target.value)} />
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <Input placeholder="Age *" value={patAge} onChange={e=>setPatAge(e.target.value)} type="number" />
                  <select value={patGender} onChange={e=>setPatGender(e.target.value)}
                    style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,fontSize:14,background:"#fff",
                      color:patGender?"var(--text)":"var(--muted)"}}>
                    <option value="">Gender</option>
                    <option>Male</option><option>Female</option><option>Other</option>
                  </select>
                </div>
                <Input placeholder="Phone number" value={patPhone} onChange={e=>setPatPhone(e.target.value)} type="tel" />
                <select value={patDept} onChange={e=>setPatDept(e.target.value)}
                  style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,fontSize:14,background:"#fff",
                    color:patDept?"var(--text)":"var(--muted)"}}>
                  <option value="">Select department *</option>
                  {DEPARTMENTS.map(d=><option key={d.id} value={d.id}>{d.icon} {d.label}</option>)}
                </select>
                {/* SMS Consent */}
                <label style={{ display:"flex", alignItems:"flex-start", gap:10, cursor:"pointer",
                  padding:"12px 14px", background:"#f0f9ff", border:`1px solid ${patSmsConsentError?"var(--red)":"#bae6fd"}`,
                  borderRadius:8 }}>
                  <input type="checkbox" checked={patSmsConsent}
                    onChange={e=>{ setPatSmsConsent(e.target.checked); if(e.target.checked) setPatSmsConsentError(""); }}
                    style={{ marginTop:3, width:17, height:17, flexShrink:0, accentColor:"var(--blue)", cursor:"pointer" }} />
                  <span style={{ fontSize:13, color:"#334155", lineHeight:1.5 }}>
                    Patient verbally confirmed: agrees to receive SMS queue updates from{" "}
                    <strong>{hospitalData?.name}</strong> via SwiftCare. Msg &amp; data rates may apply. Reply{" "}
                    <strong>STOP</strong> to opt out.
                  </span>
                </label>
                {patSmsConsentError && (
                  <div style={{ fontSize:13, color:"var(--red)", fontWeight:600, marginTop:-4 }}>
                    ⚠ {patSmsConsentError}
                  </div>
                )}
                <textarea value={patNotes} onChange={e=>setPatNotes(e.target.value)}
                  placeholder="Notes (symptoms, reason for visit…)"
                  style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,
                    fontSize:14,background:"#fff",resize:"vertical",minHeight:80,fontFamily:"var(--font)"}} />
                <Btn style={{width:"100%",padding:"13px 0"}} onClick={addPatient}>
                  ➕ Add to Queue
                </Btn>
              </div>
            </Card>
          </div>
        )}

        {/* Staff */}
        {tab==="staff" && (
          <div className="fade-in">

            {/* Login Approval Requests */}
            {loginRequests.length > 0 && (
              <Card style={{marginBottom:16,borderLeft:"4px solid var(--amber)",background:"#fffbeb"}}>
                <div style={{fontWeight:700,fontSize:15,color:"#92400e",marginBottom:12}}>
                  🔔 Pending Login Approvals ({loginRequests.length})
                </div>
                {loginRequests.map(req=>(
                  <div key={req.id} style={{display:"flex",alignItems:"center",
                    justifyContent:"space-between",padding:"10px 0",
                    borderBottom:"1px solid #fde68a",flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{fontWeight:600,fontSize:14}}>{req.staffName}</div>
                      <div style={{fontSize:12,color:"var(--muted)"}}>
                        Staff ID: {req.staffId} · {fmtTime(req.createdAt)}
                      </div>
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <Btn variant="success" size="sm" onClick={()=>approveLoginRequest(req)}>
                        ✅ Approve
                      </Btn>
                      <Btn variant="danger" size="sm" onClick={()=>denyLoginRequest(req)}>
                        ❌ Deny
                      </Btn>
                    </div>
                  </div>
                ))}
              </Card>
            )}

            <Card style={{marginBottom:16}}>
              <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:18,
                color:"var(--blue)",marginBottom:16}}>Add Staff Member</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <Input placeholder="Full name *" value={staffName} onChange={e=>setStaffName(e.target.value)} />
                <Input placeholder="Staff ID * (e.g. JFK-001)" value={staffCustomId}
                  onChange={e=>setStaffCustomId(e.target.value.toUpperCase())} />
                <Input placeholder="Phone (for SMS 2FA)" value={staffPhone}
                  onChange={e=>setStaffPhone(e.target.value)} type="tel" />
                <Input placeholder="Email *" value={staffEmail} onChange={e=>setStaffEmail(e.target.value)} type="email" />
                <Input placeholder="Temporary password (optional)" value={staffPass} onChange={e=>setStaffPass(e.target.value)} type="password" />
                <select value={staffRole} onChange={e=>setStaffRole(e.target.value)}
                  style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,fontSize:14,background:"#fff"}}>
                  <option value="receptionist">Receptionist</option>
                  <option value="nurse">Nurse / Triage</option>
                  <option value="doctor">Doctor</option>
                  <option value="lab">Lab Technician</option>
                  <option value="pharmacist">Pharmacist</option>
                  <option value="cashier">Cashier / Billing</option>
                </select>
                <select value={staffDept} onChange={e=>setStaffDept(e.target.value)}
                  style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,fontSize:14,background:"#fff",gridColumn:"span 2"}}>
                  {DEPARTMENTS.map(d=><option key={d.id} value={d.id}>{d.icon} {d.label}</option>)}
                </select>
              </div>
              <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>
                💡 Staff without a phone will require Admin approval to login each time.
              </div>
              <Btn style={{width:"100%"}} onClick={addStaff}>+ Create Staff Account</Btn>
            </Card>

            <div style={{fontWeight:700,marginBottom:12}}>{staff.filter(s=>s.role!=="admin").length} staff members</div>

            {/* Edit Staff Modal */}
            {editingStaff && (
              <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",
                display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
                <Card style={{width:"100%",maxWidth:500,maxHeight:"90vh",overflowY:"auto"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                    <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:18,color:"var(--blue)"}}>
                      ✏️ Edit Staff Profile
                    </div>
                    <button onClick={()=>setEditingStaff(null)}
                      style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:"var(--muted)"}}>×</button>
                  </div>
                  <div style={{fontSize:12,color:"var(--muted)",marginBottom:12}}>
                    Account: <strong>{editingStaff.email}</strong>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <Input placeholder="Full name *" value={editName} onChange={e=>setEditName(e.target.value)} />
                    <Input placeholder="Staff ID * (e.g. BGH-001)" value={editStaffId}
                      onChange={e=>setEditStaffId(e.target.value.toUpperCase())} />
                    <Input placeholder="Phone (for SMS 2FA)" value={editPhone}
                      onChange={e=>setEditPhone(e.target.value)} type="tel" />
                    <select value={editRole} onChange={e=>setEditRole(e.target.value)}
                      style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,fontSize:14,background:"#fff"}}>
                      <option value="receptionist">Receptionist</option>
                      <option value="nurse">Nurse / Triage</option>
                      <option value="doctor">Doctor</option>
                      <option value="lab">Lab Technician</option>
                      <option value="pharmacist">Pharmacist</option>
                      <option value="cashier">Cashier / Billing</option>
                    </select>
                    <select value={editDept} onChange={e=>setEditDept(e.target.value)}
                      style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,fontSize:14,background:"#fff"}}>
                      {DEPARTMENTS.map(d=><option key={d.id} value={d.id}>{d.icon} {d.label}</option>)}
                    </select>
                    <div style={{background:"var(--blue-l)",borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:12,color:"var(--blue)",fontWeight:600,marginBottom:8}}>
                        🔑 Password Reset
                      </div>
                      <div style={{fontSize:12,color:"var(--muted)",marginBottom:10}}>
                        Send a password reset link directly to this staff member's email.
                      </div>
                      <Btn variant="outline" size="sm" onClick={async()=>{
                        try {
                          await sendPasswordResetEmail(auth, editingStaff.email);
                          onToast(`Reset email sent to ${editingStaff.email} ✓`,"success");
                        } catch(err) { onToast(err.message,"error"); }
                      }}>
                        📧 Send Password Reset Email
                      </Btn>
                    </div>
                    <div style={{display:"flex",gap:8,marginTop:4}}>
                      <Btn style={{flex:1,padding:"12px 0"}} onClick={saveEditStaff} disabled={savingStaff}>
                        {savingStaff?"Saving…":"✅ Save Changes"}
                      </Btn>
                      <Btn variant="ghost" style={{flex:1,padding:"12px 0"}} onClick={()=>setEditingStaff(null)}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                </Card>
              </div>
            )}

            {staff.filter(s=>s.role!=="admin").map(s=>{
              const dept = DEPARTMENTS.find(d=>d.id===s.deptId);
              return (
                <Card key={s.id} style={{marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{fontWeight:600}}>{s.name||s.email}</div>
                      <div style={{fontSize:12,color:"var(--muted)"}}>
                        ID: <strong>{s.staffId||"—"}</strong> · {s.email}
                      </div>
                      <div style={{fontSize:12,color:"var(--blue)",marginTop:2}}>
                        {dept?.icon} {dept?.label} · {s.role}
                      </div>
                      <div style={{fontSize:12,marginTop:2}}>
                        {s.phone
                          ? <span style={{color:"var(--green)"}}>📱 SMS 2FA enabled</span>
                          : <span style={{color:"var(--amber)"}}>⚠️ No phone — Admin approval required</span>
                        }
                      </div>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontSize:12,padding:"3px 10px",borderRadius:20,
                        background:"var(--blue-l)",color:"var(--blue)",fontWeight:600}}>
                        {s.role}
                      </span>
                      <Btn variant="outline" size="sm" onClick={()=>startEditStaff(s)}>✏️ Edit</Btn>
                      <Btn variant="danger" size="sm" onClick={()=>deleteStaff(s)}>🗑 Delete</Btn>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {/* Reports */}
        {tab==="reports" && (
          <ReportsDashboard hospitalId={hospitalId} queue={queue} />
        )}
        

        {/* Billing */}
        {tab==="billing" && (
          <div className="fade-in">
            <Card style={{marginBottom:16}}>
              <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:18,
                color:"var(--blue)",marginBottom:16}}>💰 Create Invoice</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <select value={selPatientBill} onChange={e=>setSelPatientBill(e.target.value)}
                  style={{padding:"10px 13px",border:"1px solid var(--border)",borderRadius:8,
                    fontSize:14,background:"#fff",color:selPatientBill?"var(--text)":"var(--muted)"}}>
                  <option value="">Select patient from today's queue…</option>
                  {todayQueue.map(q=>(
                    <option key={q.id} value={q.id}>{q.patientName} — {q.deptLabel} (#{q.ticket})</option>
                  ))}
                </select>

                <div style={{fontWeight:600,marginTop:4}}>Services</div>
                {billServices.map((s,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 120px 36px",gap:8}}>
                    <Input placeholder="Service name (e.g. Consultation)" value={s.name}
                      onChange={e=>updateBillRow(i,"name",e.target.value)} />
                    <Input placeholder="Cost (USD)" value={s.cost} type="number"
                      onChange={e=>updateBillRow(i,"cost",e.target.value)} />
                    <button onClick={()=>removeBillRow(i)}
                      style={{background:"#fee2e2",color:"var(--red)",border:"none",borderRadius:8,
                        cursor:"pointer",fontWeight:700,fontSize:16}}>×</button>
                  </div>
                ))}
                <Btn variant="ghost" size="sm" style={{alignSelf:"flex-start"}} onClick={addBillRow}>
                  + Add Service
                </Btn>

                {billServices.filter(s=>s.name&&s.cost).length>0 && (
                  <div style={{background:"var(--blue-l)",borderRadius:8,padding:"12px 16px"}}>
                    <div style={{fontWeight:700,color:"var(--blue)"}}>
                      Total: ${billServices.filter(s=>s.cost).reduce((a,s)=>a+parseFloat(s.cost||0),0).toFixed(2)} USD
                    </div>
                    <div style={{fontSize:13,color:"var(--muted)"}}>
                      = L${(billServices.filter(s=>s.cost).reduce((a,s)=>a+parseFloat(s.cost||0),0)*LRD_RATE).toFixed(2)} LRD
                    </div>
                  </div>
                )}

                <Input placeholder="Notes (optional)" value={billNotes} onChange={e=>setBillNotes(e.target.value)} />
                <Btn style={{width:"100%"}} onClick={saveBill}>🧾 Generate Invoice</Btn>
              </div>
            </Card>

            <div style={{fontWeight:700,marginBottom:12}}>Recent Invoices ({bills.length})</div>
            {billsLoading && (
              <div style={{color:"var(--muted)",fontSize:14,padding:20,textAlign:"center"}}>Loading invoices…</div>
            )}
            {!billsLoading && bills.length===0 && (
              <div style={{color:"var(--muted)",fontSize:14}}>No invoices yet.</div>
            )}
            {bills.map(b=>(
              <Card key={b.id} style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontWeight:700}}>{b.patientName}</div>
                    <div style={{fontSize:12,color:"var(--muted)"}}>
                      {b.services?.length} service{b.services?.length!==1?"s":""} · {fmtDate(b.createdAt)}
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontWeight:800,fontSize:18,color:"var(--blue)"}}>
                      ${b.totalUSD?.toFixed(2)} USD
                    </div>
                    <div style={{fontSize:12,color:"var(--muted)"}}>L${b.totalLRD?.toFixed(2)} LRD</div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <span style={{padding:"3px 10px",borderRadius:20,fontSize:12,fontWeight:700,
                      background:b.status==="paid"?"#dcfce7":"#fef3c7",
                      color:b.status==="paid"?"#166534":"#92400e"}}>
                      {b.status==="paid"?"✓ Paid":"⏳ Unpaid"}
                    </span>
                    {b.status!=="paid"&&(
                      <Btn variant="success" size="sm" onClick={()=>markBillPaid(b.id)}>Mark Paid</Btn>
                    )}
                    <Btn variant="ghost" size="sm" onClick={()=>printBill(b)}>🖨 Print</Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Patient Records */}
        {tab==="records" && (
          <div className="fade-in">
            {!selPatient ? (
              <>
                <Card style={{marginBottom:16}}>
                  <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:18,
                    color:"var(--blue)",marginBottom:12}}>📁 Patient Records</div>
                  <div style={{display:"flex",gap:8,marginBottom:8}}>
                    <Input placeholder="Search by name or phone number…" value={patSearch}
                      onChange={e=>setPatSearch(e.target.value)}
                      style={{flex:1}}
                      onKeyDown={e=>e.key==="Enter"&&searchPatients()} />
                    <Btn onClick={searchPatients} disabled={loadingPats}>
                      {loadingPats?"Searching…":"🔍 Search"}
                    </Btn>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <select value={patFilterDept} onChange={e=>setPatFilterDept(e.target.value)}
                      style={{padding:"8px 12px",border:"1px solid var(--border)",borderRadius:8,fontSize:13,background:"#fff"}}>
                      <option value="all">All Departments</option>
                      {DEPARTMENTS.map(d=><option key={d.id} value={d.id}>{d.icon} {d.label}</option>)}
                    </select>
                    <input type="date" value={patFilterDate} onChange={e=>setPatFilterDate(e.target.value)}
                      style={{padding:"8px 12px",border:"1px solid var(--border)",borderRadius:8,fontSize:13,background:"#fff"}} />
                    {(patFilterDept!=="all"||patFilterDate) && (
                      <Btn variant="ghost" size="sm" onClick={()=>{setPatFilterDept("all");setPatFilterDate("");}}>
                        ✕ Clear filters
                      </Btn>
                    )}
                  </div>
                </Card>
                {patients.length>0 && (
                  <div>
                    <div style={{fontWeight:600,marginBottom:12}}>{patients.length} patient{patients.length!==1?"s":""} found</div>
                    {patients.filter(p => {
                        if (patFilterDept !== "all" && p.deptId !== patFilterDept) return false;
                        if (patFilterDate) {
                          const d = p.createdAt?.toDate?.();
                          if (!d) return false;
                          const dateStr = d.toISOString().split("T")[0];
                          if (dateStr !== patFilterDate) return false;
                        }
                        return true;
                      }).map((p,i)=>(
                      <Card key={i} style={{marginBottom:8,cursor:"pointer"}}
                        onClick={()=>loadPatientHistory(p)}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div>
                            <div style={{fontWeight:700}}>{p.patientName}</div>
                            <div style={{fontSize:12,color:"var(--muted)"}}>
                              {p.patientAge}yr · {p.patientGender||"—"} · {p.patientPhone||"No phone"}
                            </div>
                          </div>
                          
<Btn variant="outline" size="sm"
  onClick={(e) => { e.stopPropagation(); loadPatientHistory(p); }}>
  View History →
</Btn>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
                  <Btn variant="ghost" size="sm" onClick={()=>{setSelPatient(null);setPatHistory([]);}}>← Back</Btn>
                  <div style={{fontWeight:700,fontSize:18}}>{selPatient.patientName}</div>
                </div>

                <Card style={{marginBottom:16}}>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                    {[
                      {label:"Age",    val:`${selPatient.patientAge} years`},
                      {label:"Gender", val:selPatient.patientGender||"—"},
                      {label:"Phone",  val:selPatient.patientPhone||"—"},
                    ].map(s=>(
                      <div key={s.label}>
                        <div style={{fontSize:11,color:"var(--muted)",marginBottom:2}}>{s.label}</div>
                        <div style={{fontWeight:600}}>{s.val}</div>
                      </div>
                    ))}
                  </div>
                </Card>

                <div style={{fontWeight:700,marginBottom:12}}>
                  Visit History ({patHistory.length} visit{patHistory.length!==1?"s":""})
                </div>
                {patHistory.length === 0 && <div style={{color:"var(--muted)",padding:20,textAlign:"center"}}>No visit history found for this patient.</div>}
                {patHistory.map(v=>{
                  const dept = DEPARTMENTS.find(d=>d.id===v.deptId);
                  return (
                    <Card key={v.id} style={{marginBottom:8,borderLeft:`3px solid ${dept?.color||"var(--blue)"}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                        <div>
                          <div style={{fontWeight:600}}>{dept?.icon} {v.deptLabel}</div>
                          <div style={{fontSize:12,color:"var(--muted)"}}>
                            {fmtDate(v.createdAt)} · Ticket #{v.ticket}
                          </div>
                          {v.notes&&<div style={{fontSize:13,color:"var(--blue)",marginTop:4}}>📝 {v.notes}</div>}
                        </div>
                        <span style={{padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:600,
                          background:v.status==="completed"?"#dcfce7":"#dbeafe",
                          color:v.status==="completed"?"#166534":"#1d4ed8"}}>
                          {STATUS_COLORS[v.status]?.label||v.status}
                        </span>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Staff Queue View ─────────────────────────────────────────────────────────
function StaffQueue({ user, staffData, hospitalData, onToast }) {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(
      collection(db,"sc_queue"),
      where("hospitalId","==",staffData.hospitalId),
      where("deptId","==",staffData.deptId),
      orderBy("createdAt","asc")
    );
    const unsub = onSnapshot(q, snap=>{
      const today = new Date(); today.setHours(0,0,0,0);
      const all = snap.docs.map(d=>({id:d.id,...d.data()}))
        .filter(q=>{ const ts=q.createdAt?.toDate?.(); return ts&&ts>=today; });
      setQueue(all);
      setLoading(false);
    });
    return unsub;
  }, [staffData]);

  const updateStatus = async (id, status) => {
    const updates = { status };
    if (status==="called")    updates.calledAt    = serverTimestamp();
    if (status==="serving")   updates.servedAt    = serverTimestamp();
    if (status==="completed") updates.completedAt = serverTimestamp();
    await updateDoc(doc(db,"sc_queue",id), updates);
    await writeAuditLog("queue_status_update", {
      queueId: id,
      newStatus: status,
      staffEmail: user.email,
      staffId: user.uid,
      hospitalId: staffData.hospitalId,
      deptId: staffData.deptId,
    });
    onToast(status==="completed" ? "Patient marked done ✓" : "Status updated ✓","success");
  };

  const dept = DEPARTMENTS.find(d=>d.id===staffData.deptId);
  const waiting   = queue.filter(q=>q.status==="waiting").length;
  const serving   = queue.filter(q=>q.status==="serving").length;
  const completed = queue.filter(q=>q.status==="completed").length;

  return (
    <div style={{ minHeight:"100dvh", background:"var(--bg)" }}>
      {/* Header */}
      <div style={{ background:"#fff", borderBottom:"1px solid var(--border)",
        padding:"14px 20px", display:"flex", justifyContent:"space-between",
        alignItems:"center", boxShadow:"var(--shadow)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36,height:36,borderRadius:9,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,
            background:`${dept?.color||"var(--blue)"}22` }}>
            {dept?.icon||"🏥"}
          </div>
          <div>
            <div style={{fontFamily:"var(--font-h)",fontWeight:900,fontSize:18,color:dept?.color||"var(--blue)"}}>
              {dept?.label||staffData.deptId}
            </div>
            <div style={{fontSize:11,color:"var(--muted)"}}>{hospitalData?.name} · {staffData.role}</div>
          </div>
        </div>
        <Btn variant="ghost" size="sm" onClick={()=>signOut(auth)}>Sign Out</Btn>
      </div>

      {/* Stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:1,
        background:"var(--border)", borderBottom:"1px solid var(--border)" }}>
        {[
          {label:"Waiting",    val:waiting,   color:dept?.color||"var(--blue)"},
          {label:"In Progress",val:serving,   color:"var(--green)"},
          {label:"Completed",  val:completed, color:"var(--muted)"},
        ].map(s=>(
          <div key={s.label} style={{background:"#fff",padding:"14px 20px",textAlign:"center"}}>
            <div style={{fontFamily:"var(--font-h)",fontSize:28,fontWeight:900,color:s.color}}>{s.val}</div>
            <div style={{fontSize:11,color:"var(--muted)",letterSpacing:1,textTransform:"uppercase"}}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{padding:20,maxWidth:700,margin:"0 auto"}}>
        {loading ? (
          <div style={{textAlign:"center",padding:40,color:"var(--muted)"}}>Loading queue…</div>
        ) : queue.filter(q=>q.status!=="completed"&&q.status!=="skipped").length===0 ? (
          <Card style={{textAlign:"center",padding:48}}>
            <div style={{fontSize:48,marginBottom:12}}>✅</div>
            <div style={{fontWeight:700,fontSize:18,marginBottom:4}}>Queue is clear!</div>
            <div style={{color:"var(--muted)"}}>No patients waiting right now.</div>
          </Card>
        ) : (
          queue.filter(q=>q.status!=="completed"&&q.status!=="skipped").map((q,i)=>(
            <Card key={q.id} style={{marginBottom:10,
              borderLeft:`4px solid ${i===0&&q.status==="waiting"?dept?.color||"var(--blue)":"var(--border)"}`,
              opacity:q.status==="skipped"?0.5:1}}>
              <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{background:i===0?dept?.color||"var(--blue)":"var(--border)",
                  color:i===0?"#fff":"var(--muted)",
                  borderRadius:10,padding:"8px 14px",textAlign:"center",minWidth:72}}>
                  <div style={{fontSize:10,fontWeight:600,opacity:0.8}}>TICKET</div>
                  <div style={{fontFamily:"var(--font-h)",fontSize:20,fontWeight:900}}>{q.ticket}</div>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:15}}>
                    {i===0&&<span style={{color:dept?.color||"var(--blue)",marginRight:6}}>→ NEXT</span>}
                    {q.patientName}
                  </div>
                  <div style={{fontSize:12,color:"var(--muted)"}}>
                    {q.patientAge}yr {q.patientGender&&`· ${q.patientGender}`}
                    {q.patientPhone&&` · 📞 ${q.patientPhone}`}
                  </div>
                  <div style={{fontSize:12,color:"var(--muted)"}}>
                    Waited: {waitTime(q.createdAt)}
                  </div>
                  {q.notes&&<div style={{fontSize:12,color:"var(--blue)",marginTop:2}}>📝 {q.notes}</div>}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
                  <Badge status={q.status} />
                  <div style={{display:"flex",gap:6}}>
                    {q.status==="waiting"&&(
                      <Btn size="sm" onClick={()=>updateStatus(q.id,"called")}>📢 Call</Btn>
                    )}
                    {q.status==="called"&&(
                      <Btn size="sm" variant="success" onClick={()=>updateStatus(q.id,"serving")}>▶ Start</Btn>
                    )}
                    {q.status==="serving"&&(
                      <Btn size="sm" variant="success" onClick={()=>updateStatus(q.id,"completed")}>✅ Done</Btn>
                    )}
                    {(q.status==="waiting"||q.status==="called")&&(
                      <Btn size="sm" variant="ghost" onClick={()=>updateStatus(q.id,"skipped")}>⏭ Skip</Btn>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          ))
        )}

        {/* Completed today */}
        {completed > 0 && (
          <div style={{marginTop:24}}>
            <div style={{fontWeight:600,color:"var(--muted)",fontSize:13,marginBottom:8}}>
              ✅ Completed today ({completed})
            </div>
            {queue.filter(q=>q.status==="completed").map(q=>(
              <Card key={q.id} style={{marginBottom:8,opacity:0.6}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontWeight:600,fontSize:14}}>{q.patientName}</div>
                    <div style={{fontSize:12,color:"var(--muted)"}}>
                      #{q.ticket} · {fmtTime(q.createdAt)} → {fmtTime(q.completedAt)}
                    </div>
                  </div>
                  <Badge status="completed" />
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Suspended Screen ─────────────────────────────────────────────────────────
function SuspendedScreen() {
  return (
    <div style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",
      background:"var(--bg)",padding:16,textAlign:"center"}}>
      <div>
        <div style={{fontSize:60,marginBottom:16}}>🔒</div>
        <div style={{fontFamily:"var(--font-h)",fontSize:24,fontWeight:900,marginBottom:8,color:"var(--text)"}}>
          Account Suspended
        </div>
        <div style={{color:"var(--muted)",fontSize:14,maxWidth:320,margin:"0 auto 24px"}}>
          Your hospital account has been suspended. Please contact SwiftCare support.
        </div>
        <div style={{fontSize:13,color:"var(--blue)"}}>support@swiftcare.org</div>
        <div style={{marginTop:20}}>
          <Btn variant="ghost" onClick={()=>signOut(auth)}>Sign Out</Btn>
        </div>
      </div>
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
 function AppInner({ displayHospitalId }) {
  const [user, setUser]           = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [role, setRole]           = useState(null);
  const [staffData, setStaffData] = useState(null);
  const [hospitalData, setHospitalData] = useState(null);
  const [suspended, setSuspended] = useState(false);
  const [toast, setToast]         = useState(null);
  const sessionTimer = useRef(null);

  const onToast = useCallback((message, type="success") => {
    setToast({message, type, key:Date.now()});
  }, []);

  // ─── Session Timeout ───────────────────────────────────────────────────────
  const resetSessionTimer = useCallback(() => {
    if (sessionTimer.current) clearTimeout(sessionTimer.current);
    sessionTimer.current = setTimeout(async () => {
      await writeAuditLog("session_timeout", { reason: "30min inactivity" });
      await signOut(auth);
      onToast("Session expired due to inactivity. Please log in again.", "warn");
    }, SESSION_TIMEOUT_MS);
  }, [onToast]);

  useEffect(() => {
    const events = ["mousedown","mousemove","keydown","scroll","touchstart","click"];
    const handler = () => { if (user) resetSessionTimer(); };
    events.forEach(e => window.addEventListener(e, handler));
    return () => events.forEach(e => window.removeEventListener(e, handler));
  }, [user, resetSessionTimer]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
       resetSessionTimer();
        const sDoc = await getDoc(doc(db,"sc_staff",u.uid));
        if (sDoc.exists()) {
          const sd = sDoc.data();
          if (sd.isSuperAdmin === true) {
            setRole("superadmin");
          } else {
            setStaffData(sd);
            setRole(sd.role);
            const hDoc = await getDoc(doc(db,"sc_hospitals",sd.hospitalId));
            if (hDoc.exists()) {
              const hd = hDoc.data();
              setHospitalData(hd);
              setSuspended(!hd.active);
            }
          }
        }
      } else {
        if (sessionTimer.current) clearTimeout(sessionTimer.current);
        setRole(null); setStaffData(null); setHospitalData(null); setSuspended(false);
      }
      setAuthLoading(false);
    });
    return unsub;
  }, [resetSessionTimer]);
if (displayHospitalId) {
    return <QueueDisplay hospitalId={displayHospitalId}  />;
  }
   if (authLoading) {
    return (
      <div style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",
        background:"linear-gradient(135deg,#1e40af,#3b82f6)",flexDirection:"column",gap:12}}>
        <div style={{width:52,height:52,background:"#fff",borderRadius:14,
          display:"flex",alignItems:"center",justifyContent:"center",fontSize:28}}>🏥</div>
        <div style={{color:"rgba(255,255,255,0.8)",fontSize:14}}>Loading SwiftCare…</div>
      </div>
    );
  }

  return (
    <>
      <style>{CSS}</style>

      {!user ? (
        <LoginScreen onToast={onToast} />
      ) : suspended ? (
        <SuspendedScreen />
      ) : role==="superadmin" ? (
        <SuperAdminPanel user={user} onToast={onToast} />
      ) : role==="admin" ? (
        <HospitalAdmin user={user} hospitalId={staffData?.hospitalId}
          hospitalData={hospitalData} onToast={onToast} />
      ) : staffData ? (
        <StaffQueue user={user} staffData={staffData}
          hospitalData={hospitalData} onToast={onToast} />
      ) : (
        <div style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",
          background:"var(--bg)",color:"var(--muted)"}}>
          Account not configured. Contact your administrator.
        </div>
      )}

      {toast && (
        <Toast key={toast.key} message={toast.message} type={toast.type} onClose={()=>setToast(null)} />
      )}
    </>
  );
}


export default function App() {
  const displayHospitalId = new URLSearchParams(window.location.search).get("display");
  if (displayHospitalId) {
    return <QueueDisplay hospitalId={displayHospitalId} hospitalName="SwiftCare Hospital Network" />;
  }
  return <AppInner displayHospitalId={displayHospitalId} />;
}

