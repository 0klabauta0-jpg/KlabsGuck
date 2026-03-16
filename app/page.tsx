"use client";

import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { db } from "@/lib/firebase";
import { doc, getDoc, onSnapshot, setDoc, serverTimestamp } from "firebase/firestore";

// ── TYPES ────────────────────────────────────────────────────
type Player = {
  id: string; name: string; area: string; role: string; squadron: string;
  twitch: string; streamUrl: string; platform: "twitch" | "youtube" | "custom" | null;
  ytVideoId: string;
};
type Group = { id: string; label: string; color: string; members: string[]; };
type WinState = {
  id: string; playerId: string;
  x: number; y: number; w: number; h: number;
  minimized: boolean; muted: boolean; zIndex: number;
};

// ── CONSTANTS ────────────────────────────────────────────────
const GCOLORS    = ["#00c8ff","#ff6b35","#9147ff","#22c55e","#f59e0b","#ec4899","#06b6d4","#ef4444","#a3e635"];
const LS_SESSION = "klabsguck_session";
const LS_WINS    = "klabsguck_windows";
const SNAP_DIST  = 16;
const MIN_W      = 280; const MIN_H = 180;
const TITLE_H    = 34;

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
  if (!url) return "";
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/live\/|\/shorts\/|\/v\/)([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  const fallback = url.match(/([a-zA-Z0-9_-]{11})(?:[?&]|$)/);
  return fallback ? fallback[1] : "";
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
    const streamUrl = row["StreamUrl"] || row["TwitchHandle"] || row["YouTubeChannel"] || row["YoutubeChannel"] || row["YoutubeStream"] || "";
    if (!streamUrl) continue;
    let platform: Player["platform"] = null; let twitch = ""; let ytVideoId = "";
    if (streamUrl.includes("twitch.tv")) {
      platform = "twitch";
      const m = streamUrl.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
      twitch = m ? m[1] : streamUrl;
    } else if (streamUrl.includes("youtube.com") || streamUrl.includes("youtu.be")) {
      platform = "youtube"; ytVideoId = extractYtId(streamUrl);
    } else if (streamUrl.startsWith("http")) { platform = "custom"; }
    players.push({ id: row["PlayerId"] || stableId(name), name, area: row["Bereich"] || "", role: row["Rolle"] || "", squadron: row["Staffel"] || "", twitch, streamUrl, platform, ytVideoId });
  }
  return players;
}
function twitchEmbedUrl(handle: string, muted = true): string {
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  return `https://player.twitch.tv/?channel=${encodeURIComponent(handle)}&parent=${host}${muted ? "&muted=1" : ""}`;
}
function ytEmbedUrl(id: string, muted = true): string {
  return `https://www.youtube.com/embed/${id}?autoplay=1${muted ? "&mute=1" : ""}`;
}
function getEmbedUrl(p: Player, muted = true): string | null {
  if (p.platform === "twitch")  return twitchEmbedUrl(p.twitch, muted);
  if (p.platform === "youtube") return ytEmbedUrl(p.ytVideoId, muted);
  if (p.platform === "custom")  return p.streamUrl;
  return null;
}

// ── SNAP HELPER ──────────────────────────────────────────────
function snapPosition(x: number, y: number, w: number, h: number, wins: WinState[], selfId: string): { x: number; y: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth  : 1920;
  const vh = typeof window !== "undefined" ? window.innerHeight : 1080;
  const hh = 52 + 28; // header + status bar height
  let nx = x; let ny = y;
  // Screen edges
  if (Math.abs(nx) < SNAP_DIST) nx = 0;
  if (Math.abs(ny - hh) < SNAP_DIST) ny = hh;
  if (Math.abs(nx + w - vw) < SNAP_DIST) nx = vw - w;
  if (Math.abs(ny + h - vh) < SNAP_DIST) ny = vh - h;
  // Other windows
  for (const ow of wins) {
    if (ow.id === selfId) continue;
    const oh = ow.minimized ? TITLE_H : ow.h;
    // Left edge to right edge
    if (Math.abs(nx - (ow.x + ow.w)) < SNAP_DIST) nx = ow.x + ow.w;
    // Right edge to left edge
    if (Math.abs(nx + w - ow.x) < SNAP_DIST) nx = ow.x - w;
    // Top edge to bottom edge
    if (Math.abs(ny - (ow.y + oh)) < SNAP_DIST) ny = ow.y + oh;
    // Bottom edge to top edge
    if (Math.abs(ny + h - ow.y) < SNAP_DIST) ny = ow.y - h;
    // Align tops
    if (Math.abs(ny - ow.y) < SNAP_DIST) ny = ow.y;
    // Align lefts
    if (Math.abs(nx - ow.x) < SNAP_DIST) nx = ow.x;
  }
  return { x: Math.max(0, nx), y: Math.max(hh, ny) };
}

