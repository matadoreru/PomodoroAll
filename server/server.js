/**
 * =====================================================
 * POMODORO SYNC — Servidor Backend (Node.js + Socket.io)
 * =====================================================
 * Gestiona salas de estudio, sincronización de temporizadores
 * en tiempo real, chat y presencia de usuarios.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ─── Servir archivos estáticos del cliente ─────────────────────────────────
app.use(express.static(path.join(__dirname, '../client/public')));

// ─── Estado en memoria de las salas ──────────────────────────────────────────
const rooms = {};

function decodeHtmlEntities(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value = '') {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, '')).trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSpotifyOEmbed(itemType, spotifyId) {
  const pageUrl = `https://open.spotify.com/${itemType}/${spotifyId}`;
  const response = await fetchWithTimeout(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(pageUrl)}&format=json`,
    {},
    3500
  );
  if (!response.ok) throw new Error(`Spotify oEmbed ${response.status}`);
  return response.json();
}

function getSpotifyPageUrl(spotifyUrl, itemType, spotifyId) {
  if (typeof spotifyUrl !== 'string' || !spotifyUrl.startsWith('http')) {
    return `https://open.spotify.com/${itemType}/${spotifyId}`;
  }

  try {
    const url = new URL(spotifyUrl);
    url.pathname = `/${itemType}/${spotifyId}`;
    return url.toString();
  } catch {
    return `https://open.spotify.com/${itemType}/${spotifyId}`;
  }
}

function buildTrackItem({ spotifyId, title, artists = [], artworkUrl = '', addedBy, sourceTitle = '' }) {
  return {
    id: uuidv4(),
    type: 'track',
    spotifyId,
    spotifyUri: `spotify:track:${spotifyId}`,
    embedUrl: `https://open.spotify.com/embed/track/${spotifyId}`,
    title: title || 'Canción de Spotify',
    artists,
    artworkUrl,
    sourceTitle,
    addedBy,
  };
}

async function resolveTrackItem(spotifyId, addedBy) {
  let title = 'Canción de Spotify';
  let artists = [];
  let artworkUrl = '';

  try {
    const data = await fetchSpotifyOEmbed('track', spotifyId);
    title = data.title || title;
    artworkUrl = data.thumbnail_url || artworkUrl;

    const parts = title.split(' by ');
    if (parts.length > 1) {
      title = parts.shift().trim() || title;
      artists = parts.join(' by ').split(',').map(a => a.trim()).filter(Boolean);
    }
  } catch {}

  return buildTrackItem({ spotifyId, title, artists, artworkUrl, addedBy });
}

function extractPlaylistTracks(html, addedBy, sourceTitle = '') {
  const trackHrefRe = /href="\/track\/([a-zA-Z0-9]+)"/g;
  const seen = new Set();
  const tracks = [];

  for (const match of html.matchAll(trackHrefRe)) {
    const spotifyId = match[1];
    if (seen.has(spotifyId)) continue;
    seen.add(spotifyId);

    const slice = html.slice(Math.max(0, match.index - 500), Math.min(html.length, match.index + 2000));
    const titleMatch = slice.match(
      new RegExp(`href="\\/track\\/${spotifyId}"[^>]*>[\\s\\S]*?data-encore-id="listRowTitle"[^>]*>[\\s\\S]*?<span[^>]*>([^<]+)<\\/span>`)
    );
    const title = decodeHtmlEntities(
      titleMatch?.[1]
      || slice.match(/aria-label="([^"]+)"/)?.[1]
      || slice.match(/--encore-line-clamp:1">([^<]+)</)?.[1]
      || 'Canción de Spotify'
    );
    const artworkUrl = slice.match(/src="(https:\/\/i\.scdn\.co\/image\/[^"]+)"/)?.[1] || '';
    const artists = [...slice.matchAll(/href="\/artist\/[^"]+">([^<]+)<\/a>/g)]
      .map((artistMatch) => stripTags(artistMatch[1]))
      .filter(Boolean);

    tracks.push(buildTrackItem({ spotifyId, title, artists, artworkUrl, addedBy, sourceTitle }));
  }

  return tracks;
}

async function resolvePlaylistItems(spotifyId, addedBy, spotifyUrl) {
  let sourceTitle = 'Playlist de Spotify';

  try {
    const data = await fetchSpotifyOEmbed('playlist', spotifyId);
    sourceTitle = data.title || sourceTitle;
  } catch {}

  const response = await fetchWithTimeout(getSpotifyPageUrl(spotifyUrl, 'playlist', spotifyId), {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
    }
  }, 12000);
  if (!response.ok) throw new Error(`Spotify playlist ${response.status}`);

  const html = await response.text();
  const tracks = extractPlaylistTracks(html, addedBy, sourceTitle);
  if (!tracks.length) throw new Error('Playlist sin canciones resolubles');
  return tracks;
}

function getPublicRooms() {
  return Object.values(rooms)
    .filter(r => Object.keys(r.users).length > 0 && Object.keys(r.users).length < 8)
    .sort((a, b) => Object.keys(b.users).length - Object.keys(a.users).length)
    .slice(0, 5)
    .map(r => ({
      id: r.id,
      name: r.name,
      userCount: Object.keys(r.users).length,
      phase: r.timer.phase,
      running: r.timer.running,
    }));
}

app.get('/api/rooms', (req, res) => res.json(getPublicRooms()));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

/**
 * Crea una sala con su estado inicial del temporizador Pomodoro.
 */
