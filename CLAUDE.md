# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run build:css    # compile Tailwind → client/public/styles.css (required before first run)
npm start            # run server (http://localhost:3001)
npm run dev          # nodemon + Tailwind watch in parallel (via concurrently)
```

Docker (local):
```bash
docker compose up --build   # build image and run
docker compose up           # run (image already built)
```

Railway: el fichero `railway.json` configura el builder (Dockerfile) y el health check en `/`. Railway inyecta `PORT` en runtime — el servidor ya lo lee con `process.env.PORT || 3001`.

No tests, no linter configured. `client/public/styles.css` is generated — not committed.

## Architecture

```
client/
  src/styles.css        ← Tailwind source (edit this)
  public/
    index.html          ← HTML with Tailwind utility classes
    app.js              ← All frontend JS
    styles.css          ← Compiled output (generated, gitignored)
server/server.js        ← Node.js + Express + Socket.io backend
tailwind.config.js      ← Keyframes, font families
postcss.config.js       ← tailwindcss + autoprefixer
```

**CSS architecture**: CSS variables for all theme colors (defined in `@layer base` inside `styles.css`). The accent color changes dynamically at runtime via `document.documentElement.style.setProperty('--study-hue', hue)` — so colors reference CSS variables (`var(--accent)`) rather than static Tailwind values. Component classes for JS-toggled states (`.active`, `.collapsed`, `.open`) and pseudo-elements are in `@layer components`. Layout and spacing use Tailwind utilities directly in the HTML.

**`server/server.js`** — Node.js + Express + Socket.io. All room state lives in the in-memory `rooms` object (no database). Rooms auto-delete 5 minutes after the last user disconnects.

Timer sync strategy: the server stores `startedAt` (a timestamp) and `timeLeft` (seconds at the moment the timer was last started/paused). `getTimerSnapshot()` computes current remaining time on demand via `timeLeft - elapsed` rather than ticking a counter — this means the server's `setInterval` only needs to detect when `remaining <= 0` to fire `timer:complete` and advance the phase.

**`client/public/index.html`** — Single HTML file with all CSS and JS inlined. No framework, no bundler. Socket.io is loaded from CDN. The client receives timer state via `timer:sync` events and renders it locally; it does not run its own authoritative countdown — it only updates the display on each received sync.

## Socket.io event protocol

| Client → Server | Server → Client |
|---|---|
| `room:create` | `timer:sync` |
| `room:join` | `timer:complete` |
| `timer:start` | `timer:paused_by` |
| `timer:pause` | `timer:skipped_by` |
| `timer:reset` | `user:joined` |
| `timer:skip` | `user:left` |
| `chat:message` | `users:update` |
| `reaction:send` | `chat:message` |
| `user:away` / `user:back` | `reaction:received` |

## Key constants to change

Timer durations must be kept in sync between both files:
- **Server**: `createRoom()` (`timeLeft: 25 * 60`) and `advancePhase()` in `server/server.js`
- **Client**: `PHASE_DURATIONS` object in `client/public/index.html`

Spotify playlists: `SPOTIFY_PLAYLISTS` object in `client/public/index.html` — values are Spotify playlist IDs (from `open.spotify.com/playlist/<ID>`).

Allowed reaction emojis are validated server-side in the `ALLOWED` array inside the `reaction:send` handler.

## Deployment

Set `PORT` environment variable (defaults to 3001). The Express server serves `client/public/` as static files, so no separate static hosting is needed.