// ── LOGIN SCREEN ─────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (roomId: string, sheetUrl: string, shareUrl: string) => void }) {
  const [mode, setMode]         = useState<"klabs" | "sheet">("klabs");
  const [roomId, setRoomId]     = useState("");
  const [pw, setPw]             = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [err, setErr]           = useState("");
  const [loading, setLoading]   = useState(false);

  async function handleKlabsLogin() {
    if (!roomId.trim() || !pw.trim()) { setErr("Bitte Raum-ID und Passwort eingeben."); return; }
    setLoading(true); setErr("");
    try {
      const snap = await getDoc(doc(db, "rooms", roomId.trim(), "config", "main"));
      if (!snap.exists()) { setErr(`Raum "${roomId}" nicht gefunden.`); setLoading(false); return; }
      const cfg = snap.data() as { password: string; sheetUrl: string; sheetShareUrl?: string };
      if (cfg.password !== pw.trim()) { setErr("Falsches Passwort."); setLoading(false); return; }
      const su = cfg.sheetShareUrl || "";
      localStorage.setItem(LS_SESSION, JSON.stringify({ roomId: roomId.trim(), pw: pw.trim(), mode: "klabs", sheetShareUrl: su }));
      onLogin(roomId.trim(), cfg.sheetUrl, su);
    } catch (e: any) { setErr("Fehler: " + e.message); setLoading(false); }
  }
  async function handleSheetLogin() {
    if (!sheetUrl.trim().startsWith("http")) { setErr("Bitte eine gültige Sheet-URL eingeben."); return; }
    setLoading(true); setErr("");
    try {
      let u = sheetUrl.trim();
      if (!u.includes("range=")) u += (u.includes("?")?"&":"?") + "range=A10:Z11";
      u += (u.includes("?")?"&":"?") + "_t=" + Date.now();
      const res = await fetch(u, { cache:"no-store" });
      if (!res.ok) throw new Error("Sheet nicht erreichbar (Status " + res.status + ")");
      const roomLabel = "sheet_" + Date.now();
      localStorage.setItem(LS_SESSION, JSON.stringify({ roomId: roomLabel, sheetUrl: sheetUrl.trim(), sheetShareUrl: shareUrl.trim(), mode: "sheet" }));
      onLogin(roomLabel, sheetUrl.trim(), shareUrl.trim());
    } catch (e: any) { setErr("Fehler: " + e.message); setLoading(false); }
  }

  const box: React.CSSProperties = { background:"var(--bg2)", border:"1px solid var(--b2)", borderRadius:16, padding:36, width:"100%", maxWidth:420, boxShadow:"0 24px 80px rgba(0,0,0,.6)" };
  const inp: React.CSSProperties = { width:"100%", padding:"9px 12px", fontFamily:"var(--fm)", fontSize:13, background:"var(--bg3)", border:"1px solid var(--b2)", borderRadius:8, color:"var(--text)", outline:"none" };
  const tabStyle = (active: boolean): React.CSSProperties => ({ flex:1, padding:"8px 0", fontFamily:"var(--fd)", fontWeight:700, fontSize:13, letterSpacing:.5, cursor:"pointer", border:"1px solid var(--b2)", borderRadius:8, transition:"all .15s", background: active?"var(--acc)":"transparent", color: active?"#000":"var(--mut)" });

  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", padding:20, position:"relative", zIndex:1 }}>
      <div style={box}>
        <div style={{ fontFamily:"var(--fd)", fontWeight:700, fontSize:28, letterSpacing:2, color:"var(--acc)", textTransform:"uppercase", marginBottom:4 }}>Klabsguck</div>
        <div style={{ fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)", marginBottom:24 }}>stream dashboard</div>
        <div style={{ display:"flex", gap:6, marginBottom:24 }}>
          <button style={tabStyle(mode==="klabs")} onClick={() => { setMode("klabs"); setErr(""); }}>KlabsCom Raum</button>
          <button style={tabStyle(mode==="sheet")} onClick={() => { setMode("sheet"); setErr(""); }}>Sheet-URL direkt</button>
        </div>
        {mode === "klabs" && (<>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)", marginBottom:4 }}>RAUM-ID</label>
            <input type="text" placeholder="z.B. alpha-ops" value={roomId} onChange={e=>setRoomId(e.target.value)} onKeyDown={e=>e.key==="Enter"&&document.getElementById("pw-input")?.focus()} style={inp}/>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)", marginBottom:4 }}>TEAM-PASSWORT</label>
            <input type="password" id="pw-input" placeholder="Team-Passwort" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleKlabsLogin()} style={inp}/>
          </div>
          <div style={{ fontFamily:"var(--fm)", fontSize:10, color:"var(--mut)", marginBottom:16, lineHeight:1.5 }}>Selbe Raum-ID und Passwort wie bei KlabsCom.</div>
          <button onClick={handleKlabsLogin} disabled={loading} style={{ width:"100%", padding:10, fontFamily:"var(--fd)", fontWeight:700, fontSize:15, background:"var(--acc)", border:"none", borderRadius:8, color:"#000", cursor:"pointer", opacity:loading?.5:1 }}>
            {loading?"Prüfe…":"Einloggen →"}
          </button>
        </>)}
        {mode === "sheet" && (<>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)", marginBottom:4 }}>GOOGLE SHEET CSV-URL</label>
            <input type="text" placeholder="https://docs.google.com/spreadsheets/d/…/export?format=csv" value={sheetUrl} onChange={e=>setSheetUrl(e.target.value)} style={{...inp,fontSize:11}}/>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontFamily:"var(--fm)", fontSize:11, color:"var(--mut)", marginBottom:4 }}>SHEET FREIGABE-LINK <span style={{color:"var(--mut)"}}>· optional</span></label>
            <input type="text" placeholder="https://docs.google.com/spreadsheets/d/…/edit?usp=sharing" value={shareUrl} onChange={e=>setShareUrl(e.target.value)} style={{...inp,fontSize:11}}/>
          </div>
          <div style={{ fontFamily:"var(--fm)", fontSize:10, color:"rgba(255,165,0,.7)", marginBottom:16 }}>⚠ Gruppen-Sync nicht verfügbar ohne KlabsCom.</div>
          <button onClick={handleSheetLogin} disabled={loading} style={{ width:"100%", padding:10, fontFamily:"var(--fd)", fontWeight:700, fontSize:15, background:"var(--acc2)", border:"none", borderRadius:8, color:"#fff", cursor:"pointer", opacity:loading?.5:1 }}>
            {loading?"Prüfe…":"Sheet laden →"}
          </button>
        </>)}
        {err && <div style={{ fontFamily:"var(--fm)", fontSize:11, color:"#f87171", marginTop:10 }}>{err}</div>}
      </div>
    </div>
  );
}

