"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { db } from "@/lib/firebase";
import { doc, getDoc, onSnapshot, setDoc, serverTimestamp } from "firebase/firestore";

// ── TYPES ─────────────────────────────────────────────────────
type Player = {
  id: string; name: string; area: string; role: string; squadron: string;
  twitch: string; streamUrl: string; platform: "twitch"|"youtube"|"custom"|null;
  ytVideoId: string; ampel?: string; icon?: string;
};
type Group  = { id: string; label: string; color: string; members: string[]; systemId?: string; isSpawn?: boolean; };
type WinState = { id: string; playerId: string; x: number; y: number; w: number; h: number; minimized: boolean; muted: boolean; zIndex: number; };
type OpLogEntry = { ts: number; actor: string; type: string; text: string; systemId?: string; };
type Token = { groupId: string; x: number; y: number; mapId?: string; };

// ── CONSTANTS ─────────────────────────────────────────────────
const GCOLORS    = ["#00c8ff","#ff6b35","#9147ff","#22c55e","#f59e0b","#ec4899","#06b6d4","#ef4444","#a3e635"];
const LS_SESSION = "klabsguck_session";
const LS_WINS    = "klabsguck_windows";
const SNAP_DIST  = 16;
const MIN_W = 280; const MIN_H = 180; const TITLE_H = 34;
const SYSTEM_INFO: Record<string,{short:string;color:string;bg:string}> = {
  stanton: { short:"ST", color:"#93c5fd", bg:"#1e3a5f" },
  pyro:    { short:"PY", color:"#fca5a5", bg:"#5f1e1e" },
  nyx:     { short:"NY", color:"#86efac", bg:"#1e3d2f" },
};
const OP_ICONS: Record<string,string> = {
  alive:"☠", respawn:"✓", group_change:"→", token_set:"⬡", token_move:"⬡",
  token_remove:"⬡", group_add:"＋", group_rename:"✎", group_delete:"✕",
  group_system:"⬡", op_start:"▶", op_stop:"⏹",
};
const OP_COLORS: Record<string,string> = {
  alive:"#f87171", respawn:"#4ade80", group_change:"#93c5fd",
  token_set:"#fbbf24", token_move:"#fde68a", token_remove:"#9ca3af",
  group_add:"#4ade80", group_rename:"#d1d5db", group_delete:"#f87171",
  group_system:"#c084fc", op_start:"#86efac", op_stop:"#6b7280",
};

