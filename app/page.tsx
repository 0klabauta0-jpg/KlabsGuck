"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { db } from "@/lib/firebase";
import { doc, getDoc, onSnapshot, setDoc, serverTimestamp } from "firebase/firestore";

// ── TYPES ────────────────────────────────────────────────────
type Player = {
  id: string; name: string; area: string; role: string; squadron: string;
  twitch: string; streamUrl: string; platform: "twitch" | "youtube" | "custom" | null;
  ytVideoId: string;
};

type Group = { id: string; label: string; color: string; members: string[]; };

// ── CONSTANTS ────────────────────────────────────────────────
const GCOLORS = ["#00c8ff","#ff6b35","#9147ff","#22c55e","#f59e0b","#ec4899","#06b6d4","#ef4444","#a3e635"];
const LS_SESSION = "klabsguck_session";

// ── HELPERS ──────────────────────────────────────────────────
function stableId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return "p_" + (h >>> 0).toString(36);
}

function splitRow(row: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (const c of row) {
    if (c === '"') { q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}

function extractYtId(url: string): string {
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : "";
}

function detectPlatform(twitch: string, streamUrl: string): Player["platform"] {
  if (twitch) return "twitch";
  if (!streamUrl) return null;
  if (streamUrl.includes("youtube.com") || streamUrl.includes("youtu.be")) return "youtube";
  return "custom";
}

function parseCSV(text: string): Player[] {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitRow(lines[0]);
  const players: Player[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitRow(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h.trim()] = (vals[idx] || "").trim(); });
    const name = row["Spielername"] || row["Name"] || "";
    if (!name) continue;
    const twitch    = row["TwitchHandle"] || "";
    const streamUrl = row["StreamUrl"] || row["YoutubeStream"] || "";
    if (!twitch && !streamUrl) continue;
    const platform = detectPlatform(twitch, streamUrl);
    const ytVideoId = platform === "youtube" ? extractYtId(streamUrl) : "";
    players.push({
      id:        row["PlayerId"] || stableId(name),
      name, area: row["Bereich"] || "", role: row["Rolle"] || "",
      squadron:  row["Staffel"] || "",
      twitch, streamUrl, platform, ytVideoId,
    });
  }
  return players;
}

function twitchEmbedUrl(handle: string, autoplay = false): string {
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  return `https://player.twitch.tv/?channel=${encodeURIComponent(handle)}&parent=${host}${autoplay ? "" : "&muted=1"}`;
}

function ytEmbedUrl(id: string, autoplay = false): string {
  return `https://www.youtube.com/embed/${id}${autoplay ? "?autoplay=1" : ""}`;
}

function getEmbedUrl(p: Player, autoplay = false): string | null {
  if (p.platform === "twitch")   return twitchEmbedUrl(p.twitch, autoplay);
  if (p.platform === "youtube")  return ytEmbedUrl(p.ytVideoId, autoplay);
  if (p.platform === "custom")   return p.streamUrl;
  return null;
}