// ── COLOR PICKER ─────────────────────────────────────────────
function ColorPicker({ current, onChange }: { current: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position:"relative" }}>
      <div onClick={e=>{e.stopPropagation();setOpen(v=>!v);}} style={{ width:10,height:10,borderRadius:"50%",background:current,cursor:"pointer",flexShrink:0 }}/>
      {open && (
        <div onClick={e=>e.stopPropagation()} style={{ position:"absolute",top:16,left:0,zIndex:50,background:"var(--bg2)",border:"1px solid var(--b2)",borderRadius:10,padding:8,display:"flex",flexWrap:"wrap",gap:5,width:130,boxShadow:"0 8px 32px rgba(0,0,0,.5)" }}>
          {GCOLORS.map(c=>(
            <div key={c} onClick={()=>{onChange(c);setOpen(false);}} style={{ width:18,height:18,borderRadius:"50%",background:c,cursor:"pointer",border:c===current?"2px solid rgba(255,255,255,.8)":"2px solid transparent" }}/>
          ))}
        </div>
      )}
    </div>
  );
}

// ── STREAM WINDOW (Fenstermanager) ────────────────────────────
function StreamWindow({ win, player, groupColor, allWins, onUpdate, onClose, onFocus }: {
  win: WinState; player: Player; groupColor: string;
  allWins: WinState[];
  onUpdate: (id: string, patch: Partial<WinState>) => void;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  const dragRef  = useRef<{ sx: number; sy: number; wx: number; wy: number } | null>(null);
  const resizeRef = useRef<{ sx: number; sy: number; ww: number; wh: number } | null>(null);
  const [muteKey, setMuteKey] = useState(0); // force iframe reload on mute toggle

  const embedUrl = getEmbedUrl(player, win.muted);

  function onTitleDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).dataset.btn) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, wx: win.x, wy: win.y };
    onFocus(win.id);
  }
  function onTitleMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.sx;
    const dy = e.clientY - dragRef.current.sy;
    const raw = { x: dragRef.current.wx + dx, y: dragRef.current.wy + dy };
    const snapped = snapPosition(raw.x, raw.y, win.w, win.minimized ? TITLE_H : win.h, allWins, win.id);
    onUpdate(win.id, snapped);
  }
  function onTitleUp() { dragRef.current = null; }

  function onResizeDown(e: React.PointerEvent) {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = { sx: e.clientX, sy: e.clientY, ww: win.w, wh: win.h };
    onFocus(win.id);
  }
  function onResizeMove(e: React.PointerEvent) {
    if (!resizeRef.current) return;
    const nw = Math.max(MIN_W, resizeRef.current.ww + e.clientX - resizeRef.current.sx);
    const nh = Math.max(MIN_H, resizeRef.current.wh + e.clientY - resizeRef.current.sy);
    onUpdate(win.id, { w: nw, h: nh });
  }
  function onResizeUp() { resizeRef.current = null; }

  function toggleMute() {
    onUpdate(win.id, { muted: !win.muted });
    setMuteKey(k => k + 1);
  }

  const platIcon = player.platform==="twitch"?"🟣":player.platform==="youtube"?"▶":"📡";
  const platColor = player.platform==="twitch"?"var(--tw)":player.platform==="youtube"?"var(--yt)":"#374151";

  return (
    <div
      onPointerDown={() => onFocus(win.id)}
      style={{
        position:"fixed", left:win.x, top:win.y,
        width:win.w, height: win.minimized ? TITLE_H : win.h,
        zIndex: win.zIndex,
        display:"flex", flexDirection:"column",
        background:"var(--bg2)", border:`1px solid ${groupColor}44`,
        borderRadius:10, overflow:"hidden",
        boxShadow: `0 4px 24px rgba(0,0,0,.5), 0 0 0 1px ${groupColor}22`,
        transition:"height .15s",
        userSelect:"none",
      }}
    >
      {/* Title bar */}
      <div
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={onTitleUp}
        style={{
          height:TITLE_H, flexShrink:0, display:"flex", alignItems:"center", gap:6,
          padding:"0 8px", cursor:"grab",
          background:`linear-gradient(90deg, ${groupColor}33 0%, var(--bg3) 100%)`,
          borderBottom:`1px solid ${groupColor}33`,
        }}
      >
        {/* Platform dot */}
        <div style={{ width:16,height:16,borderRadius:3,background:platColor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,flexShrink:0 }}>{platIcon}</div>
        {/* Name */}
        <div style={{ fontFamily:"var(--fd)", fontWeight:700, fontSize:13, color:"var(--text)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {player.name}
        </div>
        {/* Buttons */}
        <div style={{ display:"flex", gap:3, flexShrink:0 }}>
          <button data-btn="1" onClick={toggleMute} title={win.muted?"Ton an":"Ton aus"}
            style={{ width:22,height:22,borderRadius:4,border:`1px solid ${win.muted?"var(--b2)":"var(--acc)"}`,background:"transparent",color:win.muted?"var(--mut)":"var(--acc)",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center" }}>
            {win.muted?"🔇":"🔊"}
          </button>
          <button data-btn="1" onClick={()=>onUpdate(win.id,{minimized:!win.minimized})} title={win.minimized?"Maximieren":"Minimieren"}
            style={{ width:22,height:22,borderRadius:4,border:"1px solid var(--b2)",background:"transparent",color:"var(--mut)",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center" }}>
            {win.minimized?"□":"─"}
          </button>
          <button data-btn="1" onClick={()=>onClose(win.id)} title="Schließen"
            style={{ width:22,height:22,borderRadius:4,border:"1px solid var(--b2)",background:"transparent",color:"var(--mut)",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center" }}>
            ✕
          </button>
        </div>
      </div>

      {/* Stream content */}
      {!win.minimized && (
        <div style={{ flex:1, position:"relative", background:"#050810" }}>
          {embedUrl ? (
            <iframe
              key={`${win.id}-${win.muted}-${muteKey}`}
              src={embedUrl}
              style={{ position:"absolute",inset:0,width:"100%",height:"100%",border:"none" }}
              allowFullScreen
              allow="autoplay; encrypted-media"
            />
          ) : (
            <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:8,fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)" }}>
              <span style={{fontSize:24,opacity:.3}}>📵</span>
              <span>Kein Stream verfügbar</span>
            </div>
          )}
          {/* Resize handle */}
          <div
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            style={{ position:"absolute",bottom:0,right:0,width:18,height:18,cursor:"se-resize",zIndex:10,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,.4)" }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="var(--mut)">
              <path d="M10 0L0 10h2L10 2V0zm0 4L4 10h2l4-4V4zm0 4l-2 2h2V8z"/>
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

// ── FOCUS OVERLAY ─────────────────────────────────────────────
function FocusOverlay({ player, onClose }: { player: Player | null; onClose: () => void }) {
  if (!player) return null;
  const url = getEmbedUrl(player, false);
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{ position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,.92)",backdropFilter:"blur(10px)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14 }}>
      <button onClick={onClose} style={{ position:"absolute",top:16,right:16,width:36,height:36,borderRadius:8,background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.15)",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>
      <div style={{ width:"min(1020px,92vw)",aspectRatio:"16/9",borderRadius:10,overflow:"hidden" }}>
        {url ? <iframe src={url} style={{ width:"100%",height:"100%",border:"none" }} allowFullScreen allow="autoplay; encrypted-media"/> : <div style={{ width:"100%",height:"100%",background:"var(--bg2)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--mut)",fontFamily:"var(--fm)" }}>Kein Stream</div>}
      </div>
      <div style={{ color:"rgba(255,255,255,.7)",fontFamily:"var(--fd)",fontSize:15,fontWeight:600 }}>{player.name}</div>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────
function App({ roomId, sheetUrl, sheetShareUrl, onLogout }: { roomId: string; sheetUrl: string; sheetShareUrl: string; onLogout: () => void }) {
  const [players, setPlayers]       = useState<Player[]>([]);
  const [groups, setGroups]         = useState<Group[]>([]);
  const [appTab, setAppTab]         = useState<"grid" | "windows">("grid");
  const [platFilter, setPlatFilter] = useState("all");
  const [search, setSearch]         = useState("");
  const [cols, setCols]             = useState(3);
  const [focusPlayer, setFocus]     = useState<Player | null>(null);
  const [dragId, setDragId]         = useState<string | null>(null);
  const [dragOver, setDragOver]     = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState("");
  const [loading, setLoading]       = useState(false);
  const [copied, setCopied]         = useState(false);
  // Windows state
  const [wins, setWins] = useState<WinState[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_WINS) || "[]"); } catch { return []; }
  });
  const [maxZ, setMaxZ] = useState(10);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Persist windows
  useEffect(() => {
    localStorage.setItem(LS_WINS, JSON.stringify(wins));
  }, [wins]);

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

  // ── Auto-open windows when switching to window tab ──
  useEffect(() => {
    if (appTab !== "windows" || players.length === 0) return;
    // Add windows for players that don't have one yet
    setWins(prev => {
      const existingIds = new Set(prev.map(w => w.playerId));
      const newWins: WinState[] = [];
      let col = 0; let row = 0;
      const cols = 3; const ww = 400; const wh = 280;
      const startY = 90;
      players.forEach(p => {
        if (existingIds.has(p.id)) return;
        newWins.push({
          id: "w_" + p.id,
          playerId: p.id,
          x: col * (ww + 8),
          y: startY + row * (wh + 8),
          w: ww, h: wh,
          minimized: false, muted: true,
          zIndex: 10,
        });
        col++;
        if (col >= cols) { col = 0; row++; }
      });
      return newWins.length > 0 ? [...prev, ...newWins] : prev;
    });
  }, [appTab, players]);

  function updateWin(id: string, patch: Partial<WinState>) {
    setWins(prev => prev.map(w => w.id === id ? { ...w, ...patch } : w));
  }
  function closeWin(id: string) {
    setWins(prev => prev.filter(w => w.id !== id));
  }
  function focusWin(id: string) {
    setMaxZ(z => {
      const nz = z + 1;
      setWins(prev => prev.map(w => w.id === id ? { ...w, zIndex: nz } : w));
      return nz;
    });
  }
  function openAllWindows() {
    setWins(prev => {
      const existingIds = new Set(prev.map(w => w.playerId));
      const newWins: WinState[] = [];
      let col = 0; let row = 0;
      const ww = 400; const wh = 280; const startY = 90;
      players.forEach(p => {
        if (existingIds.has(p.id)) return;
        newWins.push({ id:"w_"+p.id, playerId:p.id, x:col*(ww+8), y:startY+row*(wh+8), w:ww, h:wh, minimized:false, muted:true, zIndex:10 });
        col++; if (col>=3){col=0;row++;}
      });
      return [...prev, ...newWins];
    });
  }
  function closeAllWindows() { setWins([]); }
  function tileWindows() {
    const vw = window.innerWidth;
    const startY = 90;
    const available = vw;
    const count = wins.length;
    if (!count) return;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const ww = Math.floor((available - (cols+1)*8) / cols);
    const wh = Math.floor((window.innerHeight - startY - (rows+1)*8) / rows);
    setWins(prev => prev.map((w, i) => ({
      ...w,
      x: 8 + (i % cols) * (ww + 8),
      y: startY + Math.floor(i / cols) * (wh + 8),
      w: Math.max(MIN_W, ww),
      h: Math.max(MIN_H, wh),
      minimized: false,
    })));
  }

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
  function moveToGroup(pid: string, gid: string | null) {
    const next = groups.map(g => ({ ...g, members:(g.members||[]).filter(id=>id!==pid) }));
    if (gid) { const idx = next.findIndex(g=>g.id===gid); if(idx!==-1) next[idx].members=[...(next[idx].members||[]),pid]; }
    persistGroups(next);
  }

  // ── Drag & drop (grid) ──
  function handleDrop(gid: string | null) {
    if (dragId) moveToGroup(dragId, gid);
    setDragId(null); setDragOver(null);
  }

  function copySheetLink() {
    if (!sheetShareUrl) return;
    navigator.clipboard.writeText(sheetShareUrl).then(() => {
      setCopied(true); setTimeout(()=>setCopied(false), 2000);
    });
  }

  const tw = players.filter(p=>p.platform==="twitch").length;
  const yt = players.filter(p=>p.platform==="youtube").length;
  const cu = players.filter(p=>p.platform==="custom").length;
  const colClass: Record<number,string> = {1:"repeat(1,1fr)",2:"repeat(2,1fr)",3:"repeat(3,1fr)",4:"repeat(4,1fr)",5:"repeat(5,1fr)"};

  // Get group color for a player
  function getPlayerGroupColor(pid: string): string {
    const g = groups.find(g => (g.members||[]).includes(pid));
    return g ? g.color : "var(--mut)";
  }

  return (
    <div style={{ position:"relative", zIndex:1 }}>
      {/* ── HEADER ── */}
      <header style={{ position:"sticky",top:0,zIndex:200,background:"rgba(7,10,15,.96)",backdropFilter:"blur(12px)",borderBottom:"1px solid var(--b2)",padding:"0 20px",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",minHeight:52 }}>
        <div style={{ fontFamily:"var(--fd)",fontWeight:700,fontSize:17,letterSpacing:2,color:"var(--acc)",textTransform:"uppercase",display:"flex",alignItems:"center",gap:8,flexShrink:0 }}>
          Klabsguck
          <span style={{ color:"var(--mut)",fontSize:11,fontFamily:"var(--fm)",letterSpacing:0 }}>STREAMS</span>
          <span style={{ color:"rgba(0,200,255,.5)",fontSize:12,fontFamily:"var(--fm)" }}>{roomId}</span>
        </div>

        {/* App tabs */}
        <div style={{ display:"flex",gap:4,flexShrink:0 }}>
          {(["grid","windows"] as const).map(t => (
            <button key={t} onClick={()=>setAppTab(t)}
              style={{ fontFamily:"var(--fd)",fontWeight:700,fontSize:13,padding:"3px 14px",borderRadius:20,cursor:"pointer",letterSpacing:.4,border:"1px solid var(--b2)",color:appTab===t?"#000":"var(--mut)",background:appTab===t?"var(--acc)":"transparent",transition:"all .15s" }}>
              {t==="grid"?"⊞ Grid":"⧉ Fenster"}
            </button>
          ))}
        </div>

        <div style={{ width:1,height:20,background:"var(--b2)",flexShrink:0 }}/>

        {/* Platform filters */}
        {[{id:"all",label:"Alle"},{id:"twitch",label:"Twitch"},{id:"youtube",label:"YouTube"},{id:"custom",label:"Custom"}].map(f=>(
          <button key={f.id} onClick={()=>setPlatFilter(f.id)}
            style={{ fontFamily:"var(--fd)",fontWeight:600,fontSize:13,padding:"3px 12px",borderRadius:20,cursor:"pointer",letterSpacing:.4,border:"1px solid var(--b2)",color:platFilter===f.id?"#000":"var(--mut)",background:platFilter===f.id?"var(--acc)":"transparent",transition:"all .15s" }}>
            {f.label}
          </button>
        ))}

        <div style={{ width:1,height:20,background:"var(--b2)",flexShrink:0 }}/>
        <input type="text" placeholder="Suchen…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{ height:28,padding:"0 10px",fontFamily:"var(--fm)",fontSize:12,background:"var(--bg3)",border:"1px solid var(--b2)",borderRadius:6,color:"var(--text)",outline:"none",width:150 }}/>

        {appTab === "grid" && (<>
          <div style={{ width:1,height:20,background:"var(--b2)",flexShrink:0 }}/>
          <span style={{ fontSize:11,color:"var(--mut)",fontFamily:"var(--fm)" }}>Zoom</span>
          {["−","+"].map((s,i)=>(
            <button key={s} onClick={()=>setCols(c=>i===0?Math.max(1,c-1):Math.min(5,c+1))}
              style={{ width:27,height:27,borderRadius:6,cursor:"pointer",border:"1px solid var(--b2)",background:"transparent",color:"var(--text)",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>{s}</button>
          ))}
        </>)}

        {appTab === "windows" && (<>
          <div style={{ width:1,height:20,background:"var(--b2)",flexShrink:0 }}/>
          <button onClick={openAllWindows}
            style={{ padding:"3px 10px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:"var(--acc)",cursor:"pointer" }}>
            + Alle öffnen
          </button>
          <button onClick={tileWindows}
            style={{ padding:"3px 10px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:"var(--mut)",cursor:"pointer" }}>
            ⊞ Kacheln
          </button>
          <button onClick={closeAllWindows}
            style={{ padding:"3px 10px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:"var(--acc2)",cursor:"pointer" }}>
            ✕ Alle schließen
          </button>
        </>)}

        <button onClick={onLogout}
          style={{ marginLeft:"auto",padding:"4px 12px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:"var(--mut)",cursor:"pointer",flexShrink:0 }}>
          ← Logout
        </button>
        {sheetShareUrl && (
          <button onClick={copySheetLink} title="Sheet-Link kopieren"
            style={{ padding:"4px 12px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:`1px solid ${copied?"var(--acc)":"var(--b2)"}`,borderRadius:6,background:"transparent",color:copied?"var(--acc)":"var(--mut)",cursor:"pointer",flexShrink:0,transition:"all .2s" }}>
            {copied?"✓ Kopiert!":"📊 Sheet"}
          </button>
        )}
      </header>

      {/* ── STATUS BAR ── */}
      <div style={{ display:"flex",gap:16,alignItems:"center",padding:"5px 20px",fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)",borderBottom:"1px solid var(--b)" }}>
        <span><span style={{ width:6,height:6,borderRadius:"50%",background:"var(--tw)",display:"inline-block",marginRight:4 }}/>{tw} Twitch</span>
        <span><span style={{ width:6,height:6,borderRadius:"50%",background:"var(--yt)",display:"inline-block",marginRight:4 }}/>{yt} YouTube</span>
        {cu>0 && <span><span style={{ width:6,height:6,borderRadius:"50%",background:"#374151",display:"inline-block",marginRight:4 }}/>{cu} Custom</span>}
        <span>{players.length} gesamt</span>
        {appTab==="windows" && <span style={{ color:"var(--acc)" }}>{wins.length} Fenster offen</span>}
        <span style={{ marginLeft:"auto",display:"flex",alignItems:"center",gap:8 }}>
          {lastRefresh && <span>↻ {lastRefresh}</span>}
          <button onClick={loadSheet} disabled={loading}
            style={{ display:"flex",alignItems:"center",gap:5,padding:"3px 10px",fontFamily:"var(--fm)",fontSize:11,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:loading?"var(--mut)":"var(--acc)",cursor:loading?"default":"pointer",opacity:loading?.5:1 }}>
            <span style={{ display:"inline-block",animation:loading?"spin 1s linear infinite":"none" }}>↻</span>
            {loading?"lädt…":"Aktualisieren"}
          </button>
        </span>
      </div>

      {/* ── GRID TAB ── */}
      {appTab === "grid" && (
        <main style={{ padding:"16px 20px" }}>
          <button onClick={addGroup}
            style={{ display:"inline-flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,border:"1px dashed var(--b2)",background:"transparent",color:"var(--mut)",fontFamily:"var(--fd)",fontWeight:600,fontSize:13,cursor:"pointer",marginBottom:20 }}>
            ＋ Gruppe hinzufügen
          </button>

          {groups.map(g => {
            const members = (g.members||[]).map(id=>players.find(p=>p.id===id)).filter((p): p is Player => !!p && filteredIds.has(p.id));
            const isEmpty = members.length === 0;
            return (
              <div key={g.id} style={{ marginBottom:28 }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:10,paddingBottom:7,borderBottom:"1px solid var(--b2)" }}>
                  <ColorPicker current={g.color} onChange={c=>persistGroups(groups.map(gg=>gg.id===g.id?{...gg,color:c}:gg))}/>
                  <input id={"gn_"+g.id} defaultValue={g.label}
                    onBlur={e=>persistGroups(groups.map(gg=>gg.id===g.id?{...gg,label:e.target.value}:gg))}
                    onKeyDown={e=>{if(e.key==="Enter")(e.target as HTMLInputElement).blur();}}
                    style={{ background:"transparent",border:"none",borderBottom:"1px solid transparent",color:"var(--text)",fontFamily:"var(--fd)",fontWeight:700,fontSize:14,letterSpacing:1.5,textTransform:"uppercase",outline:"none",minWidth:60,maxWidth:240 }}/>
                  <span style={{ fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)" }}>{members.length} Stream{members.length!==1?"s":""}</span>
                  <button onClick={()=>persistGroups(groups.filter(gg=>gg.id!==g.id))}
                    style={{ marginLeft:"auto",fontFamily:"var(--fm)",fontSize:11,padding:"2px 8px",borderRadius:4,border:"1px solid var(--b)",background:"transparent",color:"var(--mut)",cursor:"pointer" }}>✕</button>
                </div>
                <div
                  style={{ display:"grid",gap:12,gridTemplateColumns:colClass[cols],minHeight:72,borderRadius:10,border:`2px dashed ${dragOver===g.id?"var(--acc)":isEmpty?"var(--b2)":"transparent"}`,background:dragOver===g.id?"rgba(0,200,255,.04)":"transparent",transition:"all .12s",...(isEmpty?{display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)"}:{}) }}
                  onDragOver={e=>{e.preventDefault();setDragOver(g.id);}}
                  onDragLeave={()=>setDragOver(null)}
                  onDrop={()=>handleDrop(g.id)}>
                  {isEmpty ? <span>hierher ziehen</span> : members.map(p=>(
                    <GridCard key={p.id} player={p} groupColor={g.color}
                      onDragStart={()=>setDragId(p.id)}
                      onDragEnd={()=>{setDragId(null);setDragOver(null);}}
                      onDoubleClick={()=>setFocus(p)}
                      onOpenWindow={()=>{
                        setAppTab("windows");
                        setWins(prev=>{
                          if (prev.find(w=>w.playerId===p.id)) return prev;
                          return [...prev,{id:"w_"+p.id,playerId:p.id,x:80,y:100,w:480,h:320,minimized:false,muted:true,zIndex:maxZ+1}];
                        });
                        setMaxZ(z=>z+1);
                      }}/>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Ungrouped */}
          {ungrouped().length > 0 && (<>
            <div style={{ display:"flex",alignItems:"center",gap:8,margin:"24px 0 10px",padding:"14px 0 7px",borderTop:"1px solid var(--b)",borderBottom:"1px solid var(--b2)",fontFamily:"var(--fd)",fontWeight:700,fontSize:13,letterSpacing:1.5,textTransform:"uppercase",color:"var(--mut)" }}>
              <span style={{ width:9,height:9,borderRadius:"50%",background:"var(--mut)",display:"inline-block" }}/>
              Unzugeteilt <span style={{ fontFamily:"var(--fm)",fontSize:11,fontWeight:400,marginLeft:4 }}>{ungrouped().length}</span>
            </div>
            <div
              style={{ display:"grid",gap:12,gridTemplateColumns:colClass[cols],minHeight:72,borderRadius:10,border:`2px dashed ${dragOver==="un"?"var(--acc)":"transparent"}`,background:dragOver==="un"?"rgba(0,200,255,.04)":"transparent",transition:"all .12s" }}
              onDragOver={e=>{e.preventDefault();setDragOver("un");}}
              onDragLeave={()=>setDragOver(null)}
              onDrop={()=>handleDrop(null)}>
              {ungrouped().map(p=>(
                <GridCard key={p.id} player={p} groupColor="var(--mut)"
                  onDragStart={()=>setDragId(p.id)}
                  onDragEnd={()=>{setDragId(null);setDragOver(null);}}
                  onDoubleClick={()=>setFocus(p)}
                  onOpenWindow={()=>{
                    setAppTab("windows");
                    setWins(prev=>{
                      if (prev.find(w=>w.playerId===p.id)) return prev;
                      return [...prev,{id:"w_"+p.id,playerId:p.id,x:80,y:100,w:480,h:320,minimized:false,muted:true,zIndex:maxZ+1}];
                    });
                    setMaxZ(z=>z+1);
                  }}/>
              ))}
            </div>
          </>)}

          {!players.length && (
            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"80px 20px",gap:12,fontFamily:"var(--fd)",color:"var(--mut)" }}>
              <span style={{ fontSize:46,opacity:.3 }}>📡</span>
              <p style={{ fontSize:16,fontWeight:600,letterSpacing:1 }}>Lade Streams…</p>
            </div>
          )}
        </main>
      )}

      {/* ── WINDOWS TAB ── */}
      {appTab === "windows" && (
        <div style={{ position:"fixed",inset:0,top:80,zIndex:100,pointerEvents:"none" }}>
          {wins.length === 0 && (
            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:12,fontFamily:"var(--fd)",color:"var(--mut)",pointerEvents:"auto" }}>
              <span style={{ fontSize:46,opacity:.3 }}>⧉</span>
              <p style={{ fontSize:16,fontWeight:600,letterSpacing:1 }}>Keine Fenster offen</p>
              <button onClick={openAllWindows}
                style={{ padding:"8px 20px",fontFamily:"var(--fd)",fontWeight:700,fontSize:14,background:"var(--acc)",border:"none",borderRadius:8,color:"#000",cursor:"pointer" }}>
                Alle Streams öffnen
              </button>
            </div>
          )}
          {wins.map(w => {
            const p = players.find(pl => pl.id === w.playerId);
            if (!p) return null;
            return (
              <div key={w.id} style={{ pointerEvents:"auto" }}>
                <StreamWindow
                  win={w} player={p}
                  groupColor={getPlayerGroupColor(p.id)}
                  allWins={wins}
                  onUpdate={updateWin}
                  onClose={closeWin}
                  onFocus={focusWin}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Focus overlay */}
      <FocusOverlay player={focusPlayer} onClose={()=>setFocus(null)}/>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box}`}</style>
    </div>
  );
}

// ── GRID CARD ─────────────────────────────────────────────────
function GridCard({ player, groupColor, onDragStart, onDragEnd, onDoubleClick, onOpenWindow }: {
  player: Player; groupColor: string;
  onDragStart: () => void; onDragEnd: () => void; onDoubleClick: () => void;
  onOpenWindow: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const embedUrl = getEmbedUrl(player);
  const platIcon = player.platform==="twitch"?"🟣":player.platform==="youtube"?"▶":"📡";

  return (
    <div draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onDoubleClick={onDoubleClick}
      style={{ background:"var(--bg2)",border:"1px solid var(--b)",borderRadius:10,overflow:"hidden",cursor:"grab",position:"relative",userSelect:"none",transition:"border-color .15s,transform .12s,box-shadow .15s" }}
      onMouseEnter={e=>{(e.currentTarget as HTMLDivElement).style.borderColor="var(--b2)";(e.currentTarget as HTMLDivElement).style.transform="translateY(-2px)";}}
      onMouseLeave={e=>{(e.currentTarget as HTMLDivElement).style.borderColor="var(--b)";(e.currentTarget as HTMLDivElement).style.transform="translateY(0)";}}>
      {/* Color accent top */}
      <div style={{ height:2,background:groupColor,opacity:.6 }}/>
      <div style={{ position:"relative",width:"100%",paddingTop:"56.25%",background:"#050810",overflow:"hidden" }}>
        {loaded && embedUrl ? (
          <iframe src={embedUrl} style={{ position:"absolute",inset:0,width:"100%",height:"100%",border:"none" }} allowFullScreen allow="autoplay; encrypted-media"/>
        ) : embedUrl ? (
          <div onClick={()=>setLoaded(true)} style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:7,cursor:"pointer",background:"linear-gradient(140deg,#07090e,#0c1118)" }}>
            <div style={{ width:42,height:42,borderRadius:"50%",border:"1.5px solid rgba(255,255,255,.18)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17 }}>▶</div>
            <div style={{ fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)" }}>{(player.platform||"").toUpperCase()} · KLICKEN ZUM LADEN</div>
          </div>
        ) : (
          <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5,fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)" }}>
            <span style={{ fontSize:20,opacity:.3 }}>📵</span><span>Kein Stream</span>
          </div>
        )}
        {player.platform && <div style={{ position:"absolute",top:8,right:8,zIndex:2,width:20,height:20,borderRadius:4,background:player.platform==="twitch"?"var(--tw)":player.platform==="youtube"?"var(--yt)":"#374151",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11 }}>{platIcon}</div>}
        {/* Open in window button */}
        <button onClick={e=>{e.stopPropagation();onOpenWindow();}} title="In Fenster öffnen"
          style={{ position:"absolute",top:8,left:8,zIndex:2,width:20,height:20,borderRadius:4,background:"rgba(0,0,0,.6)",border:"1px solid var(--b2)",color:"var(--mut)",cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center" }}>
          ⧉
        </button>
      </div>
      <div style={{ padding:"9px 11px 11px" }}>
        <div style={{ fontFamily:"var(--fd)",fontWeight:700,fontSize:14,color:"var(--text)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{player.name}</div>
        <div style={{ fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)",marginTop:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>
          {player.twitch?"@"+player.twitch:player.streamUrl.slice(0,40)}
        </div>
        <div style={{ display:"flex",gap:5,marginTop:6,flexWrap:"wrap" }}>
          {[player.area,player.squadron,player.role].filter(Boolean).map((t,i)=>(
            <span key={i} style={{ fontFamily:"var(--fm)",fontSize:10,padding:"1px 6px",borderRadius:3,border:"1px solid var(--b2)",color:"var(--mut)" }}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── ROOT PAGE ─────────────────────────────────────────────────
export default function Page() {
  const [session, setSession] = useState<{ roomId: string; sheetUrl: string; sheetShareUrl: string } | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem(LS_SESSION);
    if (!saved) { setChecking(false); return; }
    try {
      const parsed = JSON.parse(saved);
      if (parsed.mode === "sheet" && parsed.sheetUrl) {
        setSession({ roomId: parsed.roomId, sheetUrl: parsed.sheetUrl, sheetShareUrl: parsed.sheetShareUrl || "" });
        setChecking(false); return;
      }
      const { roomId, pw } = parsed;
      getDoc(doc(db, "rooms", roomId, "config", "main")).then(snap => {
        if (snap.exists() && snap.data().password === pw) {
          setSession({ roomId, sheetUrl: snap.data().sheetUrl, sheetShareUrl: parsed.sheetShareUrl || snap.data().sheetShareUrl || "" });
        } else { localStorage.removeItem(LS_SESSION); }
        setChecking(false);
      }).catch(() => { localStorage.removeItem(LS_SESSION); setChecking(false); });
    } catch { localStorage.removeItem(LS_SESSION); setChecking(false); }
  }, []);

  if (checking) return (
    <div style={{ minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",zIndex:1 }}>
      <div style={{ fontFamily:"var(--fm)",fontSize:13,color:"var(--mut)",animation:"spin 1s linear infinite",display:"inline-block" }}>↻</div>
    </div>
  );
  if (!session) return <LoginScreen onLogin={(r,s,su)=>setSession({roomId:r,sheetUrl:s,sheetShareUrl:su})}/>;
  return <App roomId={session.roomId} sheetUrl={session.sheetUrl} sheetShareUrl={session.sheetShareUrl} onLogout={()=>{localStorage.removeItem(LS_SESSION);setSession(null);}}/>;
}