function createRoom(roomId, name) {
  const settings = { study: 25 * 60, short_break: 5 * 60, long_break: 15 * 60 };
  return {
    id: roomId,
    name: (name || '').trim().substring(0, 30) || '',
    users: {},
    timer: {
      phase: 'study',
      running: false,
      timeLeft: settings.study,
      startedAt: null,
      pomodoroCount: 0,
    },
    settings,
    queue: [],
    playback: { trackIndex: -1, playing: false },
    messages: [],
    createdAt: Date.now()
  };
}

/**
 * Obtiene el tiempo restante actual del temporizador (corrigiendo
 * el tiempo transcurrido desde que se inició).
 */
function getTimerSnapshot(room) {
  const timer = { ...room.timer };
  if (timer.running && timer.startedAt) {
    const elapsed = Math.floor((Date.now() - timer.startedAt) / 1000);
    timer.timeLeft = Math.max(0, timer.timeLeft - elapsed);
    // Si llegó a 0 en el servidor, lo detenemos
    if (timer.timeLeft === 0) {
      timer.running = false;
      timer.startedAt = null;
    }
  }
  return timer;
}

/**
 * Sincroniza el temporizador a todos los usuarios de la sala.
 */
function broadcastTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('timer:sync', getTimerSnapshot(room));
}

/**
 * Avanza a la siguiente fase Pomodoro.
 */
function advancePhase(room) {
  const timer = room.timer;
  const s = room.settings;
  if (timer.phase === 'study') {
    timer.pomodoroCount++;
    if (timer.pomodoroCount % 4 === 0) {
      timer.phase = 'long_break';
      timer.timeLeft = s.long_break;
    } else {
      timer.phase = 'short_break';
      timer.timeLeft = s.short_break;
    }
  } else {
    timer.phase = 'study';
    timer.timeLeft = s.study;
  }
  timer.running = false;
  timer.startedAt = null;
}

// ─── Lógica de temporizadores en el servidor ────────────────────────────────
// Tick cada segundo para las salas activas
setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (!room.timer.running || !room.timer.startedAt) continue;

    const elapsed = Math.floor((Date.now() - room.timer.startedAt) / 1000);
    const remaining = room.timer.timeLeft - elapsed;

    if (remaining <= 0) {
      // Temporizador completado
      room.timer.timeLeft = 0;
      room.timer.running = false;
      room.timer.startedAt = null;
      advancePhase(room);

      io.to(roomId).emit('timer:complete', {
        phase: room.timer.phase,
        timer: getTimerSnapshot(room)
      });
    }
  }
}, 1000);