// ── HELPERS ───────────────────────────────────────────────────
function stableId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return "p_" + (h >>> 0).toString(36);
}
function splitRow(row: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (const c of row) {
    if (c==='"') { q=!q; }
    else if (c===','&&!q) { out.push(cur); cur=""; }
    else cur+=c;
  }
  out.push(cur); return out;
}
function extractYtId(url: string): string {
  if (!url) return "";
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/live\/|\/shorts\/|\/v\/)([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  const fb = url.match(/([a-zA-Z0-9_-]{11})(?:[?&]|$)/);
  return fb ? fb[1] : "";
}
function parseCSV(text: string): Player[] {
  const lines = text.split("\n").map(l=>l.trim()).filter(Boolean);
  if (lines.length<2) return [];
  const headers = splitRow(lines[0]);
  const players: Player[] = [];
  for (let i=1;i<lines.length;i++) {
    const vals = splitRow(lines[i]);
    const row: Record<string,string> = {};
    headers.forEach((h,idx) => { row[h.trim()]=(vals[idx]||"").trim(); });
    const name = row["Spielername"]||row["Name"]||"";
    if (!name) continue;
    const streamUrl = row["StreamUrl"]||row["TwitchHandle"]||row["YouTubeChannel"]||row["YoutubeChannel"]||row["YoutubeStream"]||"";
    if (!streamUrl) continue;
    let platform: Player["platform"]=null; let twitch=""; let ytVideoId="";
    if (streamUrl.includes("twitch.tv")) {
      platform="twitch"; const m=streamUrl.match(/twitch\.tv\/([a-zA-Z0-9_]+)/); twitch=m?m[1]:streamUrl;
    } else if (streamUrl.includes("youtube.com")||streamUrl.includes("youtu.be")) {
      platform="youtube"; ytVideoId=extractYtId(streamUrl);
    } else if (streamUrl.startsWith("http")) { platform="custom"; }
    players.push({ id:row["PlayerId"]||stableId(name), name, area:row["Bereich"]||"", role:row["Rolle"]||"", squadron:row["Staffel"]||"", ampel:row["Ampel"]||"", twitch, streamUrl, platform, ytVideoId });
  }
  return players;
}
function twitchEmbedUrl(handle: string, muted=true): string {
  const host = typeof window!=="undefined"?window.location.hostname:"localhost";
  return `https://player.twitch.tv/?channel=${encodeURIComponent(handle)}&parent=${host}${muted?"&muted=1":""}`;
}
function ytEmbedUrl(id: string, muted=true): string {
  return `https://www.youtube.com/embed/${id}?autoplay=1${muted?"&mute=1":""}`;
}
function getEmbedUrl(p: Player, muted=true): string|null {
  if (p.platform==="twitch")  return twitchEmbedUrl(p.twitch,muted);
  if (p.platform==="youtube") return ytEmbedUrl(p.ytVideoId,muted);
  if (p.platform==="custom")  return p.streamUrl;
  return null;
}
function ampelColor(a?: string): string {
  if (a==="gut")    return "#16a34a";
  if (a==="mittel") return "#ca8a04";
  return a ? "#dc2626" : "transparent";
}
function snapPosition(x: number,y: number,w: number,h: number,wins: WinState[],selfId: string): {x:number;y:number} {
  const vw=typeof window!=="undefined"?window.innerWidth:1920;
  const vh=typeof window!=="undefined"?window.innerHeight:1080;
  const topOff=82;
  let nx=x; let ny=y;
  if (Math.abs(nx)<SNAP_DIST) nx=0;
  if (Math.abs(ny-topOff)<SNAP_DIST) ny=topOff;
  if (Math.abs(nx+w-vw)<SNAP_DIST) nx=vw-w;
  if (Math.abs(ny+h-vh)<SNAP_DIST) ny=vh-h;
  for (const ow of wins) {
    if (ow.id===selfId) continue;
    const oh=ow.minimized?TITLE_H:ow.h;
    if (Math.abs(nx-(ow.x+ow.w))<SNAP_DIST) nx=ow.x+ow.w;
    if (Math.abs(nx+w-ow.x)<SNAP_DIST)       nx=ow.x-w;
    if (Math.abs(ny-(ow.y+oh))<SNAP_DIST)    ny=ow.y+oh;
    if (Math.abs(ny+h-ow.y)<SNAP_DIST)       ny=ow.y-h;
    if (Math.abs(ny-ow.y)<SNAP_DIST)         ny=ow.y;
    if (Math.abs(nx-ow.x)<SNAP_DIST)         nx=ow.x;
  }
  return { x:Math.max(0,nx), y:Math.max(topOff,ny) };
}

// ── LOGIN SCREEN ──────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin:(r:string,s:string,su:string)=>void }) {
  const [mode,setMode]       = useState<"klabs"|"sheet">("klabs");
  const [roomId,setRoomId]   = useState("");
  const [pw,setPw]           = useState("");
  const [sheetUrl,setSheet]  = useState("");
  const [shareUrl,setShare]  = useState("");
  const [err,setErr]         = useState("");
  const [loading,setLoading] = useState(false);

  async function handleKlabs() {
    if (!roomId.trim()||!pw.trim()) { setErr("Bitte Raum-ID und Passwort eingeben."); return; }
    setLoading(true); setErr("");
    try {
      const snap = await getDoc(doc(db,"rooms",roomId.trim(),"config","main"));
      if (!snap.exists()) { setErr(`Raum "${roomId}" nicht gefunden.`); setLoading(false); return; }
      const cfg = snap.data() as {password:string;sheetUrl:string;sheetShareUrl?:string};
      if (cfg.password!==pw.trim()) { setErr("Falsches Passwort."); setLoading(false); return; }
      const su=cfg.sheetShareUrl||"";
      localStorage.setItem(LS_SESSION,JSON.stringify({roomId:roomId.trim(),pw:pw.trim(),mode:"klabs",sheetShareUrl:su}));
      onLogin(roomId.trim(),cfg.sheetUrl,su);
    } catch(e:any) { setErr("Fehler: "+e.message); setLoading(false); }
  }
  async function handleSheet() {
    if (!sheetUrl.trim().startsWith("http")) { setErr("Bitte eine gültige Sheet-URL."); return; }
    setLoading(true); setErr("");
    try {
      let u=sheetUrl.trim();
      if (!u.includes("range=")) u+=(u.includes("?")?"&":"?")+"range=A10:Z11";
      u+=(u.includes("?")?"&":"?")+"_t="+Date.now();
      const res=await fetch(u,{cache:"no-store"});
      if (!res.ok) throw new Error("Sheet nicht erreichbar");
      const lbl="sheet_"+Date.now();
      localStorage.setItem(LS_SESSION,JSON.stringify({roomId:lbl,sheetUrl:sheetUrl.trim(),sheetShareUrl:shareUrl.trim(),mode:"sheet"}));
      onLogin(lbl,sheetUrl.trim(),shareUrl.trim());
    } catch(e:any) { setErr("Fehler: "+e.message); setLoading(false); }
  }

  const inp: React.CSSProperties = {width:"100%",padding:"9px 12px",fontFamily:"var(--fm)",fontSize:13,background:"var(--bg3)",border:"1px solid var(--b2)",borderRadius:8,color:"var(--text)",outline:"none"};
  const tabS=(a:boolean): React.CSSProperties=>({flex:1,padding:"8px 0",fontFamily:"var(--fd)",fontWeight:700,fontSize:13,cursor:"pointer",border:"1px solid var(--b2)",borderRadius:8,background:a?"var(--acc)":"transparent",color:a?"#000":"var(--mut)"});

  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,position:"relative",zIndex:1}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--b2)",borderRadius:16,padding:36,width:"100%",maxWidth:420,boxShadow:"0 24px 80px rgba(0,0,0,.6)"}}>
        <div style={{fontFamily:"var(--fd)",fontWeight:700,fontSize:28,letterSpacing:2,color:"var(--acc)",textTransform:"uppercase",marginBottom:4}}>Klabsguck</div>
        <div style={{fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)",marginBottom:24}}>stream dashboard</div>
        <div style={{display:"flex",gap:6,marginBottom:24}}>
          <button style={tabS(mode==="klabs")} onClick={()=>{setMode("klabs");setErr("");}}>KlabsCom Raum</button>
          <button style={tabS(mode==="sheet")} onClick={()=>{setMode("sheet");setErr("");}}>Sheet-URL direkt</button>
        </div>
        {mode==="klabs"&&<>
          <div style={{marginBottom:14}}><label style={{display:"block",fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)",marginBottom:4}}>RAUM-ID</label>
            <input type="text" placeholder="z.B. alpha-ops" value={roomId} onChange={e=>setRoomId(e.target.value)} onKeyDown={e=>e.key==="Enter"&&document.getElementById("pw-inp")?.focus()} style={inp}/></div>
          <div style={{marginBottom:14}}><label style={{display:"block",fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)",marginBottom:4}}>TEAM-PASSWORT</label>
            <input type="password" id="pw-inp" placeholder="Team-Passwort" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleKlabs()} style={inp}/></div>
          <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)",marginBottom:16,lineHeight:1.5}}>Selbe Raum-ID und Passwort wie bei KlabsCom.<br/>Gruppen, Op-Log und Notizen werden automatisch geladen.</div>
          <button onClick={handleKlabs} disabled={loading} style={{width:"100%",padding:10,fontFamily:"var(--fd)",fontWeight:700,fontSize:15,background:"var(--acc)",border:"none",borderRadius:8,color:"#000",cursor:"pointer",opacity:loading?.5:1}}>{loading?"Prüfe…":"Einloggen →"}</button>
        </>}
        {mode==="sheet"&&<>
          <div style={{marginBottom:14}}><label style={{display:"block",fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)",marginBottom:4}}>GOOGLE SHEET CSV-URL</label>
            <input type="text" placeholder="https://docs.google.com/spreadsheets/d/…/export?format=csv" value={sheetUrl} onChange={e=>setSheet(e.target.value)} style={{...inp,fontSize:11}}/></div>
          <div style={{marginBottom:14}}><label style={{display:"block",fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)",marginBottom:4}}>SHEET FREIGABE-LINK <span style={{color:"var(--mut)"}}>· optional</span></label>
            <input type="text" placeholder="https://docs.google.com/spreadsheets/d/…/edit" value={shareUrl} onChange={e=>setShare(e.target.value)} style={{...inp,fontSize:11}}/></div>
          <div style={{fontFamily:"var(--fm)",fontSize:10,color:"rgba(255,165,0,.7)",marginBottom:16}}>⚠ Klabscom-Features (Gruppen-Sync, Op-Log, Notizen) nicht verfügbar.</div>
          <button onClick={handleSheet} disabled={loading} style={{width:"100%",padding:10,fontFamily:"var(--fd)",fontWeight:700,fontSize:15,background:"var(--acc2)",border:"none",borderRadius:8,color:"#fff",cursor:"pointer",opacity:loading?.5:1}}>{loading?"Prüfe…":"Sheet laden →"}</button>
        </>}
        {err&&<div style={{fontFamily:"var(--fm)",fontSize:11,color:"#f87171",marginTop:10}}>{err}</div>}
      </div>
    </div>
  );
}

// ── COLOR PICKER ──────────────────────────────────────────────
function ColorPicker({ current,onChange }: { current:string;onChange:(c:string)=>void }) {
  const [open,setOpen]=useState(false);
  return (
    <div style={{position:"relative"}}>
      <div onClick={e=>{e.stopPropagation();setOpen(v=>!v);}} style={{width:10,height:10,borderRadius:"50%",background:current,cursor:"pointer",flexShrink:0}}/>
      {open&&<div onClick={e=>e.stopPropagation()} style={{position:"absolute",top:16,left:0,zIndex:50,background:"var(--bg2)",border:"1px solid var(--b2)",borderRadius:10,padding:8,display:"flex",flexWrap:"wrap",gap:5,width:130,boxShadow:"0 8px 32px rgba(0,0,0,.5)"}}>
        {GCOLORS.map(c=><div key={c} onClick={()=>{onChange(c);setOpen(false);}} style={{width:18,height:18,borderRadius:"50%",background:c,cursor:"pointer",border:c===current?"2px solid rgba(255,255,255,.8)":"2px solid transparent"}}/>)}
      </div>}
    </div>
  );
}

// ── SYSTEM BADGES ─────────────────────────────────────────────
function SystemBadges({ systems }: { systems: string[] }) {
  if (!systems.length) return null;
  const unique = systems.filter((s,i)=>systems.indexOf(s)===i);
  return (
    <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
      {unique.map(s => {
        const info = SYSTEM_INFO[s] ?? { short:s.slice(0,2).toUpperCase(), color:"#9ca3af", bg:"#374151" };
        return (
          <span key={s} style={{fontFamily:"var(--fm)",fontSize:10,fontWeight:700,padding:"1px 5px",borderRadius:4,color:info.color,background:info.bg,border:`1px solid ${info.color}44`}}>
            {info.short}
          </span>
        );
      })}
    </div>
  );
}

// ── STREAM WINDOW ─────────────────────────────────────────────
function StreamWindow({ win,player,groupColor,systemIds,aliveState,allWins,onUpdate,onClose,onFocus }: {
  win:WinState; player:Player; groupColor:string; systemIds:string[];
  aliveState:Record<string,string>;
  allWins:WinState[]; onUpdate:(id:string,p:Partial<WinState>)=>void;
  onClose:(id:string)=>void; onFocus:(id:string)=>void;
}) {
  const dragRef  = useRef<{sx:number;sy:number;wx:number;wy:number}|null>(null);
  const resizeRef = useRef<{sx:number;sy:number;ww:number;wh:number}|null>(null);
  const [muteKey,setMuteKey] = useState(0);
  const isDead = aliveState[player.id]==="dead";
  const embedUrl = getEmbedUrl(player,win.muted);
  const platIcon = player.platform==="twitch"?"🟣":player.platform==="youtube"?"▶":"📡";
  const platColor = player.platform==="twitch"?"var(--tw)":player.platform==="youtube"?"var(--yt)":"#374151";

  function onTitleDown(e:React.PointerEvent) {
    if ((e.target as HTMLElement).dataset.btn) return;
    e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current={sx:e.clientX,sy:e.clientY,wx:win.x,wy:win.y}; onFocus(win.id);
  }
  function onTitleMove(e:React.PointerEvent) {
    if (!dragRef.current) return;
    const raw={x:dragRef.current.wx+e.clientX-dragRef.current.sx, y:dragRef.current.wy+e.clientY-dragRef.current.sy};
    onUpdate(win.id, snapPosition(raw.x,raw.y,win.w,win.minimized?TITLE_H:win.h,allWins,win.id));
  }
  function onResizeDown(e:React.PointerEvent) {
    e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current={sx:e.clientX,sy:e.clientY,ww:win.w,wh:win.h}; onFocus(win.id);
  }
  function onResizeMove(e:React.PointerEvent) {
    if (!resizeRef.current) return;
    onUpdate(win.id,{w:Math.max(MIN_W,resizeRef.current.ww+e.clientX-resizeRef.current.sx),h:Math.max(MIN_H,resizeRef.current.wh+e.clientY-resizeRef.current.sy)});
  }

  return (
    <div onPointerDown={()=>onFocus(win.id)} style={{position:"fixed",left:win.x,top:win.y,width:win.w,height:win.minimized?TITLE_H:win.h,zIndex:win.zIndex,display:"flex",flexDirection:"column",background:"var(--bg2)",border:`1px solid ${groupColor}44`,borderRadius:10,overflow:"hidden",boxShadow:`0 4px 24px rgba(0,0,0,.5), 0 0 0 1px ${groupColor}22`,transition:"height .15s",userSelect:"none",opacity:isDead?.7:1}}>
      {/* Title */}
      <div onPointerDown={onTitleDown} onPointerMove={onTitleMove} onPointerUp={()=>{dragRef.current=null;}} style={{height:TITLE_H,flexShrink:0,display:"flex",alignItems:"center",gap:6,padding:"0 8px",cursor:"grab",background:`linear-gradient(90deg,${groupColor}33 0%,var(--bg3) 100%)`,borderBottom:`1px solid ${groupColor}33`}}>
        <div style={{width:16,height:16,borderRadius:3,background:platColor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,flexShrink:0}}>{platIcon}</div>
        {isDead&&<span style={{fontSize:11,color:"#f87171",flexShrink:0}}>☠</span>}
        <div style={{fontFamily:"var(--fd)",fontWeight:700,fontSize:13,color:isDead?"#9ca3af":"var(--text)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textDecoration:isDead?"line-through":"none"}}>{player.name}</div>
        {systemIds.length>0&&<SystemBadges systems={systemIds}/>}
        <div style={{display:"flex",gap:3,flexShrink:0}}>
          <button data-btn="1" onClick={()=>{onUpdate(win.id,{muted:!win.muted});setMuteKey(k=>k+1);}} title={win.muted?"Ton an":"Ton aus"}
            style={{width:22,height:22,borderRadius:4,border:`1px solid ${win.muted?"var(--b2)":"var(--acc)"}`,background:"transparent",color:win.muted?"var(--mut)":"var(--acc)",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center"}}>
            {win.muted?"🔇":"🔊"}
          </button>
          <button data-btn="1" onClick={()=>onUpdate(win.id,{minimized:!win.minimized})}
            style={{width:22,height:22,borderRadius:4,border:"1px solid var(--b2)",background:"transparent",color:"var(--mut)",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>
            {win.minimized?"□":"─"}
          </button>
          <button data-btn="1" onClick={()=>onClose(win.id)}
            style={{width:22,height:22,borderRadius:4,border:"1px solid var(--b2)",background:"transparent",color:"var(--mut)",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
      </div>
      {!win.minimized&&<div style={{flex:1,position:"relative",background:"#050810"}}>
        {embedUrl
          ? <iframe key={`${win.id}-${win.muted}-${muteKey}`} src={embedUrl} style={{position:"absolute",inset:0,width:"100%",height:"100%",border:"none"}} allowFullScreen allow="autoplay; encrypted-media"/>
          : <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:8,fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)"}}><span style={{fontSize:24,opacity:.3}}>📵</span><span>Kein Stream</span></div>
        }
        <div onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={()=>{resizeRef.current=null;}}
          style={{position:"absolute",bottom:0,right:0,width:18,height:18,cursor:"se-resize",zIndex:10,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,.4)"}}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="var(--mut)"><path d="M10 0L0 10h2L10 2V0zm0 4L4 10h2l4-4V4zm0 4l-2 2h2V8z"/></svg>
        </div>
      </div>}
    </div>
  );
}

// ── GRID CARD ─────────────────────────────────────────────────
function GridCard({ player,groupColor,systemIds,aliveState,onDragStart,onDragEnd,onDoubleClick,onOpenWindow }: {
  player:Player; groupColor:string; systemIds:string[]; aliveState:Record<string,string>;
  onDragStart:()=>void; onDragEnd:()=>void; onDoubleClick:()=>void; onOpenWindow:()=>void;
}) {
  const [loaded,setLoaded]=useState(false);
  const embedUrl=getEmbedUrl(player);
  const isDead=aliveState[player.id]==="dead";
  const platIcon=player.platform==="twitch"?"🟣":player.platform==="youtube"?"▶":"📡";
  return (
    <div draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onDoubleClick={onDoubleClick}
      style={{background:"var(--bg2)",border:"1px solid var(--b)",borderRadius:10,overflow:"hidden",cursor:"grab",position:"relative",userSelect:"none",transition:"border-color .15s,transform .12s",opacity:isDead?.55:1}}
      onMouseEnter={e=>{(e.currentTarget as HTMLDivElement).style.borderColor="var(--b2)";(e.currentTarget as HTMLDivElement).style.transform="translateY(-2px)";}}
      onMouseLeave={e=>{(e.currentTarget as HTMLDivElement).style.borderColor="var(--b)";(e.currentTarget as HTMLDivElement).style.transform="translateY(0)";}}>
      <div style={{height:2,background:groupColor,opacity:.7}}/>
      {/* Ampel bar */}
      {player.ampel&&<div style={{height:2,background:ampelColor(player.ampel)}}/>}
      <div style={{position:"relative",width:"100%",paddingTop:"56.25%",background:"#050810",overflow:"hidden"}}>
        {loaded&&embedUrl
          ? <iframe src={embedUrl} style={{position:"absolute",inset:0,width:"100%",height:"100%",border:"none"}} allowFullScreen allow="autoplay; encrypted-media"/>
          : embedUrl
            ? <div onClick={()=>setLoaded(true)} style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:7,cursor:"pointer",background:"linear-gradient(140deg,#07090e,#0c1118)"}}>
                {isDead&&<span style={{fontSize:28}}>☠</span>}
                {!isDead&&<><div style={{width:42,height:42,borderRadius:"50%",border:"1.5px solid rgba(255,255,255,.18)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:17}}>▶</div>
                <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)"}}>{(player.platform||"").toUpperCase()} · KLICKEN ZUM LADEN</div></>}
              </div>
            : <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:5,fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)"}}><span style={{fontSize:20,opacity:.3}}>📵</span><span>Kein Stream</span></div>
        }
        {player.platform&&<div style={{position:"absolute",top:8,right:8,zIndex:2,width:20,height:20,borderRadius:4,background:player.platform==="twitch"?"var(--tw)":player.platform==="youtube"?"var(--yt)":"#374151",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11}}>{platIcon}</div>}
        <button onClick={e=>{e.stopPropagation();onOpenWindow();}} title="In Fenster öffnen"
          style={{position:"absolute",top:8,left:8,zIndex:2,width:20,height:20,borderRadius:4,background:"rgba(0,0,0,.6)",border:"1px solid var(--b2)",color:"var(--mut)",cursor:"pointer",fontSize:10,display:"flex",alignItems:"center",justifyContent:"center"}}>⧉</button>
      </div>
      <div style={{padding:"9px 11px 11px"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          <div style={{fontFamily:"var(--fd)",fontWeight:700,fontSize:14,color:isDead?"#9ca3af":"var(--text)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textDecoration:isDead?"line-through":"none"}}>
            {isDead&&<span style={{marginRight:4}}>☠</span>}{player.name}
          </div>
          {systemIds.length>0&&<SystemBadges systems={systemIds}/>}
        </div>
        <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          {player.twitch?"@"+player.twitch:player.streamUrl.slice(0,40)}
        </div>
        <div style={{display:"flex",gap:5,marginTop:6,flexWrap:"wrap"}}>
          {[player.area,player.squadron,player.role].filter(Boolean).map((t,i)=>(
            <span key={i} style={{fontFamily:"var(--fm)",fontSize:10,padding:"1px 6px",borderRadius:3,border:"1px solid var(--b2)",color:"var(--mut)"}}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── SIDEBAR ───────────────────────────────────────────────────
function Sidebar({ open,onClose,opLog,notesText,systemNotes,systems }: {
  open:boolean; onClose:()=>void;
  opLog:OpLogEntry[]; notesText:string;
  systemNotes:Record<string,string>; systems:{id:string;label:string}[];
}) {
  const [tab,setTab]=useState<"oplog"|"notes">("oplog");
  const [sysFilter,setSysFilter]=useState("all");
  const logRef=useRef<HTMLDivElement>(null);

  useEffect(()=>{
    if (logRef.current) logRef.current.scrollTop=logRef.current.scrollHeight;
  },[opLog.length]);

  const filtered = sysFilter==="all" ? opLog : opLog.filter(e=>e.systemId===sysFilter);

  return (
    <>
      {/* Backdrop */}
      {open&&<div onClick={onClose} style={{position:"fixed",inset:0,zIndex:149,background:"rgba(0,0,0,.3)"}}/>}
      {/* Panel */}
      <div style={{position:"fixed",top:0,right:0,bottom:0,zIndex:150,width:340,background:"var(--bg2)",borderLeft:"1px solid var(--b2)",display:"flex",flexDirection:"column",transform:open?"translateX(0)":"translateX(100%)",transition:"transform .25s",boxShadow:open?"-8px 0 32px rgba(0,0,0,.4)":"none"}}>
        {/* Header */}
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"12px 16px",borderBottom:"1px solid var(--b2)",flexShrink:0}}>
          <button onClick={()=>setTab("oplog")} style={{flex:1,padding:"5px 0",fontFamily:"var(--fd)",fontWeight:700,fontSize:12,letterSpacing:.5,cursor:"pointer",border:"1px solid var(--b2)",borderRadius:6,background:tab==="oplog"?"var(--acc)":"transparent",color:tab==="oplog"?"#000":"var(--mut)"}}>📋 Op-Log</button>
          <button onClick={()=>setTab("notes")} style={{flex:1,padding:"5px 0",fontFamily:"var(--fd)",fontWeight:700,fontSize:12,letterSpacing:.5,cursor:"pointer",border:"1px solid var(--b2)",borderRadius:6,background:tab==="notes"?"var(--acc)":"transparent",color:tab==="notes"?"#000":"var(--mut)"}}>📝 Notizen</button>
          <button onClick={onClose} style={{width:28,height:28,borderRadius:6,border:"1px solid var(--b2)",background:"transparent",color:"var(--mut)",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>

        {/* Op-Log Tab */}
        {tab==="oplog"&&<>
          {/* System filter */}
          <div style={{display:"flex",gap:4,padding:"8px 12px",borderBottom:"1px solid var(--b)",flexShrink:0,flexWrap:"wrap"}}>
            <button onClick={()=>setSysFilter("all")} style={{fontFamily:"var(--fm)",fontSize:10,padding:"2px 8px",borderRadius:10,border:"1px solid var(--b2)",background:sysFilter==="all"?"var(--acc)":"transparent",color:sysFilter==="all"?"#000":"var(--mut)",cursor:"pointer"}}>🌌 Alle</button>
            {systems.map(s=>{
              const info=SYSTEM_INFO[s.id]??{short:s.id.slice(0,2).toUpperCase(),color:"#9ca3af",bg:"#374151"};
              return <button key={s.id} onClick={()=>setSysFilter(s.id)} style={{fontFamily:"var(--fm)",fontSize:10,padding:"2px 8px",borderRadius:10,border:`1px solid ${info.color}44`,background:sysFilter===s.id?info.bg:"transparent",color:sysFilter===s.id?info.color:"var(--mut)",cursor:"pointer"}}>{info.short}</button>;
            })}
          </div>
          <div ref={logRef} style={{flex:1,overflow:"auto",padding:"8px 12px",fontFamily:"var(--fm)",fontSize:11}}>
            {filtered.length===0&&<div style={{color:"var(--mut)",textAlign:"center",padding:"40px 0"}}>Keine Einträge</div>}
            {filtered.map((e,i)=>(
              <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",padding:"3px 0",borderBottom:"1px solid var(--b)"}}>
                <span style={{color:"var(--mut)",flexShrink:0,minWidth:32,fontSize:10}}>{new Date(e.ts).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})}</span>
                <span style={{flexShrink:0,width:14,textAlign:"center",color:OP_COLORS[e.type]??"var(--mut)"}}>{OP_ICONS[e.type]??"·"}</span>
                <span style={{color:"#d1d5db",flex:1,lineHeight:1.4}}>{e.text}</span>
              </div>
            ))}
          </div>
        </>}

        {/* Notes Tab */}
        {tab==="notes"&&<div style={{flex:1,overflow:"auto",padding:"12px"}}>
          {notesText&&<>
            <div style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)",marginBottom:6,letterSpacing:.5}}>🌌 GALAXIE-NOTIZEN</div>
            <pre style={{fontFamily:"var(--fm)",fontSize:11,color:"#d1d5db",whiteSpace:"pre-wrap",lineHeight:1.6,background:"var(--bg3)",borderRadius:8,padding:"10px 12px",marginBottom:16,border:"1px solid var(--b)"}}>{notesText}</pre>
          </>}
          {systems.map(s=>{
            const txt=systemNotes[s.id];
            if (!txt) return null;
            const info=SYSTEM_INFO[s.id]??{short:s.id.slice(0,2).toUpperCase(),color:"#9ca3af",bg:"#374151"};
            return <div key={s.id} style={{marginBottom:16}}>
              <div style={{fontFamily:"var(--fm)",fontSize:10,color:info.color,marginBottom:6,letterSpacing:.5}}>{info.short} {s.label.toUpperCase()}-NOTIZEN</div>
              <pre style={{fontFamily:"var(--fm)",fontSize:11,color:"#d1d5db",whiteSpace:"pre-wrap",lineHeight:1.6,background:info.bg+"33",borderRadius:8,padding:"10px 12px",border:`1px solid ${info.color}33`}}>{txt}</pre>
            </div>;
          })}
          {!notesText&&systems.every(s=>!systemNotes[s.id])&&<div style={{color:"var(--mut)",textAlign:"center",fontFamily:"var(--fm)",fontSize:11,padding:"40px 0"}}>Keine Notizen vorhanden</div>}
        </div>}
      </div>
    </>
  );
}

// ── FOCUS OVERLAY ─────────────────────────────────────────────
function FocusOverlay({ player,onClose }: { player:Player|null;onClose:()=>void }) {
  if (!player) return null;
  const url=getEmbedUrl(player,false);
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,.92)",backdropFilter:"blur(10px)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14}}>
      <button onClick={onClose} style={{position:"absolute",top:16,right:16,width:36,height:36,borderRadius:8,background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.15)",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
      <div style={{width:"min(1020px,92vw)",aspectRatio:"16/9",borderRadius:10,overflow:"hidden"}}>
        {url?<iframe src={url} style={{width:"100%",height:"100%",border:"none"}} allowFullScreen allow="autoplay; encrypted-media"/>
            :<div style={{width:"100%",height:"100%",background:"var(--bg2)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--mut)",fontFamily:"var(--fm)"}}>Kein Stream</div>}
      </div>
      <div style={{color:"rgba(255,255,255,.7)",fontFamily:"var(--fd)",fontSize:15,fontWeight:600}}>{player.name}</div>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────
function App({ roomId,sheetUrl,sheetShareUrl,onLogout }: { roomId:string;sheetUrl:string;sheetShareUrl:string;onLogout:()=>void }) {
  const [players,setPlayers]         = useState<Player[]>([]);
  // Klabscom board state
  const [klabsGroups,setKlabsGroups] = useState<Group[]>([]);
  const [klabsCols,setKlabsCols]     = useState<Record<string,string[]>>({});
  const [aliveState,setAliveState]   = useState<Record<string,string>>({});
  const [tokensBySys,setTokensBySys] = useState<Record<string,Token[]>>({});
  const [opLog,setOpLog]             = useState<OpLogEntry[]>([]);
  const [notesText,setNotesText]     = useState("");
  const [sysNotes,setSysNotes]       = useState<Record<string,string>>({});
  const [klabsSystems,setKlabsSystems] = useState<{id:string;label:string}[]>([]);
  // Local overrides on top of klabscom groups
  const [localGroups,setLocalGroups] = useState<Group[]>([]);
  const [localCols,setLocalCols]     = useState<Record<string,string[]>>({});
  const [groupsInit,setGroupsInit]   = useState(false);
  // UI state
  const [appTab,setAppTab]           = useState<"grid"|"windows">("grid");
  const [platFilter,setPlatFilter]   = useState("all");
  const [search,setSearch]           = useState("");
  const [cols,setCols]               = useState(3);
  const [focusPlayer,setFocus]       = useState<Player|null>(null);
  const [dragId,setDragId]           = useState<string|null>(null);
  const [dragOver,setDragOver]       = useState<string|null>(null);
  const [lastRefresh,setLastRefresh] = useState("");
  const [loading,setLoading]         = useState(false);
  const [copied,setCopied]           = useState(false);
  const [sidebarOpen,setSidebarOpen] = useState(false);
  const [wins,setWins]               = useState<WinState[]>(()=>{ try{return JSON.parse(localStorage.getItem(LS_WINS)||"[]");}catch{return [];} });
  const [maxZ,setMaxZ]               = useState(10);
  const pollRef = useRef<ReturnType<typeof setInterval>|null>(null);

  useEffect(()=>{ localStorage.setItem(LS_WINS,JSON.stringify(wins)); },[wins]);

  // ── Load klabscom board state ──
  useEffect(()=>{
    const ref=doc(db,"rooms",roomId,"state","board");
    const unsub=onSnapshot(ref,snap=>{
      if (!snap.exists()) return;
      const d=snap.data() as any;
      // Groups + columns
      if (Array.isArray(d.groups)&&d.groups.length>0) {
        setKlabsGroups(d.groups.map((g:any)=>({...g,members:[]})));
        setKlabsCols(d.columns??{});
      }
      // Alive state
      if (d.aliveState) setAliveState(d.aliveState);
      // Tokens by system
      if (d.tokensBySystem) setTokensBySys(d.tokensBySystem);
      // Op-Log
      if (Array.isArray(d.opLogEntries)) setOpLog(d.opLogEntries.slice(-200));
      // Notes
      if (typeof d.notesText==="string") setNotesText(d.notesText);
      if (d.systemNotesTexts) setSysNotes(d.systemNotesTexts);
      // Systems
      if (Array.isArray(d.systems)) setKlabsSystems(d.systems);
    });
    return ()=>unsub();
  },[roomId]);

  // ── Local group overrides (streamdash collection) ──
  useEffect(()=>{
    const ref=doc(db,"streamdash",roomId);
    const unsub=onSnapshot(ref,snap=>{
      if (!snap.exists()) return;
      const d=snap.data() as any;
      if (Array.isArray(d.groups)) { setLocalGroups(d.groups); setGroupsInit(true); }
      if (d.columns) setLocalCols(d.columns);
    });
    getDoc(doc(db,"streamdash",roomId)).then(snap=>{
      if (snap.exists()) {
        const d=snap.data() as any;
        if (Array.isArray(d.groups)) { setLocalGroups(d.groups); setGroupsInit(true); }
        if (d.columns) setLocalCols(d.columns);
      } else { setGroupsInit(true); }
    });
    return ()=>unsub();
  },[roomId]);

  // When klabscom groups load and we have no local overrides yet → seed from klabscom
  useEffect(()=>{
    if (!groupsInit||klabsGroups.length===0||localGroups.length>0) return;
    // Seed local groups from klabscom groups
    const seeded=klabsGroups.filter(g=>!g.isSpawn).map(g=>({...g,members:(klabsCols[g.id]??[])})) as Group[];
    setLocalGroups(seeded);
    const cols: Record<string,string[]>={};
    seeded.forEach(g=>{ cols[g.id]=g.members; });
    setLocalCols(cols);
    persistGroups(seeded,cols);
  },[groupsInit,klabsGroups,localGroups.length]);

  function persistGroups(grps:Group[], cols:Record<string,string[]>) {
    setDoc(doc(db,"streamdash",roomId),{groups:grps,columns:cols,updatedAt:serverTimestamp()},{merge:true}).catch(console.warn);
  }

  // ── Merged groups: klabscom as read-only reference, localGroups as working set ──
  // If a klabscom group exists but not in local → add it
  useEffect(()=>{
    if (!groupsInit||klabsGroups.length===0) return;
    setLocalGroups(prev=>{
      const existingIds=new Set(prev.map(g=>g.id));
      const newGroups=klabsGroups.filter(g=>!g.isSpawn&&!existingIds.has(g.id)).map(g=>({...g,members:(klabsCols[g.id]??[])})) as Group[];
      if (!newGroups.length) return prev;
      const next=[...prev,...newGroups];
      const nextCols={...localCols};
      newGroups.forEach(g=>{ nextCols[g.id]=g.members; });
      setLocalCols(nextCols);
      persistGroups(next,nextCols);
      return next;
    });
  },[klabsGroups,klabsCols,groupsInit]);

  // ── Sheet loading ──
  const loadSheet=useCallback(async()=>{
    if (!sheetUrl) return;
    setLoading(true);
    let u=sheetUrl;
    if (!u.includes("range=")) u+=(u.includes("?")?"&":"?")+"range=A10:Z10000";
    u+=(u.includes("?")?"&":"?")+"_t="+Date.now();
    try {
      const res=await fetch(u,{cache:"no-store"});
      const text=await res.text();
      setPlayers(parseCSV(text));
      setLastRefresh(new Date().toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"}));
    } catch(e:any){console.warn("Sheet:",e);}
    setLoading(false);
  },[sheetUrl]);

  useEffect(()=>{ loadSheet(); pollRef.current=setInterval(loadSheet,60_000); return()=>{if(pollRef.current)clearInterval(pollRef.current);}; },[loadSheet]);

  // ── Auto-open windows ──
  useEffect(()=>{
    if (appTab!=="windows"||players.length===0) return;
    setWins(prev=>{
      const existing=new Set(prev.map(w=>w.playerId));
      const news: WinState[]=[];
      let col=0; let row=0;
      players.forEach(p=>{
        if (existing.has(p.id)) return;
        news.push({id:"w_"+p.id,playerId:p.id,x:col*408,y:90+row*288,w:400,h:280,minimized:false,muted:true,zIndex:10});
        col++; if(col>=3){col=0;row++;}
      });
      return news.length>0?[...prev,...news]:prev;
    });
  },[appTab,players]);

  // ── Window helpers ──
  function updateWin(id:string,patch:Partial<WinState>){setWins(prev=>prev.map(w=>w.id===id?{...w,...patch}:w));}
  function closeWin(id:string){setWins(prev=>prev.filter(w=>w.id!==id));}
  function focusWin(id:string){setMaxZ(z=>{const nz=z+1;setWins(prev=>prev.map(w=>w.id===id?{...w,zIndex:nz}:w));return nz;});}
  function openAllWins(){setWins(prev=>{const ex=new Set(prev.map(w=>w.playerId));const news:WinState[]=[];let col=0;let row=0;players.forEach(p=>{if(ex.has(p.id))return;news.push({id:"w_"+p.id,playerId:p.id,x:col*408,y:90+row*288,w:400,h:280,minimized:false,muted:true,zIndex:10});col++;if(col>=3){col=0;row++;}});return[...prev,...news];});}
  function tileWins(){const vw=window.innerWidth;const count=wins.length;if(!count)return;const c=Math.ceil(Math.sqrt(count));const r=Math.ceil(count/c);const ww=Math.floor((vw-(c+1)*8)/c);const wh=Math.floor((window.innerHeight-90-(r+1)*8)/r);setWins(prev=>prev.map((w,i)=>({...w,x:8+(i%c)*(ww+8),y:90+Math.floor(i/c)*(wh+8),w:Math.max(MIN_W,ww),h:Math.max(MIN_H,wh),minimized:false})));}

  // ── Group helpers ──
  function saveGroups(grps:Group[],cols:Record<string,string[]>){setLocalGroups(grps);setLocalCols(cols);persistGroups(grps,cols);}
  function addGroup(){
    const g:Group={id:"g_"+Date.now(),label:"Gruppe "+(localGroups.length+1),color:GCOLORS[localGroups.length%GCOLORS.length],members:[]};
    const next=[...localGroups,g]; const nc={...localCols,[g.id]:[]}; saveGroups(next,nc);
    setTimeout(()=>{const el=document.getElementById("gn_"+g.id) as HTMLInputElement;if(el){el.focus();el.select();}},50);
  }
  function moveToGroup(pid:string,gid:string|null){
    const next=localGroups.map(g=>({...g,members:(g.members||[]).filter(id=>id!==pid)}));
    const nc: Record<string,string[]>={};
    next.forEach(g=>{nc[g.id]=(g.members||[]);});
    if (gid){const idx=next.findIndex(g=>g.id===gid);if(idx!==-1){next[idx].members=[...(next[idx].members||[]),pid];nc[gid]=[...(nc[gid]||[]),pid];}}
    saveGroups(next,nc);
  }

  // ── Get systems for a player's group tokens ──
  function getPlayerSystems(pid:string): string[] {
    const group=localGroups.find(g=>(g.members||[]).includes(pid));
    if (!group) return [];
    const systems: string[]=[];
    Object.entries(tokensBySys).forEach(([sysId,tokens])=>{
      if ((tokens as Token[]).some(t=>t.groupId===group.id)) systems.push(sysId);
    });
    return systems;
  }

  // ── Filtering ──
  const filtered=players.filter(p=>{
    if (platFilter!=="all"&&p.platform!==platFilter) return false;
    if (search){const q=search.toLowerCase();if(![p.name,p.area,p.role,p.squadron,p.twitch].some(v=>v?.toLowerCase().includes(q)))return false;}
    return true;
  });
  const filteredIds=new Set(filtered.map(p=>p.id));

  function ungrouped(){
    const assigned=new Set(localGroups.flatMap(g=>g.members||[]));
    return filtered.filter(p=>!assigned.has(p.id));
  }

  function copySheet(){if(!sheetShareUrl)return;navigator.clipboard.writeText(sheetShareUrl).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});}

  const tw=players.filter(p=>p.platform==="twitch").length;
  const yt=players.filter(p=>p.platform==="youtube").length;
  const cu=players.filter(p=>p.platform==="custom").length;
  const colClass: Record<number,string>={1:"repeat(1,1fr)",2:"repeat(2,1fr)",3:"repeat(3,1fr)",4:"repeat(4,1fr)",5:"repeat(5,1fr)"};
  const liveOpCount=opLog.filter(e=>Date.now()-e.ts<5*60*1000).length;

  return (
    <div style={{position:"relative",zIndex:1}}>
      {/* ── HEADER ── */}
      <header style={{position:"sticky",top:0,zIndex:200,background:"rgba(7,10,15,.96)",backdropFilter:"blur(12px)",borderBottom:"1px solid var(--b2)",padding:"0 20px",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",minHeight:52}}>
        <div style={{fontFamily:"var(--fd)",fontWeight:700,fontSize:17,letterSpacing:2,color:"var(--acc)",textTransform:"uppercase",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          Klabsguck
          <span style={{color:"var(--mut)",fontSize:11,fontFamily:"var(--fm)",letterSpacing:0}}>STREAMS</span>
          <span style={{color:"rgba(0,200,255,.5)",fontSize:12,fontFamily:"var(--fm)"}}>{roomId}</span>
        </div>
        {/* App tabs */}
        <div style={{display:"flex",gap:4,flexShrink:0}}>
          {(["grid","windows"] as const).map(t=>(
            <button key={t} onClick={()=>setAppTab(t)} style={{fontFamily:"var(--fd)",fontWeight:700,fontSize:13,padding:"3px 14px",borderRadius:20,cursor:"pointer",letterSpacing:.4,border:"1px solid var(--b2)",color:appTab===t?"#000":"var(--mut)",background:appTab===t?"var(--acc)":"transparent",transition:"all .15s"}}>
              {t==="grid"?"⊞ Grid":"⧉ Fenster"}
            </button>
          ))}
        </div>
        <div style={{width:1,height:20,background:"var(--b2)",flexShrink:0}}/>
        {[{id:"all",label:"Alle"},{id:"twitch",label:"Twitch"},{id:"youtube",label:"YouTube"},{id:"custom",label:"Custom"}].map(f=>(
          <button key={f.id} onClick={()=>setPlatFilter(f.id)} style={{fontFamily:"var(--fd)",fontWeight:600,fontSize:13,padding:"3px 12px",borderRadius:20,cursor:"pointer",letterSpacing:.4,border:"1px solid var(--b2)",color:platFilter===f.id?"#000":"var(--mut)",background:platFilter===f.id?"var(--acc)":"transparent",transition:"all .15s"}}>{f.label}</button>
        ))}
        <div style={{width:1,height:20,background:"var(--b2)",flexShrink:0}}/>
        <input type="text" placeholder="Suchen…" value={search} onChange={e=>setSearch(e.target.value)} style={{height:28,padding:"0 10px",fontFamily:"var(--fm)",fontSize:12,background:"var(--bg3)",border:"1px solid var(--b2)",borderRadius:6,color:"var(--text)",outline:"none",width:150}}/>
        {appTab==="grid"&&<><div style={{width:1,height:20,background:"var(--b2)",flexShrink:0}}/>
          <span style={{fontSize:11,color:"var(--mut)",fontFamily:"var(--fm)"}}>Zoom</span>
          {["−","+"].map((s,i)=><button key={s} onClick={()=>setCols(c=>i===0?Math.max(1,c-1):Math.min(5,c+1))} style={{width:27,height:27,borderRadius:6,cursor:"pointer",border:"1px solid var(--b2)",background:"transparent",color:"var(--text)",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center"}}>{s}</button>)}
        </>}
        {appTab==="windows"&&<><div style={{width:1,height:20,background:"var(--b2)",flexShrink:0}}/>
          <button onClick={openAllWins} style={{padding:"3px 10px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:"var(--acc)",cursor:"pointer"}}>+ Alle öffnen</button>
          <button onClick={tileWins}    style={{padding:"3px 10px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:"var(--mut)",cursor:"pointer"}}>⊞ Kacheln</button>
          <button onClick={()=>setWins([])} style={{padding:"3px 10px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:"var(--acc2)",cursor:"pointer"}}>✕ Alle</button>
        </>}
        <button onClick={onLogout} style={{marginLeft:"auto",padding:"4px 12px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:"var(--mut)",cursor:"pointer",flexShrink:0}}>← Logout</button>
        {sheetShareUrl&&<button onClick={copySheet} style={{padding:"4px 12px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:`1px solid ${copied?"var(--acc)":"var(--b2)"}`,borderRadius:6,background:"transparent",color:copied?"var(--acc)":"var(--mut)",cursor:"pointer",flexShrink:0,transition:"all .2s"}}>{copied?"✓ Kopiert!":"📊 Sheet"}</button>}
        {/* Sidebar toggle */}
        <button onClick={()=>setSidebarOpen(v=>!v)} title="Op-Log & Notizen" style={{padding:"4px 10px",fontFamily:"var(--fd)",fontSize:12,fontWeight:600,border:`1px solid ${sidebarOpen?"var(--acc)":"var(--b2)"}`,borderRadius:6,background:sidebarOpen?"rgba(0,200,255,.1)":"transparent",color:sidebarOpen?"var(--acc)":"var(--mut)",cursor:"pointer",flexShrink:0,position:"relative"}}>
          📋 Log
          {liveOpCount>0&&<span style={{position:"absolute",top:-4,right:-4,background:"var(--acc2)",color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--fm)"}}>{liveOpCount}</span>}
        </button>
      </header>

      {/* ── STATUS BAR ── */}
      <div style={{display:"flex",gap:16,alignItems:"center",padding:"5px 20px",fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)",borderBottom:"1px solid var(--b)"}}>
        <span><span style={{width:6,height:6,borderRadius:"50%",background:"var(--tw)",display:"inline-block",marginRight:4}}/>{tw} Twitch</span>
        <span><span style={{width:6,height:6,borderRadius:"50%",background:"var(--yt)",display:"inline-block",marginRight:4}}/>{yt} YouTube</span>
        {cu>0&&<span><span style={{width:6,height:6,borderRadius:"50%",background:"#374151",display:"inline-block",marginRight:4}}/>{cu} Custom</span>}
        <span>{players.length} gesamt</span>
        {appTab==="windows"&&<span style={{color:"var(--acc)"}}>{wins.length} Fenster</span>}
        {/* Alive stats */}
        {Object.keys(aliveState).length>0&&<span style={{color:"#f87171"}}>☠ {Object.values(aliveState).filter(v=>v==="dead").length} tot</span>}
        <span style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
          {lastRefresh&&<span>↻ {lastRefresh}</span>}
          <button onClick={loadSheet} disabled={loading} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 10px",fontFamily:"var(--fm)",fontSize:11,border:"1px solid var(--b2)",borderRadius:6,background:"transparent",color:loading?"var(--mut)":"var(--acc)",cursor:loading?"default":"pointer",opacity:loading?.5:1}}>
            <span style={{display:"inline-block",animation:loading?"spin 1s linear infinite":"none"}}>↻</span>
            {loading?"lädt…":"Aktualisieren"}
          </button>
        </span>
      </div>

      {/* ── GRID TAB ── */}
      {appTab==="grid"&&<main style={{padding:"16px 20px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,flexWrap:"wrap"}}>
          <button onClick={addGroup} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,border:"1px dashed var(--b2)",background:"transparent",color:"var(--mut)",fontFamily:"var(--fd)",fontWeight:600,fontSize:13,cursor:"pointer"}}>＋ Gruppe hinzufügen</button>
          {klabsGroups.length>0&&<span style={{fontFamily:"var(--fm)",fontSize:10,color:"var(--mut)"}}>Klabscom-Gruppen aktiv · {localGroups.filter(g=>g.members.length>0).length} Gruppen mit Spielern</span>}
        </div>

        {localGroups.filter(g=>!(g as any).isSpawn).map(g=>{
          const members=(g.members||[]).map(id=>players.find(p=>p.id===id)).filter((p): p is Player=>!!p&&filteredIds.has(p.id));
          const isEmpty=members.length===0;
          // Count dead in group
          const deadCount=members.filter(p=>aliveState[p.id]==="dead").length;
          return (
            <div key={g.id} style={{marginBottom:28}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,paddingBottom:7,borderBottom:"1px solid var(--b2)"}}>
                <ColorPicker current={g.color} onChange={c=>{const next=localGroups.map(gg=>gg.id===g.id?{...gg,color:c}:gg);saveGroups(next,localCols);}}/>
                <input id={"gn_"+g.id} defaultValue={g.label}
                  onBlur={e=>{const next=localGroups.map(gg=>gg.id===g.id?{...gg,label:e.target.value}:gg);saveGroups(next,localCols);}}
                  onKeyDown={e=>{if(e.key==="Enter")(e.target as HTMLInputElement).blur();}}
                  style={{background:"transparent",border:"none",borderBottom:"1px solid transparent",color:"var(--text)",fontFamily:"var(--fd)",fontWeight:700,fontSize:14,letterSpacing:1.5,textTransform:"uppercase",outline:"none",minWidth:60,maxWidth:240}}/>
                <span style={{fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)"}}>{members.length} Stream{members.length!==1?"s":""}</span>
                {deadCount>0&&<span style={{fontFamily:"var(--fm)",fontSize:11,color:"#f87171"}}>☠{deadCount}</span>}
                {/* System badges for this group */}
                {(() => {
                  const systems: string[]=[];
                  Object.entries(tokensBySys).forEach(([sysId,tokens])=>{if((tokens as Token[]).some(t=>t.groupId===g.id))systems.push(sysId);});
                  return systems.length>0?<SystemBadges systems={systems}/>:null;
                })()}
                <button onClick={()=>{const next=localGroups.filter(gg=>gg.id!==g.id);saveGroups(next,localCols);}} style={{marginLeft:"auto",fontFamily:"var(--fm)",fontSize:11,padding:"2px 8px",borderRadius:4,border:"1px solid var(--b)",background:"transparent",color:"var(--mut)",cursor:"pointer"}}>✕</button>
              </div>
              <div style={{display:isEmpty?"flex":"grid",gridTemplateColumns:colClass[cols],gap:12,minHeight:72,borderRadius:10,border:`2px dashed ${dragOver===g.id?"var(--acc)":isEmpty?"var(--b2)":"transparent"}`,background:dragOver===g.id?"rgba(0,200,255,.04)":"transparent",transition:"all .12s",...(isEmpty?{alignItems:"center",justifyContent:"center",fontFamily:"var(--fm)",fontSize:11,color:"var(--mut)"}:{})}}
                onDragOver={e=>{e.preventDefault();setDragOver(g.id);}}
                onDragLeave={()=>setDragOver(null)}
                onDrop={()=>{if(dragId)moveToGroup(dragId,g.id);setDragId(null);setDragOver(null);}}>
                {isEmpty?<span>hierher ziehen</span>:members.map(p=>(
                  <GridCard key={p.id} player={p} groupColor={g.color}
                    systemIds={getPlayerSystems(p.id)}
                    aliveState={aliveState}
                    onDragStart={()=>setDragId(p.id)}
                    onDragEnd={()=>{setDragId(null);setDragOver(null);}}
                    onDoubleClick={()=>setFocus(p)}
                    onOpenWindow={()=>{
                      setAppTab("windows");
                      setWins(prev=>{if(prev.find(w=>w.playerId===p.id))return prev;return[...prev,{id:"w_"+p.id,playerId:p.id,x:80,y:100,w:480,h:320,minimized:false,muted:true,zIndex:maxZ+1}];});
                      setMaxZ(z=>z+1);
                    }}/>
                ))}
              </div>
            </div>
          );
        })}

        {/* Ungrouped */}
        {ungrouped().length>0&&<>
          <div style={{display:"flex",alignItems:"center",gap:8,margin:"24px 0 10px",padding:"14px 0 7px",borderTop:"1px solid var(--b)",borderBottom:"1px solid var(--b2)",fontFamily:"var(--fd)",fontWeight:700,fontSize:13,letterSpacing:1.5,textTransform:"uppercase",color:"var(--mut)"}}>
            <span style={{width:9,height:9,borderRadius:"50%",background:"var(--mut)",display:"inline-block"}}/>
            Unzugeteilt <span style={{fontFamily:"var(--fm)",fontSize:11,fontWeight:400,marginLeft:4}}>{ungrouped().length}</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:colClass[cols],gap:12,minHeight:72,borderRadius:10,border:`2px dashed ${dragOver==="un"?"var(--acc)":"transparent"}`,background:dragOver==="un"?"rgba(0,200,255,.04)":"transparent",transition:"all .12s"}}
            onDragOver={e=>{e.preventDefault();setDragOver("un");}}
            onDragLeave={()=>setDragOver(null)}
            onDrop={()=>{if(dragId)moveToGroup(dragId,null);setDragId(null);setDragOver(null);}}>
            {ungrouped().map(p=>(
              <GridCard key={p.id} player={p} groupColor="var(--mut)"
                systemIds={getPlayerSystems(p.id)}
                aliveState={aliveState}
                onDragStart={()=>setDragId(p.id)}
                onDragEnd={()=>{setDragId(null);setDragOver(null);}}
                onDoubleClick={()=>setFocus(p)}
                onOpenWindow={()=>{
                  setAppTab("windows");
                  setWins(prev=>{if(prev.find(w=>w.playerId===p.id))return prev;return[...prev,{id:"w_"+p.id,playerId:p.id,x:80,y:100,w:480,h:320,minimized:false,muted:true,zIndex:maxZ+1}];});
                  setMaxZ(z=>z+1);
                }}/>
            ))}
          </div>
        </>}

        {!players.length&&<div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"80px 20px",gap:12,fontFamily:"var(--fd)",color:"var(--mut)"}}>
          <span style={{fontSize:46,opacity:.3}}>📡</span><p style={{fontSize:16,fontWeight:600,letterSpacing:1}}>Lade Streams…</p>
        </div>}
      </main>}

      {/* ── WINDOWS TAB ── */}
      {appTab==="windows"&&<div style={{position:"fixed",inset:0,top:82,zIndex:100,pointerEvents:"none"}}>
        {wins.length===0&&<div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:12,fontFamily:"var(--fd)",color:"var(--mut)",pointerEvents:"auto"}}>
          <span style={{fontSize:46,opacity:.3}}>⧉</span>
          <p style={{fontSize:16,fontWeight:600,letterSpacing:1}}>Keine Fenster offen</p>
          <button onClick={openAllWins} style={{padding:"8px 20px",fontFamily:"var(--fd)",fontWeight:700,fontSize:14,background:"var(--acc)",border:"none",borderRadius:8,color:"#000",cursor:"pointer"}}>Alle Streams öffnen</button>
        </div>}
        {wins.map(w=>{
          const p=players.find(pl=>pl.id===w.playerId);
          if (!p) return null;
          const group=localGroups.find(g=>(g.members||[]).includes(p.id));
          const groupColor=group?.color??"var(--mut)";
          const sysSystems: string[]=[];
          Object.entries(tokensBySys).forEach(([sysId,tokens])=>{if(group&&(tokens as Token[]).some(t=>t.groupId===group.id))sysSystems.push(sysId);});
          return <div key={w.id} style={{pointerEvents:"auto"}}>
            <StreamWindow win={w} player={p} groupColor={groupColor} systemIds={sysSystems} aliveState={aliveState} allWins={wins} onUpdate={updateWin} onClose={closeWin} onFocus={focusWin}/>
          </div>;
        })}
      </div>}

      {/* ── SIDEBAR ── */}
      <Sidebar open={sidebarOpen} onClose={()=>setSidebarOpen(false)} opLog={opLog} notesText={notesText} systemNotes={sysNotes} systems={klabsSystems.length>0?klabsSystems:[{id:"pyro",label:"Pyro"},{id:"stanton",label:"Stanton"},{id:"nyx",label:"Nyx"}]}/>

      <FocusOverlay player={focusPlayer} onClose={()=>setFocus(null)}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box}`}</style>
    </div>
  );
}

// ── ROOT PAGE ─────────────────────────────────────────────────
export default function Page() {
  const [session,setSession]=useState<{roomId:string;sheetUrl:string;sheetShareUrl:string}|null>(null);
  const [checking,setChecking]=useState(true);

  useEffect(()=>{
    const saved=localStorage.getItem(LS_SESSION);
    if (!saved){setChecking(false);return;}
    try {
      const p=JSON.parse(saved);
      if (p.mode==="sheet"&&p.sheetUrl){setSession({roomId:p.roomId,sheetUrl:p.sheetUrl,sheetShareUrl:p.sheetShareUrl||""});setChecking(false);return;}
      getDoc(doc(db,"rooms",p.roomId,"config","main")).then(snap=>{
        if (snap.exists()&&snap.data().password===p.pw){setSession({roomId:p.roomId,sheetUrl:snap.data().sheetUrl,sheetShareUrl:p.sheetShareUrl||snap.data().sheetShareUrl||""});}
        else localStorage.removeItem(LS_SESSION);
        setChecking(false);
      }).catch(()=>{localStorage.removeItem(LS_SESSION);setChecking(false);});
    } catch{localStorage.removeItem(LS_SESSION);setChecking(false);}
  },[]);

  if (checking) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",zIndex:1}}><div style={{fontFamily:"var(--fm)",fontSize:13,color:"var(--mut)",animation:"spin 1s linear infinite",display:"inline-block"}}>↻</div></div>;
  if (!session) return <LoginScreen onLogin={(r,s,su)=>setSession({roomId:r,sheetUrl:s,sheetShareUrl:su})}/>;
  return <App roomId={session.roomId} sheetUrl={session.sheetUrl} sheetShareUrl={session.sheetShareUrl} onLogout={()=>{localStorage.removeItem(LS_SESSION);setSession(null);}}/>;
}