// ── LOGIN SCREEN ─────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (roomId: string, sheetUrl: string) => void }) {
  const [roomId, setRoomId] = useState("");
  const [pw, setPw]         = useState("");
  const [err, setErr]       = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (!roomId.trim() || !pw.trim()) { setErr("Bitte Raum-ID und Passwort eingeben."); return; }
    setLoading(true); setErr("");
    try {
      const snap = await getDoc(doc(db, "rooms", roomId.trim(), "config", "main"));
      if (!snap.exists()) { setErr(`Raum "${roomId}" nicht gefunden.`); setLoading(false); return; }
      const cfg = snap.data() as { password: string; sheetUrl: string };
      if (cfg.password !== pw.trim()) { setErr("Falsches Passwort."); setLoading(false); return; }
      localStorage.setItem(LS_SESSION, JSON.stringify({ roomId: roomId.trim(), pw: pw.trim() }));
      onLogin(roomId.trim(), cfg.sheetUrl);
    } catch (e: any) { setErr("Fehler: " + e.message); setLoading(false); }
  }

  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", padding:20, position:"relative", zIndex:1 }}>
      <div style={{ background:"var(--bg2)", border:"1px solid var(--b2)", borderRadius:16, padding:36, width:"100%", maxWidth:380, boxShadow:"0 24px 80px rgba(0,0,0,.6)" }}>
        <div style={{ fontFamily:"var(--fd)", fontWeight:700, fontSize:28, letterSpacing:2, color:"var(--acc)", textTransform:"uppercase", marginBottom:4 }}>
          Klabsguck
        </div>
        <div style={{ fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)", marginBottom:28 }}>
          stream dashboard · raum-login
        </div>

        {(["RAUM-ID", "TEAM-PASSWORT"] as const).map((label, i) => (
          <div key={label} style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)", marginBottom:4 }}>{label}</label>
            <input
              type={i === 1 ? "password" : "text"}
              placeholder={i === 0 ? "z.B. alpha-ops" : "Team-Passwort"}
              value={i === 0 ? roomId : pw}
              onChange={e => i === 0 ? setRoomId(e.target.value) : setPw(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") i === 0 ? document.getElementById("pw-input")?.focus() : handleLogin(); }}
              id={i === 1 ? "pw-input" : undefined}
              style={{ width:"100%", padding:"9px 12px", fontFamily:"var(--fm)", fontSize:13, background:"var(--bg3)", border:"1px solid var(--b2)", borderRadius:8, color:"var(--text)", outline:"none" }}
            />
          </div>
        ))}

        <button
          onClick={handleLogin} disabled={loading}
          style={{ width:"100%", padding:10, fontFamily:"var(--fd)", fontWeight:700, fontSize:15, letterSpacing:.5, background:"var(--acc)", border:"none", borderRadius:8, color:"#000", cursor:"pointer", marginTop:6, opacity: loading ? .5 : 1 }}>
          {loading ? "Prüfe…" : "Einloggen →"}
        </button>

        {err && <div style={{ fontFamily:"var(--fm)", fontSize:11, color:"#f87171", marginTop:10 }}>{err}</div>}

        <div style={{ fontFamily:"var(--fm)", fontSize:10, color:"var(--mut)", marginTop:14, lineHeight:1.5 }}>
          Selbe Raum-ID und Passwort wie bei KlabsCom.<br/>
          Sheet und Streams werden automatisch geladen.
        </div>
      </div>
    </div>
  );
}