// ─── Manejo de conexiones Socket.io ─────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Usuario conectado: ${socket.id}`);

  // ── Crear sala ────────────────────────────────────────────────────────────
  socket.on('room:create', ({ username, roomName }, callback) => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms[roomId] = createRoom(roomId, roomName);

    rooms[roomId].users[socket.id] = {
      id: socket.id,
      username: username || 'Estudiante',
      status: 'connected',  // 'connected' | 'studying' | 'break' | 'away'
      joinedAt: Date.now()
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    console.log(`[SALA] Creada: ${roomId} por ${username}`);

    callback({
      roomId,
      name: rooms[roomId].name,
      timer: getTimerSnapshot(rooms[roomId]),
      users: Object.values(rooms[roomId].users),
      settings: rooms[roomId].settings,
      queue: rooms[roomId].queue,
      playback: rooms[roomId].playback,
    });
    io.emit('rooms:update', getPublicRooms());
  });

  // ── Unirse a sala ─────────────────────────────────────────────────────────
  socket.on('room:join', ({ roomId, username }, callback) => {
    const room = rooms[roomId];
    if (!room) {
      callback({ error: 'Sala no encontrada. Verifica el código.' });
      return;
    }

    const userCount = Object.keys(room.users).length;
    if (userCount >= 8) {
      callback({ error: 'La sala está llena (máx. 8 usuarios).' });
      return;
    }

    room.users[socket.id] = {
      id: socket.id,
      username: username || 'Estudiante',
      status: 'connected',
      joinedAt: Date.now()
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    // Notificar a los demás
    socket.to(roomId).emit('user:joined', {
      user: room.users[socket.id],
      users: Object.values(room.users)
    });

    console.log(`[SALA] ${username} se unió a: ${roomId}`);

    callback({
      roomId,
      name: room.name,
      timer: getTimerSnapshot(room),
      users: Object.values(room.users),
      messages: room.messages.slice(-20),
      settings: room.settings,
      queue: room.queue,
      playback: room.playback,
    });
    io.emit('rooms:update', getPublicRooms());
  });

  // ── Control del temporizador ──────────────────────────────────────────────

  socket.on('timer:start', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;

    // Guardar el estado actual antes de iniciar
    if (!room.timer.running) {
      room.timer.running = true;
      room.timer.startedAt = Date.now();

      // Actualizar estado de todos los usuarios
      const phase = room.timer.phase;
      for (const uid in room.users) {
        room.users[uid].status = phase === 'study' ? 'studying' : 'break';
      }

      io.to(roomId).emit('timer:sync', getTimerSnapshot(room));
      io.to(roomId).emit('users:update', Object.values(room.users));
    }
  });

  socket.on('timer:pause', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || !room.timer.running) return;

    // Calcular tiempo restante actual y guardar
    const elapsed = Math.floor((Date.now() - room.timer.startedAt) / 1000);
    room.timer.timeLeft = Math.max(0, room.timer.timeLeft - elapsed);
    room.timer.running = false;
    room.timer.startedAt = null;

    for (const uid in room.users) {
      room.users[uid].status = 'connected';
    }

    io.to(roomId).emit('timer:sync', getTimerSnapshot(room));
    io.to(roomId).emit('users:update', Object.values(room.users));
    io.to(roomId).emit('timer:paused_by', {
      username: socket.data.username
    });
  });

  socket.on('timer:reset', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;

    room.timer.phase = 'study';
    room.timer.running = false;
    room.timer.timeLeft = room.settings.study;
    room.timer.startedAt = null;
    room.timer.pomodoroCount = 0;

    for (const uid in room.users) {
      room.users[uid].status = 'connected';
    }

    io.to(roomId).emit('timer:sync', getTimerSnapshot(room));
    io.to(roomId).emit('users:update', Object.values(room.users));
  });

  socket.on('timer:skip', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;

    advancePhase(room);
    io.to(roomId).emit('timer:sync', getTimerSnapshot(room));
    io.to(roomId).emit('timer:skipped_by', {
      username: socket.data.username
    });
  });

  // ── Configuración de duraciones ───────────────────────────────────────────
  socket.on('settings:update', ({ study, short_break, long_break }) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;

    const clamp = (mins) => Math.max(1, Math.min(99, Math.round(mins))) * 60;
    room.settings.study       = clamp(study);
    room.settings.short_break = clamp(short_break);
    room.settings.long_break  = clamp(long_break);

    // Si el temporizador está pausado, ajusta el tiempo restante de la fase actual
    if (!room.timer.running) {
      room.timer.timeLeft = room.settings[room.timer.phase];
    }

    io.to(roomId).emit('settings:sync', room.settings);
    broadcastTimer(roomId);
    console.log(`[CFG] Sala ${roomId}: estudio=${study}m descanso=${short_break}m largo=${long_break}m`);
  });

  // ── Cola de música ────────────────────────────────────────────────────────
  socket.on('queue:add', async ({ spotifyUrl }, ack = () => {}) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return ack({ error: 'Sala no encontrada' });

    const trackRe    = /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)([a-zA-Z0-9]+)/;
    const playlistRe = /(?:spotify:playlist:|open\.spotify\.com\/(?:embed\/)?playlist\/)([a-zA-Z0-9]+)/;
    const tM = spotifyUrl.match(trackRe);
    const pM = spotifyUrl.match(playlistRe);
    if (!tM && !pM) return ack({ error: 'URL de Spotify no válida' });

    try {
      const spotifyId = (tM || pM)[1];
      const items = tM
        ? [await resolveTrackItem(spotifyId, socket.data.username)]
        : await resolvePlaylistItems(spotifyId, socket.data.username, spotifyUrl);

      const wasEmpty = room.queue.length === 0;
      room.queue.push(...items);
      if (wasEmpty && room.queue.length) room.playback.trackIndex = 0;

      io.to(roomId).emit('queue:update', { queue: room.queue, playback: room.playback });
      ack({ ok: true, added: items.length, type: tM ? 'track' : 'playlist' });
    } catch (error) {
      console.error('[QUEUE] Error añadiendo contenido de Spotify:', error.message);
      ack({ error: 'No se pudo leer esa canción o playlist de Spotify' });
    }
  });

  socket.on('queue:remove', ({ id }) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;
    const idx = room.queue.findIndex(i => i.id === id);
    if (idx === -1) return;
    room.queue.splice(idx, 1);
    if (!room.queue.length) {
      room.playback = { trackIndex: -1, playing: false };
    } else if (room.playback.trackIndex >= room.queue.length) {
      room.playback.trackIndex = room.queue.length - 1;
      room.playback.playing = false;
    } else if (idx < room.playback.trackIndex) {
      room.playback.trackIndex--;
    }
    io.to(roomId).emit('queue:update', { queue: room.queue, playback: room.playback });
  });

  socket.on('queue:clear', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;
    room.queue = [];
    room.playback = { trackIndex: -1, playing: false };
    io.to(roomId).emit('queue:update', { queue: room.queue, playback: room.playback });
  });

  socket.on('queue:play', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || room.playback.trackIndex === -1) return;
    room.playback.playing = true;
    io.to(roomId).emit('queue:playback', { playback: room.playback, username: socket.data.username });
  });

  socket.on('queue:pause', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;
    room.playback.playing = false;
    io.to(roomId).emit('queue:playback', { playback: room.playback, username: socket.data.username });
  });

  socket.on('queue:skip', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || !room.queue.length) return;
    if (room.playback.trackIndex < room.queue.length - 1) room.playback.trackIndex++;
    io.to(roomId).emit('queue:playback', { playback: room.playback, username: socket.data.username });
  });

  socket.on('queue:prev', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || !room.queue.length) return;
    if (room.playback.trackIndex > 0) room.playback.trackIndex--;
    io.to(roomId).emit('queue:playback', { playback: room.playback, username: socket.data.username });
  });

  socket.on('queue:jump', ({ index }) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || index < 0 || index >= room.queue.length) return;
    room.playback.trackIndex = index;
    io.to(roomId).emit('queue:playback', { playback: room.playback, username: socket.data.username });
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat:message', ({ text }) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || !text?.trim()) return;

    const msg = {
      id: uuidv4(),
      userId: socket.id,
      username: socket.data.username,
      text: text.trim().substring(0, 300), // límite de 300 chars
      timestamp: Date.now()
    };

    room.messages.push(msg);
    if (room.messages.length > 50) room.messages.shift(); // máx 50

    io.to(roomId).emit('chat:message', msg);
  });

  // ── Reacciones / Emojis de ánimo ──────────────────────────────────────────
  socket.on('reaction:send', ({ emoji }) => {
    const { roomId } = socket.data;
    const ALLOWED = ['🔥', '💪', '🎯', '⭐', '☕', '🧠', '🎉', '💡'];
    if (!roomId || !ALLOWED.includes(emoji)) return;

    io.to(roomId).emit('reaction:received', {
      from: socket.data.username,
      emoji,
      id: uuidv4()
    });
  });

  // ── Estado ausente ────────────────────────────────────────────────────────
  socket.on('user:away', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || !room.users[socket.id]) return;
    room.users[socket.id].status = 'away';
    io.to(roomId).emit('users:update', Object.values(room.users));
  });

  socket.on('user:back', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room || !room.users[socket.id]) return;
    room.users[socket.id].status = 'connected';
    io.to(roomId).emit('users:update', Object.values(room.users));
  });

  // ── Desconexión ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;

    const user = room.users[socket.id];
    delete room.users[socket.id];

    socket.to(roomId).emit('user:left', {
      userId: socket.id,
      username: user?.username,
      users: Object.values(room.users)
    });

    io.emit('rooms:update', getPublicRooms());

    if (Object.keys(room.users).length === 0) {
      setTimeout(() => {
        if (rooms[roomId] && Object.keys(rooms[roomId].users).length === 0) {
          delete rooms[roomId];
          console.log(`[SALA] Eliminada por inactividad: ${roomId}`);
          io.emit('rooms:update', getPublicRooms());
        }
      }, 5 * 60 * 1000);
    }

    console.log(`[-] Usuario desconectado: ${user?.username} de sala ${roomId}`);
  });
});

// ─── Iniciar servidor ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\nPomodoro Sync Server corriendo en http://localhost:${PORT}\n`);
});
