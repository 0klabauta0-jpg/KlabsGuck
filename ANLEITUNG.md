# Klabsguck — Setup-Anleitung für Dummis 🚀

## Was du brauchst
- Einen Computer mit Internet
- Ein GitHub-Konto (kostenlos): github.com
- Ein Vercel-Konto (kostenlos): vercel.com

---

## Schritt 1 — Node.js installieren (einmalig)

1. Gehe zu **nodejs.org**
2. Klicke auf den großen grünen Button "LTS"
3. Installer herunterladen und ausführen
4. Alles mit "Next" durchklicken

**Prüfen ob es geklappt hat:**
- Windows: Win+R → `cmd` → Enter
- Eingeben: `node --version`
- Es sollte sowas erscheinen: `v20.x.x` ✓

---

## Schritt 2 — Projekt auf deinen PC holen

1. Den ZIP-Ordner `klabsguck` entpacken
2. Ordner öffnen — du siehst Dateien wie `package.json`, `app/`, etc.

**Terminal im Ordner öffnen:**
- Windows: Im Explorer in den Ordner navigieren → oben in der Adressleiste `cmd` eintippen → Enter
- Mac: Ordner in Finder öffnen → Rechtsklick → "Terminal hier öffnen"

**Abhängigkeiten installieren:**
```
npm install
```
*(Das dauert 1–2 Minuten, viele Zeilen scrollen — normal)*

**Lokal testen:**
```
npm run dev
```
Browser öffnen: **http://localhost:3000**
Du solltest den Klabsguck Login-Screen sehen ✓

Mit `Strg+C` stoppen.

---

## Schritt 3 — GitHub Repository erstellen

1. Gehe zu **github.com** und logge dich ein
2. Klicke oben rechts auf **"+"** → **"New repository"**
3. Name: `klabsguck`
4. Auf **"Create repository"** klicken

**Projekt auf GitHub hochladen:**

Im Terminal (im klabsguck Ordner):
```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/DEIN-USERNAME/klabsguck.git
git push -u origin main
```
*(DEIN-USERNAME ersetzen — steht oben auf der GitHub-Seite)*

---

## Schritt 4 — Auf Vercel deployen

1. Gehe zu **vercel.com** und klicke **"Sign up"**
2. Wähle **"Continue with GitHub"** — mit deinem GitHub-Konto einloggen
3. Klicke **"Add New Project"**
4. Wähle das `klabsguck` Repository aus der Liste
5. Klicke **"Import"**

**Environment Variables eintragen** (wichtig! Ohne diese läuft nichts):

Auf der Deploy-Seite runterscrollen zu **"Environment Variables"** und diese 6 Einträge hinzufügen:

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `AIzaSyCgYuXT1o1wMa_SZfi8l75KWuEHrh2uCfQ` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `tactical-suite-2a5db.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `tactical-suite-2a5db` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `tactical-suite-2a5db.firebasestorage.app` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `55319924299` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `1:55319924299:web:9411134f26eecdcbacc7ce` |

6. Klicke **"Deploy"**
7. Warten (~2 Minuten) bis der grüne Haken erscheint
8. Klicke auf die generierte URL z.B. `klabsguck.vercel.app`

**Fertig! 🎉**

---

## Schritt 5 — Google Sheet vorbereiten

Füge in deinem klabscom-Sheet diese Spalten hinzu:
- **Spalte J** (Header Zeile 10): `TwitchHandle`
- **Spalte K** (Header Zeile 10): `StreamUrl`

**StreamUrl Beispiele:**
- Twitch: Leer lassen, TwitchHandle reicht
- YouTube: `https://www.youtube.com/watch?v=VIDEOID` (die aktuelle Livestream-URL)
- Beliebiger Stream: Jede direkte Embed-URL

---

## Schritt 6 — Klabsguck benutzen

1. Klabsguck-URL öffnen (die von Vercel)
2. Raum-ID eingeben (selbe wie bei klabscom)
3. Team-Passwort eingeben (selbe wie bei klabscom)
4. Fertig — alle Spieler mit Stream-Links erscheinen automatisch

**Gruppen verwalten:**
- Auf "＋ Gruppe hinzufügen" klicken
- Spieler-Karten per Drag & Drop in Gruppen ziehen
- Gruppen werden für alle Geräte synchronisiert
- Doppelklick auf eine Karte → Stream im Vollbild

---

## Updates deployen (wenn du Änderungen machst)

Dateien ändern, dann im Terminal:
```
git add .
git commit -m "Update"
git push
```
Vercel deployed automatisch innerhalb von ~1 Minute ✓

---

## Häufige Probleme

**"npm: command not found"** → Node.js nochmal installieren (Schritt 1)

**Login schlägt fehl** → Raum-ID und Passwort prüfen — selbe wie klabscom

**Streams laden nicht** → Spalten J und K im Sheet prüfen, Header in Zeile 10

**Twitch-Embed zeigt Fehler** → Vercel-Domain muss als "allowed parent" bei Twitch eingetragen werden:
  - dev.twitch.tv → deine App → Allowed Domains → `klabsguck.vercel.app` eintragen