// ── COLOR PICKER ─────────────────────────────────────────────
function ColorPicker({ current, onChange }: { current: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position:"relative" }}>
      <div
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ width:10, height:10, borderRadius:"50%", background:current, cursor:"pointer", flexShrink:0 }}
      />
      {open && (
        <div
          onClick={e => e.stopPropagation()}
          style={{ position:"absolute", top:16, left:0, zIndex:50, background:"var(--bg2)", border:"1px solid var(--b2)", borderRadius:10, padding:8, display:"flex", flexWrap:"wrap", gap:5, width:130, boxShadow:"0 8px 32px rgba(0,0,0,.5)" }}>
          {GCOLORS.map(c => (
            <div key={c}
              onClick={() => { onChange(c); setOpen(false); }}
              style={{ width:18, height:18, borderRadius:"50%", background:c, cursor:"pointer", border: c===current ? "2px solid rgba(255,255,255,.8)" : "2px solid transparent" }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── STREAM CARD ───────────────────────────────────────────────
function StreamCard({ player, onDragStart, onDragEnd, onDoubleClick }: {
  player: Player;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDoubleClick: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const embedUrl = getEmbedUrl(player);
  const platIcon = player.platform === "twitch" ? "🟣" : player.platform === "youtube" ? "▶" : player.platform === "custom" ? "📡" : "";
  const sub = [player.twitch ? "@"+player.twitch : "", player.streamUrl && player.platform !== "twitch" ? player.streamUrl.slice(0,40)+"…" : ""].filter(Boolean).join(" · ");

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDoubleClick={onDoubleClick}
      style={{ background:"var(--bg2)", border:"1px solid var(--b)", borderRadius:"var(--r)", overflow:"hidden", cursor:"grab", position:"relative", userSelect:"none", transition:"border-color .15s, transform .12s, box-shadow .15s" }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor="var(--b2)"; (e.currentTarget as HTMLDivElement).style.transform="translateY(-2px)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor="var(--b)"; (e.currentTarget as HTMLDivElement).style.transform="translateY(0)"; }}
    >
      {/* Embed area */}
      <div style={{ position:"relative", width:"100%", paddingTop:"56.25%", background:"#050810", overflow:"hidden" }}>
        {loaded && embedUrl ? (
          <iframe
            src={embedUrl}
            style={{ position:"absolute", inset:0, width:"100%", height:"100%", border:"none" }}
            allowFullScreen
            allow="autoplay; encrypted-media"
          />
        ) : embedUrl ? (
          <div
            onClick={() => setLoaded(true)}
            style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:7, cursor:"pointer", background:"linear-gradient(140deg,#07090e,#0c1118)" }}>
            <div style={{ width:42, height:42, borderRadius:"50%", border:"1.5px solid rgba(255,255,255,.18)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:17 }}>▶</div>
            <div style={{ fontFamily:"var(--fm)", fontSize:10, color:"var(--mut)" }}>
              {(player.platform||"").toUpperCase()} · KLICKEN ZUM LADEN
            </div>
          </div>
        ) : (
          <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:5, fontFamily:"var(--fm)", fontSize:10, color:"var(--mut)" }}>
            <span style={{ fontSize:20, opacity:.3 }}>📵</span>
            <span>Kein Stream</span>
          </div>
        )}
        {/* Platform badge */}
        {player.platform && (
          <div style={{ position:"absolute", top:8, right:8, zIndex:2, width:20, height:20, borderRadius:4, background: player.platform==="twitch"?"var(--tw)":player.platform==="youtube"?"var(--yt)":"#374151", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11 }}>
            {platIcon}
          </div>
        )}
      </div>

      {/* Card body */}
      <div style={{ padding:"9px 11px 11px" }}>
        <div style={{ fontFamily:"var(--fd)", fontWeight:700, fontSize:14, color:"var(--text)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
          {player.name}
        </div>
        <div style={{ fontFamily:"var(--fm)", fontSize:10, color:"var(--mut)", marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
          {sub}
        </div>
        <div style={{ display:"flex", gap:5, marginTop:6, flexWrap:"wrap" }}>
          {[player.area, player.squadron, player.role].filter(Boolean).map((tag, i) => (
            <span key={i} style={{ fontFamily:"var(--fm)", fontSize:10, padding:"1px 6px", borderRadius:3, border:"1px solid var(--b2)", color:"var(--mut)" }}>{tag}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── FOCUS OVERLAY ─────────────────────────────────────────────
function FocusOverlay({ player, onClose }: { player: Player | null; onClose: () => void }) {
  if (!player) return null;
  const url = getEmbedUrl(player, true);
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position:"fixed", inset:0, zIndex:300, background:"rgba(0,0,0,.92)", backdropFilter:"blur(10px)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14 }}>
      <button
        onClick={onClose}
        style={{ position:"absolute", top:16, right:16, width:36, height:36, borderRadius:8, background:"rgba(255,255,255,.1)", border:"1px solid rgba(255,255,255,.15)", color:"#fff", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
        ✕
      </button>
      <div style={{ width:"min(1020px, 92vw)", aspectRatio:"16/9", borderRadius:10, overflow:"hidden" }}>
        {url ? (
          <iframe src={url} style={{ width:"100%", height:"100%", border:"none" }} allowFullScreen allow="autoplay; encrypted-media" />
        ) : (
          <div style={{ width:"100%", height:"100%", background:"var(--bg2)", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--mut)", fontFamily:"var(--fm)" }}>Kein Stream verfügbar</div>
        )}
      </div>
      <div style={{ color:"rgba(255,255,255,.7)", fontFamily:"var(--fd)", fontSize:15, fontWeight:600 }}>
        {player.name}{player.twitch ? " · @"+player.twitch : ""}
      </div>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────
function App({ roomId, sheetUrl, onLogout }: { roomId: string; sheetUrl: string; onLogout: () => void }) {
  const [players, setPlayers]     = useState<Player[]>([]);
  const [groups, setGroups]       = useState<Group[]>([]);
  const [platFilter, setPlatFilter] = useState("all");
  const [search, setSearch]       = useState("");
  const [cols, setCols]           = useState(3);
  const [focusPlayer, setFocus]   = useState<Player | null>(null);
  const [dragId, setDragId]       = useState<string | null>(null);
  const [dragOver, setDragOver]   = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState("");
  const [loading, setLoading]     = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Firestore groups sync ──
  useEffect(() => {
    const ref = doc(db, "streamdash", roomId);
    const unsub = onSnapshot(ref, snap => {
      if (snap.exists() && Array.isArray(snap.data().groups)) setGroups(snap.data().groups);
    });
    getDoc(ref).then(snap => { if (snap.exists() && Array.isArray(snap.data()?.groups)) setGroups(snap.data()!.groups); });
    return () => unsub();
  }, [roomId]);

  const persistGroups = useCallback((next: Group[]) => {
    setGroups(next);
    setDoc(doc(db, "streamdash", roomId), { groups: next, updatedAt: serverTimestamp() }, { merge: true }).catch(console.warn);
  }, [roomId]);

  // ── Sheet loading ──
  const loadSheet = useCallback(async () => {
    if (!sheetUrl) return;
    setLoading(true);
    let u = sheetUrl;
    if (!u.includes("range=")) u += (u.includes("?")?"&":"?") + "range=A10:Z10000";
    u += (u.includes("?")?"&":"?") + "_t=" + Date.now();
    try {
      const res  = await fetch(u, { cache:"no-store" });
      const text = await res.text();
      setPlayers(parseCSV(text));
      setLastRefresh(new Date().toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"}));
    } catch(e: any) { console.warn("Sheet:", e); }
    setLoading(false);
  }, [sheetUrl]);

  useEffect(() => {
    loadSheet();
    pollRef.current = setInterval(loadSheet, 60_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadSheet]);

  // ── Filtering ──
  const filtered = players.filter(p => {
    if (platFilter !== "all" && p.platform !== platFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (![p.name,p.area,p.role,p.squadron,p.twitch].some(v=>v?.toLowerCase().includes(q))) return false;
    }
    return true;
  });
  const filteredIds = new Set(filtered.map(p => p.id));

  // ── Groups helpers ──
  function ungrouped() {
    const assigned = new Set(groups.flatMap(g => g.members||[]));
    return filtered.filter(p => !assigned.has(p.id));
  }

  function addGroup() {
    const g: Group = { id:"g_"+Date.now(), label:"Gruppe "+(groups.length+1), color:GCOLORS[groups.length%GCOLORS.length], members:[] };
    persistGroups([...groups, g]);
    setTimeout(() => { const el = document.getElementById("gn_"+g.id) as HTMLInputElement; if(el){el.focus();el.select();} }, 50);
  }

  function renameGroup(id: string, label: string) {
    persistGroups(groups.map(g => g.id===id ? {...g,label} : g));
  }

  function deleteGroup(id: string) {
    persistGroups(groups.filter(g => g.id!==id));
  }

  function setGroupColor(id: string, color: string) {
    persistGroups(groups.map(g => g.id===id ? {...g,color} : g));
  }

  function moveToGroup(pid: string, gid: string | null) {
    const next = groups.map(g => ({ ...g, members:(g.members||[]).filter(id=>id!==pid) }));
    if (gid) { const idx = next.findIndex(g=>g.id===gid); if(idx!==-1) next[idx].members=[...(next[idx].members||[]),pid]; }
    persistGroups(next);
  }

  // ── Drag & drop ──
  function handleDrop(gid: string | null) {
    if (dragId) moveToGroup(dragId, gid);
    setDragId(null); setDragOver(null);
  }

  const colClass: Record<number,string> = {1:"repeat(1,1fr)",2:"repeat(2,1fr)",3:"repeat(3,1fr)",4:"repeat(4,1fr)",5:"repeat(5,1fr)"};

  const gridStyle = { display:"grid" as const, gap:12, gridTemplateColumns: colClass[cols] };

  const dropZoneStyle = (id: string | null, isEmpty: boolean): React.CSSProperties => ({
    ...gridStyle,
    minHeight: 72, borderRadius:"var(--r)",
    border: `2px dashed ${dragOver===(id||"un") ? "var(--acc)" : isEmpty ? "var(--b2)" : "transparent"}`,
    background: dragOver===(id||"un") ? "rgba(0,200,255,.04)" : "transparent",
    transition:"all .12s",
    ...(isEmpty ? { display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)" } : {}),
  });

  const tw = players.filter(p=>p.platform==="twitch").length;
  const yt = players.filter(p=>p.platform==="youtube").length;
  const cu = players.filter(p=>p.platform==="custom").length;

  return (
    <div style={{ position:"relative", zIndex:1 }}>
      {/* Header */}
      <header style={{ position:"sticky", top:0, zIndex:100, background:"rgba(7,10,15,.94)", backdropFilter:"blur(12px)", borderBottom:"1px solid var(--b2)", padding:"0 20px", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap", minHeight:52 }}>
        <div style={{ fontFamily:"var(--fd)", fontWeight:700, fontSize:17, letterSpacing:2, color:"var(--acc)", textTransform:"uppercase", display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
          Klabsguck
          <span style={{ color:"var(--mut)", fontSize:11, fontFamily:"var(--fm)", letterSpacing:0 }}>STREAMS</span>
          <span style={{ color:"rgba(0,200,255,.5)", fontSize:12, fontFamily:"var(--fm)" }}>{roomId}</span>
        </div>

        <div style={{ width:1, height:20, background:"var(--b2)", flexShrink:0 }} />

        {/* Platform filter pills */}
        {[{id:"all",label:"Alle"},{id:"twitch",label:"Twitch"},{id:"youtube",label:"YouTube"},{id:"custom",label:"Custom"}].map(f => (
          <button key={f.id} onClick={() => setPlatFilter(f.id)}
            style={{ fontFamily:"var(--fd)", fontWeight:600, fontSize:13, padding:"3px 12px", borderRadius:20, cursor:"pointer", letterSpacing:.4, border:"1px solid var(--b2)", color: platFilter===f.id ? "#000" : "var(--mut)", background: platFilter===f.id ? "var(--acc)" : "transparent", transition:"all .15s" }}>
            {f.label}
          </button>
        ))}

        <div style={{ width:1, height:20, background:"var(--b2)", flexShrink:0 }} />
        <input
          type="text" placeholder="Suchen…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{ height:28, padding:"0 10px", fontFamily:"var(--fm)", fontSize:12, background:"var(--bg3)", border:"1px solid var(--b2)", borderRadius:6, color:"var(--text)", outline:"none", width:150 }}
        />
        <div style={{ width:1, height:20, background:"var(--b2)", flexShrink:0 }} />
        <span style={{ fontSize:11, color:"var(--mut)", fontFamily:"var(--fm)" }}>Zoom</span>
        {["−","+"].map((s,i) => (
          <button key={s} onClick={() => setCols(c => i===0 ? Math.max(1,c-1) : Math.min(5,c+1))}
            style={{ width:27, height:27, borderRadius:6, cursor:"pointer", border:"1px solid var(--b2)", background:"transparent", color:"var(--text)", fontSize:16, display:"flex", alignItems:"center", justifyContent:"center" }}>
            {s}
          </button>
        ))}
        <button onClick={onLogout}
          style={{ marginLeft:"auto", padding:"4px 12px", fontFamily:"var(--fd)", fontSize:12, fontWeight:600, border:"1px solid var(--b2)", borderRadius:6, background:"transparent", color:"var(--mut)", cursor:"pointer", flexShrink:0 }}>
          ← Logout
        </button>
      </header>

      {/* Status bar */}
      <div style={{ display:"flex", gap:16, alignItems:"center", padding:"5px 20px", fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)", borderBottom:"1px solid var(--b)" }}>
        <span><span style={{ width:6,height:6,borderRadius:"50%",background:"var(--tw)",display:"inline-block",marginRight:4 }}/>{ tw} Twitch</span>
        <span><span style={{ width:6,height:6,borderRadius:"50%",background:"var(--yt)",display:"inline-block",marginRight:4 }}/>{yt} YouTube</span>
        {cu > 0 && <span><span style={{ width:6,height:6,borderRadius:"50%",background:"#374151",display:"inline-block",marginRight:4 }}/>{cu} Custom</span>}
        <span style={{ color:"var(--mut)" }}>{players.length} gesamt</span>
        <span style={{ marginLeft:"auto" }}>
          {loading ? <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>↻</span> : lastRefresh ? "↻ "+lastRefresh : ""}
        </span>
      </div>

      {/* Main */}
      <main style={{ padding:"16px 20px" }}>
        <button onClick={addGroup}
          style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"7px 14px", borderRadius:8, border:"1px dashed var(--b2)", background:"transparent", color:"var(--mut)", fontFamily:"var(--fd)", fontWeight:600, fontSize:13, cursor:"pointer", marginBottom:20 }}>
          ＋ Gruppe hinzufügen
        </button>

        {/* Named groups */}
        {groups.map(g => {
          const members = (g.members||[]).map(id=>players.find(p=>p.id===id)).filter((p): p is Player => !!p && filteredIds.has(p.id));
          const isEmpty = members.length === 0;
          return (
            <div key={g.id} style={{ marginBottom:28 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, paddingBottom:7, borderBottom:"1px solid var(--b2)" }}>
                <ColorPicker current={g.color} onChange={c => setGroupColor(g.id, c)} />
                <input
                  id={"gn_"+g.id}
                  defaultValue={g.label}
                  onBlur={e => renameGroup(g.id, e.target.value)}
                  onKeyDown={e => { if(e.key==="Enter") (e.target as HTMLInputElement).blur(); }}
                  style={{ background:"transparent", border:"none", borderBottom:"1px solid transparent", color:"var(--text)", fontFamily:"var(--fd)", fontWeight:700, fontSize:14, letterSpacing:1.5, textTransform:"uppercase", outline:"none", minWidth:60, maxWidth:240 }}
                />
                <span style={{ fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)" }}>{members.length} Stream{members.length!==1?"s":""}</span>
                <button onClick={() => deleteGroup(g.id)}
                  style={{ marginLeft:"auto", fontFamily:"var(--fm)", fontSize:11, padding:"2px 8px", borderRadius:4, border:"1px solid var(--b)", background:"transparent", color:"var(--mut)", cursor:"pointer" }}>
                  ✕
                </button>
              </div>
              <div
                style={dropZoneStyle(g.id, isEmpty)}
                onDragOver={e => { e.preventDefault(); setDragOver(g.id); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={() => handleDrop(g.id)}>
                {isEmpty ? <span>hierher ziehen</span> : members.map(p => (
                  <StreamCard key={p.id} player={p}
                    onDragStart={() => setDragId(p.id)}
                    onDragEnd={() => { setDragId(null); setDragOver(null); }}
                    onDoubleClick={() => setFocus(p)}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* Ungrouped */}
        {ungrouped().length > 0 && (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:8, margin:"24px 0 10px", padding:"14px 0 7px", borderTop:"1px solid var(--b)", borderBottom:"1px solid var(--b2)", fontFamily:"var(--fd)", fontWeight:700, fontSize:13, letterSpacing:1.5, textTransform:"uppercase", color:"var(--mut)" }}>
              <span style={{ width:9,height:9,borderRadius:"50%",background:"var(--mut)",display:"inline-block" }}/>
              Unzugeteilt
              <span style={{ fontFamily:"var(--fm)", fontSize:11, fontWeight:400, marginLeft:4 }}>{ungrouped().length}</span>
            </div>
            <div
              style={dropZoneStyle(null, false)}
              onDragOver={e => { e.preventDefault(); setDragOver("un"); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={() => handleDrop(null)}>
              {ungrouped().map(p => (
                <StreamCard key={p.id} player={p}
                  onDragStart={() => setDragId(p.id)}
                  onDragEnd={() => { setDragId(null); setDragOver(null); }}
                  onDoubleClick={() => setFocus(p)}
                />
              ))}
            </div>
          </>
        )}

        {!players.length && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 20px", gap:12, fontFamily:"var(--fd)", color:"var(--mut)" }}>
            <span style={{ fontSize:46, opacity:.3 }}>📡</span>
            <p style={{ fontSize:16, fontWeight:600, letterSpacing:1 }}>Lade Streams…</p>
            <small style={{ fontFamily:"var(--fm)", fontSize:11 }}>Sheet wird geladen</small>
          </div>
        )}
      </main>

      {/* Focus overlay */}
      <FocusOverlay player={focusPlayer} onClose={() => setFocus(null)} />

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        input[type=text]:focus, input[type=password]:focus { border-color: var(--acc) !important; }
        button:hover { opacity: .85; }
      `}</style>
    </div>
  );
}

// ── ROOT PAGE ─────────────────────────────────────────────────
export default function Page() {
  const [session, setSession] = useState<{ roomId: string; sheetUrl: string } | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem(LS_SESSION);
    if (!saved) { setChecking(false); return; }
    try {
      const { roomId, pw } = JSON.parse(saved);
      getDoc(doc(db, "rooms", roomId, "config", "main")).then(snap => {
        if (snap.exists() && snap.data().password === pw) {
          setSession({ roomId, sheetUrl: snap.data().sheetUrl });
        } else {
          localStorage.removeItem(LS_SESSION);
        }
        setChecking(false);
      }).catch(() => { localStorage.removeItem(LS_SESSION); setChecking(false); });
    } catch { localStorage.removeItem(LS_SESSION); setChecking(false); }
  }, []);

  function handleLogin(roomId: string, sheetUrl: string) { setSession({ roomId, sheetUrl }); }

  function handleLogout() {
    localStorage.removeItem(LS_SESSION);
    setSession(null);
  }

  if (checking) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", position:"relative", zIndex:1 }}>
      <div style={{ fontFamily:"var(--fm)", fontSize:13, color:"var(--mut)", animation:"spin 1s linear infinite", display:"inline-block" }}>↻</div>
    </div>
  );

  if (!session) return <LoginScreen onLogin={handleLogin} />;
  return <App roomId={session.roomId} sheetUrl={session.sheetUrl} onLogout={handleLogout} />;
}
