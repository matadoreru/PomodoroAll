'use strict';

// ─── Configuración ────────────────────────────────────────────────────────────
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3001'
  : window.location.origin;
const SPOTIFY_CLIENT_ID = '7251d597a79148928e3185f6c1cb54ce';
const SPOTIFY_REDIRECT_URI = window.location.hostname === 'localhost'
  ? `${window.location.origin}/`
  : 'https://pomodorosync.up.railway.app/';
const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-modify-playback-state',
  'user-read-playback-state'
].join(' ');
const SPOTIFY_AUTH_STORAGE_KEY = 'pomodorosync_spotify_auth';
const SPOTIFY_PKCE_STORAGE_KEY = 'pomodorosync_spotify_pkce';

const QUEUE_PRESETS = {
  lofi:      { id: '37i9dQZF1DWWQbjWnn4C31', label: 'Lo-Fi Beats',           emoji: '🌧' },
  synthwave: { id: '37i9dQZF1DX9RwfGbeGQwP', label: 'Synthwave Focus',        emoji: '🌆' },
  classical: { id: '37i9dQZF1DWWEJlAGA9gs0', label: 'Clásica para estudiar',  emoji: '🎻' },
  jazz:      { id: '37i9dQZF1DXbITWG1ZJKYt', label: 'Jazz Vibes',             emoji: '☕' },
};

// ─── Estado de la aplicación ─────────────────────────────────────────────────
let socket = null;
let mySocketId = null;
let myUsername = '';
let currentRoomId = null;
let isTimerRunning = false;
let localTimeLeft = 0;
let currentPhase = 'study';
let pomodoroCount = 0;
let totalStudySeconds = 0;
let localTickInterval = null;
let chatOpen = true;
let lobbyRefreshInterval = null;
let currentQueue = [];
let currentPlayback = { trackIndex: -1, playing: false, positionMs: 0, startedAt: null };
let renderedTrackKey = '';
let spotifySdkReady = false;
let spotifyPlayer = null;
let spotifyDeviceId = '';
let spotifyPlayerState = null;
let spotifyAccessToken = '';
let spotifyRefreshToken = '';
let spotifyTokenExpiresAt = 0;
let spotifyAuthInFlight = false;
let spotifyPlayerInitializing = false;
let spotifyMuted = false;
let spotifyVolume = 0.7;
let spotifyPreviousVolume = 0.7;
let lastSyncedTrackId = '';
let lastSyncedPlaybackBucket = -1;
let dragQueueIndex = -1;
let lastTrackEndReportedId = '';
let queueAdvanceTimeout = null;

let PHASE_DURATIONS = {
  study:        25 * 60,
  short_break:   5 * 60,
  long_break:   15 * 60,
};

const PHASE_LABELS = {
  study:        'ENFÓCATE',
  short_break:  'DESCANSA',
  long_break:   'RELÁJATE',
};

const PHASE_HUES = {
  study:        340,
  short_break:  195,
  long_break:   145,
};

// ─── Inicialización ──────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get('room');
  if (roomCode) {
    document.getElementById('input-roomcode').value = roomCode.toUpperCase();
    document.getElementById('input-username').focus();
  }

  document.addEventListener('visibilitychange', () => {
    if (!socket) return;
    if (document.hidden) socket.emit('user:away');
    else socket.emit('user:back');
  });

  restoreSpotifyAuthState();
  handleSpotifyAuthRedirect();
  startLobbyRefresh();
  initResizeHandle();
  initSpotifyIframeApi();
  updateSpotifyAuthUI();
  updateSpotifyVolumeUI();
});

// ─── Conexión Socket ─────────────────────────────────────────────────────────
function connectSocket() {
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
  mySocketId = null;

  socket.on('connect', () => {
    mySocketId = socket.id;
    console.log('[Socket] Conectado:', mySocketId);
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Desconectado');
    showToast('⚠ Conexión perdida. Intentando reconectar...');
  });

  socket.on('reconnect', () => showToast('✓ Reconectado'));

  socket.on('timer:sync', (timer) => applyTimerState(timer));

  socket.on('timer:complete', ({ phase, timer }) => {
    showToast(phase === 'study'
      ? '🎉 ¡Pomodoro completado! Tiempo de descansar.'
      : '💪 ¡Descanso terminado! A estudiar.');
    playNotificationSound();
    applyTimerState(timer);
    updatePhaseUI(timer.phase);
  });

  socket.on('timer:paused_by', ({ username }) => {
    if (username !== myUsername) showToast(`⏸ ${username} pausó el temporizador`);
  });

  socket.on('timer:skipped_by', ({ username }) => {
    if (username !== myUsername) showToast(`⏭ ${username} saltó la fase`);
  });

  socket.on('user:joined', ({ user, users }) => {
    renderUsers(users);
    showToast(`👋 ${user.username} se unió a la sala`);
  });

  socket.on('user:left', ({ username, users }) => {
    renderUsers(users);
    showToast(`${username} abandonó la sala`);
  });

  socket.on('users:update', (users) => renderUsers(users));
  socket.on('chat:message', (msg) => appendChatMessage(msg));
  socket.on('reaction:received', ({ from, emoji }) => showFloatingReaction(emoji, from));

  socket.on('settings:sync', (s) => {
    PHASE_DURATIONS.study       = s.study;
    PHASE_DURATIONS.short_break = s.short_break;
    PHASE_DURATIONS.long_break  = s.long_break;
    syncSettingsInputs();
  });

  socket.on('queue:update', ({ queue, playback }) => {
    currentQueue   = queue;
    currentPlayback = playback;
    lastTrackEndReportedId = '';
    renderQueueList();
    renderNowPlaying();
    updatePlaybackButtons();
    scheduleQueueAutoAdvance();
    ensureSpotifyController();
    syncSpotifyController();
  });

  socket.on('queue:playback', ({ playback, username }) => {
    const prevIdx = currentPlayback.trackIndex;
    currentPlayback = playback;
    lastTrackEndReportedId = '';
    if (playback.trackIndex !== prevIdx) {
      renderQueueList();
      renderNowPlaying();
      if (username !== myUsername)
        showToast(`${escapeHtml(username)} cambió la canción`);
    } else {
      updatePlaybackButtons();
      renderQueueList();
      renderNowPlaying();
      if (username !== myUsername)
        showToast(playback.playing
          ? `${escapeHtml(username)} reanudó la música`
          : `${escapeHtml(username)} pausó la música`);
    }
    scheduleQueueAutoAdvance();
    ensureSpotifyController();
    syncSpotifyController();
  });
}

// ─── Crear sala ──────────────────────────────────────────────────────────────
function handleCreate() {
  const username = document.getElementById('input-username').value.trim();
  const roomName = document.getElementById('input-roomname').value.trim();
  if (!username) { showLobbyError('Por favor escribe tu nombre.'); return; }

  myUsername = username;
  if (!socket) connectSocket();

  socket.once('connect', () => {
    socket.emit('room:create', { username, roomName }, (res) => {
      if (res.error) { showLobbyError(res.error); return; }
      enterApp(res);
    });
  });

  if (socket.connected) {
    socket.emit('room:create', { username, roomName }, (res) => {
      if (res.error) { showLobbyError(res.error); return; }
      enterApp(res);
    });
  }
}

// ─── Unirse a sala ───────────────────────────────────────────────────────────
function handleJoin() {
  const username = document.getElementById('input-username').value.trim();
  const roomId   = document.getElementById('input-roomcode').value.trim().toUpperCase();

  if (!username) { showLobbyError('Por favor escribe tu nombre.'); return; }
  if (!roomId)   { showLobbyError('Por favor ingresa un código de sala.'); return; }

  myUsername = username;
  if (!socket) connectSocket();

  const doJoin = () => {
    socket.emit('room:join', { roomId, username }, (res) => {
      if (res.error) { showLobbyError(res.error); return; }
      enterApp(res, res.messages);
    });
  };

  if (socket.connected) doJoin();
  else socket.once('connect', doJoin);
}

// ─── Entrar a la app ─────────────────────────────────────────────────────────
function enterApp({ roomId, name, timer, users, settings, queue, playback }, messages = []) {
  stopLobbyRefresh();
  if (settings) {
    PHASE_DURATIONS.study       = settings.study;
    PHASE_DURATIONS.short_break = settings.short_break;
    PHASE_DURATIONS.long_break  = settings.long_break;
  }
  currentQueue    = queue    || [];
  currentPlayback = playback || { trackIndex: -1, playing: false, positionMs: 0, startedAt: null };
  renderedTrackKey = '';
  renderQueueList();
  renderNowPlaying();
  updatePlaybackButtons();
  ensureSpotifyController();
  syncSpotifyController();
  currentRoomId = roomId;

  document.getElementById('header-room-name').textContent = name || roomId;
  document.getElementById('modal-room-code').textContent = roomId;
  document.getElementById('share-url-input').value = `${window.location.origin}?room=${roomId}`;

  document.getElementById('screen-lobby').style.display = 'none';
  document.getElementById('screen-app').classList.add('active');

  history.pushState({}, '', `?room=${roomId}`);

  renderUsers(users);
  applyTimerState(timer);
  updatePhaseUI(timer.phase);

  messages.forEach(msg => appendChatMessage(msg, false));

  showToast(`✓ Sala ${roomId} — ¡Listo para estudiar!`);
}

// ─── Salir ───────────────────────────────────────────────────────────────────
function handleLeave() {
  if (socket) { socket.disconnect(); socket = null; }
  clearInterval(localTickInterval);
  clearTimeout(queueAdvanceTimeout);
  if (spotifyPlayer) spotifyPlayer.pause().catch?.(() => {});
  document.getElementById('screen-app').classList.remove('active');
  document.getElementById('screen-lobby').style.display = 'flex';
  history.pushState({}, '', '/');
  startLobbyRefresh();
}

// ─── Estado del temporizador ─────────────────────────────────────────────────
function applyTimerState(timer) {
  clearInterval(localTickInterval);

  localTimeLeft  = timer.timeLeft;
  isTimerRunning = timer.running;
  currentPhase   = timer.phase;
  pomodoroCount  = timer.pomodoroCount;

  updateTimerDisplay(localTimeLeft);
  updateProgressRing(localTimeLeft, PHASE_DURATIONS[currentPhase]);
  updatePlayPauseBtn(isTimerRunning);
  updatePhaseUI(currentPhase);

  document.getElementById('stat-pomodoros').textContent = pomodoroCount;

  if (isTimerRunning) {
    localTickInterval = setInterval(() => {
      localTimeLeft = Math.max(0, localTimeLeft - 1);
      updateTimerDisplay(localTimeLeft);
      updateProgressRing(localTimeLeft, PHASE_DURATIONS[currentPhase]);

      if (currentPhase === 'study') {
        totalStudySeconds++;
        document.getElementById('stat-time').textContent =
          Math.floor(totalStudySeconds / 60) + 'm';
      }

      if (localTimeLeft === 0) clearInterval(localTickInterval);
    }, 1000);
  }
}

// ─── Controles del temporizador ──────────────────────────────────────────────
function toggleTimer() {
  if (!socket || !currentRoomId) return;
  socket.emit(isTimerRunning ? 'timer:pause' : 'timer:start');
}

function resetTimer() {
  if (!socket || !currentRoomId) return;
  socket.emit('timer:reset');
}

function skipPhase() {
  if (!socket || !currentRoomId) return;
  socket.emit('timer:skip');
}

function switchPhase(phase) {
  if (isTimerRunning) {
    showToast('⚠ Pausa el temporizador antes de cambiar de fase');
    return;
  }
  showToast('Usa los controles para navegar entre fases');
}

// ─── UI del temporizador ─────────────────────────────────────────────────────
function updateTimerDisplay(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  document.getElementById('timer-display').textContent = `${m}:${s}`;
}

function updateProgressRing(timeLeft, total) {
  const ring = document.getElementById('timer-progress-ring');
  const circumference = 2 * Math.PI * 108;
  const progress = total > 0 ? timeLeft / total : 0;
  ring.style.strokeDasharray  = circumference;
  ring.style.strokeDashoffset = circumference * (1 - progress);
}

function updatePlayPauseBtn(running) {
  document.getElementById('btn-play-pause').innerHTML =
    `<span class="material-symbols-rounded">${running ? 'pause' : 'play_arrow'}</span>`;
}

function updatePhaseUI(phase) {
  ['study', 'short_break', 'long_break'].forEach(p => {
    document.getElementById(`tab-${p}`)?.classList.toggle('active', p === phase);
  });

  document.getElementById('timer-phase-label').textContent = PHASE_LABELS[phase] || 'ENFÓCATE';

  document.documentElement.style.setProperty('--study-hue', PHASE_HUES[phase] || 340);
  document.title = `${PHASE_LABELS[phase]} — PomodoroSync`;
}

// ─── Usuarios ────────────────────────────────────────────────────────────────
const USER_COLORS = ['#F48FB1','#80DEEA','#A5D6A7','#FFD54F','#CE93D8','#80CBC4','#FFAB91','#90CAF9'];

function renderUsers(users) {
  const container = document.getElementById('users-list');
  container.innerHTML = '';

  users.forEach((user, i) => {
    const color = USER_COLORS[i % USER_COLORS.length];
    const isMe  = user.id === mySocketId;

    const item = document.createElement('div');
    item.className = 'user-item';
    item.innerHTML = `
      <div class="user-avatar" style="background:${color}22; color:${color}">
        ${user.username.charAt(0).toUpperCase()}
      </div>
      <div class="user-info">
        <div class="user-name${isMe ? ' me' : ''}">${escapeHtml(user.username)}</div>
        <div class="user-status-text">${statusLabel(user.status)}</div>
      </div>
      <div class="status-dot status-${user.status}"></div>
    `;
    container.appendChild(item);
  });
}

function statusLabel(status) {
  return { connected: 'Conectado', studying: 'Estudiando', break: 'Descansando', away: 'Ausente' }[status] || status;
}

// ─── Chat ────────────────────────────────────────────────────────────────────
function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat:message', { text });
  input.value = '';
  input.style.height = 'auto';
}

function appendChatMessage(msg, scroll = true) {
  const container = document.getElementById('chat-messages');

  if (container.children.length === 1 && container.children[0].style.textAlign === 'center') {
    container.innerHTML = '';
  }

  const isMe = msg.userId === mySocketId;
  const time = new Date(msg.timestamp).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

  const div = document.createElement('div');
  div.className = `chat-msg${isMe ? ' mine' : ''}`;
  div.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-name" style="color:hsl(${hashCode(msg.username) % 360},55%,65%)">${escapeHtml(msg.username)}</span>
      <span class="chat-msg-time">${time}</span>
    </div>
    <div class="chat-msg-text">${escapeHtml(msg.text)}</div>
  `;
  container.appendChild(div);
  if (scroll) container.scrollTop = container.scrollHeight;
}

// ─── Reacciones ──────────────────────────────────────────────────────────────
function sendReaction(emoji) {
  if (!socket) return;
  socket.emit('reaction:send', { emoji });
}

function showFloatingReaction(emoji, from) {
  const container = document.getElementById('reaction-container');
  const el = document.createElement('div');
  el.className = 'reaction-float';
  el.style.right = `${Math.random() * 60}px`;
  el.innerHTML = `${emoji}<div class="reaction-label">${escapeHtml(from)}</div>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

<<<<<<< HEAD
=======
<<<<<<< Updated upstream
=======
>>>>>>> 5b3698b (Fix)
async function sha256(value) {
  const data = new TextEncoder().encode(value);
  return crypto.subtle.digest('SHA-256', data);
}

function toBase64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomString(length = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const random = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(random, (value) => chars[value % chars.length]).join('');
}

function restoreSpotifyAuthState() {
  try {
    const raw = localStorage.getItem(SPOTIFY_AUTH_STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    spotifyAccessToken = state.accessToken || '';
    spotifyRefreshToken = state.refreshToken || '';
    spotifyTokenExpiresAt = Number(state.expiresAt) || 0;
  } catch {}
}

function persistSpotifyAuthState() {
  localStorage.setItem(SPOTIFY_AUTH_STORAGE_KEY, JSON.stringify({
    accessToken: spotifyAccessToken,
    refreshToken: spotifyRefreshToken,
    expiresAt: spotifyTokenExpiresAt,
  }));
}

<<<<<<< HEAD
=======
async function parseJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(fallbackMessage || 'Respuesta inesperada de Spotify');
  }
}

>>>>>>> 5b3698b (Fix)
function clearSpotifyAuthState() {
  spotifyAccessToken = '';
  spotifyRefreshToken = '';
  spotifyTokenExpiresAt = 0;
  localStorage.removeItem(SPOTIFY_AUTH_STORAGE_KEY);
  sessionStorage.removeItem(SPOTIFY_PKCE_STORAGE_KEY);
}

async function startSpotifyLogin() {
  const verifier = randomString(64);
  const challenge = toBase64Url(await sha256(verifier));
  sessionStorage.setItem(SPOTIFY_PKCE_STORAGE_KEY, verifier);

  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', SPOTIFY_REDIRECT_URI);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('scope', SPOTIFY_SCOPES);
  window.location.href = url.toString();
}

async function exchangeSpotifyCode(code) {
  const verifier = sessionStorage.getItem(SPOTIFY_PKCE_STORAGE_KEY);
  if (!verifier) throw new Error('No se encontró el verificador PKCE');

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    code_verifier: verifier,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) throw new Error('No se pudo completar el login de Spotify');
<<<<<<< HEAD
  const data = await response.json();
=======
  const data = await parseJsonResponse(response, 'Respuesta inválida al iniciar sesión con Spotify');
>>>>>>> 5b3698b (Fix)
  spotifyAccessToken = data.access_token || '';
  spotifyRefreshToken = data.refresh_token || spotifyRefreshToken;
  spotifyTokenExpiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
  persistSpotifyAuthState();
  sessionStorage.removeItem(SPOTIFY_PKCE_STORAGE_KEY);
}

async function refreshSpotifyToken() {
  if (!spotifyRefreshToken) throw new Error('No hay refresh token de Spotify');

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: spotifyRefreshToken,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    clearSpotifyAuthState();
    throw new Error('No se pudo renovar la sesión de Spotify');
  }

<<<<<<< HEAD
  const data = await response.json();
=======
  const data = await parseJsonResponse(response, 'Respuesta inválida al renovar Spotify');
>>>>>>> 5b3698b (Fix)
  spotifyAccessToken = data.access_token || '';
  spotifyRefreshToken = data.refresh_token || spotifyRefreshToken;
  spotifyTokenExpiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
  persistSpotifyAuthState();
}

async function getValidSpotifyAccessToken() {
  if (!spotifyAccessToken) throw new Error('Debes conectar Spotify');
  if (Date.now() < spotifyTokenExpiresAt - 60000) return spotifyAccessToken;
  await refreshSpotifyToken();
  return spotifyAccessToken;
}

async function spotifyApi(path, options = {}, allowRetry = true) {
  const token = await getValidSpotifyAccessToken();
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && allowRetry) {
    await refreshSpotifyToken();
    return spotifyApi(path, options, false);
  }

  if (!response.ok) {
    const text = await response.text();
    let message = `Spotify API ${response.status}`;
    try {
      const data = JSON.parse(text);
      message = data?.error?.message || data?.error_description || message;
      if (response.status === 403) {
        message = 'Spotify no permite leer esa playlist con tu cuenta';
      }
    } catch {
      if (response.status === 403) {
        message = 'Spotify no permite leer esa playlist con tu cuenta';
      } else if (text) {
        message = text;
      }
    }
    throw new Error(message);
  }

  if (response.status === 204) return null;
<<<<<<< HEAD
  return response.json();
=======
  return parseJsonResponse(response, 'Respuesta inválida de Spotify');
>>>>>>> 5b3698b (Fix)
}

async function handleSpotifyAuthRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return;

  url.searchParams.delete('code');
  url.searchParams.delete('error');
  history.replaceState({}, '', url.pathname + (url.search ? url.search : ''));

  if (error) {
    showToast('⚠ Spotify canceló la autorización');
    return;
  }

  try {
    await exchangeSpotifyCode(code);
    showToast('✓ Spotify conectado');
    updateSpotifyAuthUI();
    ensureSpotifyController();
  } catch (authError) {
    clearSpotifyAuthState();
    showToast(`⚠ ${authError.message}`);
  }
}

async function handleSpotifyAuthAction() {
  if (spotifyAuthInFlight) return;
  spotifyAuthInFlight = true;
  try {
    if (spotifyAccessToken) {
      if (spotifyPlayer) {
        spotifyPlayer.disconnect();
        spotifyPlayer = null;
        spotifyPlayerState = null;
        spotifyDeviceId = '';
      }
      clearSpotifyAuthState();
      updateSpotifyAuthUI();
      showToast('Spotify desconectado');
      return;
    }

    await startSpotifyLogin();
  } finally {
    spotifyAuthInFlight = false;
  }
}

function updateSpotifyAuthUI() {
  const btn = document.getElementById('btn-spotify-auth');
  const hint = document.getElementById('spotify-login-hint');
  const status = document.getElementById('spotify-auth-status');
  const slider = document.getElementById('spotify-volume-slider');
  const mute = document.getElementById('btn-spotify-mute');
  if (btn) btn.textContent = spotifyAccessToken ? 'Desconectar Spotify' : 'Conectar Spotify';
  if (hint) hint.classList.toggle('hidden', !!spotifyAccessToken);
  if (slider) slider.disabled = !spotifyAccessToken;
  if (mute) mute.disabled = !spotifyAccessToken;
  if (status) {
    status.classList.toggle('hidden', !spotifyAccessToken);
    status.textContent = spotifyAccessToken
      ? (spotifyDeviceId ? 'Spotify listo para reproducir' : 'Spotify conectado, preparando reproductor...')
      : '';
  }
}

async function fetchPlaylistTracks(playlistId, sourceTitle) {
  const items = [];
  let offset = 0;

  while (true) {
    const data = await spotifyApi(`/playlists/${playlistId}/tracks?limit=100&offset=${offset}&fields=items(track(id,name,uri,duration_ms,artists(name),album(images))),next`);
    for (const row of data.items || []) {
      const track = row.track;
      if (!track?.id || !track?.uri) continue;
      items.push({
        spotifyId: track.id,
        spotifyUri: track.uri,
        title: track.name || 'Canción de Spotify',
        artists: (track.artists || []).map((artist) => artist.name).filter(Boolean),
        artworkUrl: track.album?.images?.[track.album.images.length - 1]?.url || track.album?.images?.[0]?.url || '',
        durationMs: track.duration_ms || 0,
        sourceTitle,
      });
    }
    if (!data.next) break;
    offset += 100;
  }

  return items;
}

async function resolveSpotifyUrlToItems(spotifyUrl) {
  const trackRe = /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)([a-zA-Z0-9]+)/;
  const playlistRe = /(?:spotify:playlist:|open\.spotify\.com\/(?:embed\/)?playlist\/)([a-zA-Z0-9]+)/;
  const trackMatch = spotifyUrl.match(trackRe);
  const playlistMatch = spotifyUrl.match(playlistRe);
  if (!trackMatch && !playlistMatch) throw new Error('URL de Spotify no válida');

  if (trackMatch) {
    const track = await spotifyApi(`/tracks/${trackMatch[1]}`);
    return {
      type: 'track',
      items: [{
        spotifyId: track.id,
        spotifyUri: track.uri,
        title: track.name || 'Canción de Spotify',
        artists: (track.artists || []).map((artist) => artist.name).filter(Boolean),
        artworkUrl: track.album?.images?.[track.album.images.length - 1]?.url || track.album?.images?.[0]?.url || '',
        durationMs: track.duration_ms || 0,
        sourceTitle: '',
      }],
    };
  }

  const playlist = await spotifyApi(`/playlists/${playlistMatch[1]}?fields=name`);
  const sourceTitle = playlist?.name || 'Playlist de Spotify';
  return {
    type: 'playlist',
    items: await fetchPlaylistTracks(playlistMatch[1], sourceTitle),
  };
}

<<<<<<< HEAD
=======
function queueAddFromServerFallback(spotifyUrl, onDone) {
  socket.emit('queue:add', { spotifyUrl }, (res = {}) => {
    onDone?.(res);
  });
}

>>>>>>> Stashed changes
>>>>>>> 5b3698b (Fix)
// ─── Cola de música ───────────────────────────────────────────────────────────
async function queueAdd() {
  const input = document.getElementById('queue-input');
  const val   = input.value.trim();
  if (!val || !socket || !currentRoomId) return;

  const trackRe    = /(?:track[:/])([a-zA-Z0-9]+)/;
  const playlistRe = /(?:playlist[:/])([a-zA-Z0-9]+)/;

  if (!trackRe.test(val) && !playlistRe.test(val)) {
    showToast('⚠ Pega una URL de canción o playlist de Spotify');
    return;
  }

  const btn = document.getElementById('btn-queue-add');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-rounded text-[16px]" style="animation:spin 1s linear infinite">progress_activity</span>'; }

  try {
    const resolved = await resolveSpotifyUrlToItems(val);
    socket.emit('queue:add', { items: resolved.items }, (res = {}) => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-rounded text-[16px]">add</span>';
      }

<<<<<<< HEAD
=======
<<<<<<< Updated upstream
  if (btn) setTimeout(() => { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded text-[16px]">add</span>'; }, 500);
=======
>>>>>>> 5b3698b (Fix)
      if (res.error) {
        showToast(`⚠ ${res.error}`);
        return;
      }

      input.value = '';
      showToast(resolved.type === 'playlist'
        ? `✓ Añadidas ${res.added} canciones a la cola`
        : '✓ Canción añadida a la cola');
    });
  } catch (error) {
<<<<<<< HEAD
=======
    if (playlistRe.test(val) && /playlist/i.test(error.message || '')) {
      queueAddFromServerFallback(val, (res = {}) => {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span class="material-symbols-rounded text-[16px]">add</span>';
        }
        if (res.error) {
          showToast(`⚠ ${res.error}`);
          return;
        }
        input.value = '';
        showToast(`✓ Añadidas ${res.added || 0} canciones a la cola`);
      });
      return;
    }

>>>>>>> 5b3698b (Fix)
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-rounded text-[16px]">add</span>';
    }
    showToast(`⚠ ${error.message || 'No se pudo leer Spotify'}`);
  }
<<<<<<< HEAD
=======
>>>>>>> Stashed changes
>>>>>>> 5b3698b (Fix)
}

async function queueAddPreset(key) {
  const p = QUEUE_PRESETS[key];
  if (!p || !socket || !currentRoomId) return;
  showToast(`Añadiendo ${p.label}…`);
<<<<<<< HEAD
=======
<<<<<<< Updated upstream
=======
>>>>>>> 5b3698b (Fix)

  try {
    const resolved = await resolveSpotifyUrlToItems(`https://open.spotify.com/playlist/${p.id}`);
    socket.emit('queue:add', { items: resolved.items }, (res = {}) => {
      if (res.error) {
        showToast(`⚠ ${res.error}`);
        return;
      }
      showToast(`✓ ${p.label}: ${res.added || 0} canciones añadidas`);
    });
  } catch (error) {
<<<<<<< HEAD
    showToast(`⚠ ${error.message || 'No se pudo leer Spotify'}`);
  }
=======
    if (/playlist/i.test(error.message || '')) {
      queueAddFromServerFallback(`https://open.spotify.com/playlist/${p.id}`, (res = {}) => {
        if (res.error) {
          showToast(`⚠ ${res.error}`);
          return;
        }
        showToast(`✓ ${p.label}: ${res.added || 0} canciones añadidas`);
      });
      return;
    }
    showToast(`⚠ ${error.message || 'No se pudo leer Spotify'}`);
  }
>>>>>>> Stashed changes
>>>>>>> 5b3698b (Fix)
}

function queueRemove(id) {
  if (!socket || !currentRoomId) return;
  socket.emit('queue:remove', { id });
}

function queueToggleHidden(id) {
  if (!socket || !currentRoomId) return;
  socket.emit('queue:toggle-hidden', { id });
}

function queueReorder(fromIndex, toIndex) {
  if (!socket || !currentRoomId || fromIndex === toIndex) return;
  socket.emit('queue:reorder', { fromIndex, toIndex });
}

function queueClear() {
  if (!socket || !currentRoomId) return;
  if (currentQueue.length === 0) return;
  socket.emit('queue:clear');
}

function queueTogglePlay() {
  if (!socket || !currentRoomId) return;
  socket.emit(currentPlayback.playing ? 'queue:pause' : 'queue:play');
}

function queueSkip() {
  if (!socket || !currentRoomId) return;
  socket.emit('queue:skip');
}

function queuePrev() {
  if (!socket || !currentRoomId) return;
  socket.emit('queue:prev');
}

function queueJump(index) {
  if (!socket || !currentRoomId) return;
  socket.emit('queue:jump', { index });
}

<<<<<<< HEAD
=======
<<<<<<< Updated upstream
function tryControlSpotifyIframe(play) {
  const iframe = document.getElementById('spotify-iframe');
  if (!iframe) return;
  try {
    iframe.contentWindow.postMessage(
      JSON.stringify({ method: play ? 'play' : 'pause' }),
      'https://open.spotify.com'
    );
  } catch {}
=======
>>>>>>> 5b3698b (Fix)
function queueDragStart(index) {
  dragQueueIndex = index;
}

function queueDragOver(event) {
  event.preventDefault();
}

function queueDrop(index) {
  if (dragQueueIndex === -1) return;
  queueReorder(dragQueueIndex, index);
  dragQueueIndex = -1;
}

function queueDragEnd() {
  dragQueueIndex = -1;
}

function initSpotifyIframeApi() {
  if (document.querySelector('script[data-spotify-sdk]')) return;
  const script = document.createElement('script');
  script.src = 'https://sdk.scdn.co/spotify-player.js';
  script.async = true;
  script.dataset.spotifySdk = 'true';
  window.onSpotifyWebPlaybackSDKReady = () => {
    spotifySdkReady = true;
    ensureSpotifyController();
  };
  document.body.appendChild(script);
}

function ensureSpotifyController() {
  if (!spotifySdkReady || spotifyPlayer || spotifyPlayerInitializing || !spotifyAccessToken || !window.Spotify) return;

  spotifyPlayerInitializing = true;
  spotifyPlayer = new window.Spotify.Player({
    name: 'PomodoroSync',
    getOAuthToken: async (cb) => cb(await getValidSpotifyAccessToken()),
    volume: spotifyVolume,
  });

  spotifyPlayer.addListener('ready', async ({ device_id }) => {
    spotifyDeviceId = device_id;
    spotifyPlayerInitializing = false;
    updateSpotifyAuthUI();
    try {
      await transferSpotifyPlayback();
      await syncSpotifyController(true);
    } catch (error) {
      showToast('⚠ Spotify conectado, pero no se pudo activar el reproductor web');
    }
  });

  spotifyPlayer.addListener('not_ready', () => {
    spotifyDeviceId = '';
    updateSpotifyAuthUI();
  });

  spotifyPlayer.addListener('player_state_changed', (state) => {
    spotifyPlayerState = state;
    if (!state) return;

<<<<<<< HEAD
    spotifySessionDetected = true;
=======
>>>>>>> 5b3698b (Fix)
    updateSpotifyAuthUI();

    const item = currentQueue[currentPlayback.trackIndex];
    if (!socket || !currentRoomId || !item || item.id === lastTrackEndReportedId) return;
    const prevPosition = state.position || 0;
    const duration = state.duration || 0;
    if (state.paused && duration > 0 && prevPosition >= duration - 1500) {
      lastTrackEndReportedId = item.id;
      socket.emit('queue:track-ended', { id: item.id });
    }
  });

  spotifyPlayer.connect();
}

async function transferSpotifyPlayback() {
  if (!spotifyDeviceId) return;
  await spotifyApi('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [spotifyDeviceId], play: false })
  });
}

function getPlaybackPositionMs() {
  if (!currentPlayback) return 0;
  if (!currentPlayback.playing || !currentPlayback.startedAt) return currentPlayback.positionMs || 0;
  return Math.max(0, (currentPlayback.positionMs || 0) + (Date.now() - currentPlayback.startedAt));
}

function scheduleQueueAutoAdvance() {
  clearTimeout(queueAdvanceTimeout);
  queueAdvanceTimeout = null;

  const item = currentQueue[currentPlayback.trackIndex];
  if (!socket || !currentRoomId || !currentPlayback.playing || !item?.id || !item.durationMs) return;

  const remainingMs = Math.max(0, item.durationMs - getPlaybackPositionMs());
  queueAdvanceTimeout = setTimeout(() => {
    if (!socket || !currentRoomId || lastTrackEndReportedId === item.id) return;
    lastTrackEndReportedId = item.id;
    socket.emit('queue:track-ended', { id: item.id });
  }, remainingMs + 250);
}

async function syncSpotifyController(force = false) {
  if (!spotifyPlayer || !spotifyDeviceId || !spotifyAccessToken) return;

  const item = currentQueue[currentPlayback.trackIndex];
  if (!item?.spotifyUri) {
    try { await spotifyApi(`/me/player/pause?device_id=${encodeURIComponent(spotifyDeviceId)}`, { method: 'PUT' }); } catch {}
    return;
  }

  const positionMs = getPlaybackPositionMs();
  const shouldPlay = !!currentPlayback.playing;
  const positionBucket = Math.floor(positionMs / 2000);
  const trackChanged = lastSyncedTrackId !== item.id;
  const pausedMismatch = !!spotifyPlayerState && spotifyPlayerState.paused === shouldPlay;
  const uriMismatch = spotifyPlayerState?.track_window?.current_track?.uri !== item.spotifyUri;

  if (shouldPlay && (force || trackChanged || uriMismatch || pausedMismatch || positionBucket !== lastSyncedPlaybackBucket)) {
    lastSyncedTrackId = item.id;
    lastSyncedPlaybackBucket = positionBucket;
    await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(spotifyDeviceId)}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [item.spotifyUri], position_ms: positionMs })
    });
    return;
  }

  if (!shouldPlay && (force || !spotifyPlayerState?.paused || trackChanged || uriMismatch)) {
    if (trackChanged || uriMismatch) {
      await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(spotifyDeviceId)}`, {
        method: 'PUT',
        body: JSON.stringify({ uris: [item.spotifyUri], position_ms: positionMs })
      });
    }
    await spotifyApi(`/me/player/pause?device_id=${encodeURIComponent(spotifyDeviceId)}`, { method: 'PUT' });
    lastSyncedTrackId = item.id;
    lastSyncedPlaybackBucket = positionBucket;
  }
}

async function setSpotifyVolume(volume) {
  spotifyVolume = Math.max(0, Math.min(1, volume));
  if (spotifyVolume > 0) {
    spotifyPreviousVolume = spotifyVolume;
    spotifyMuted = false;
  }
  if (spotifyPlayer) await spotifyPlayer.setVolume(spotifyVolume);
  updateSpotifyVolumeUI();
}

function setSpotifyVolumeFromSlider(value) {
  setSpotifyVolume(Number(value) / 100).catch(() => showToast('⚠ No se pudo ajustar el volumen'));
}

function toggleSpotifyMute() {
  const nextVolume = spotifyMuted ? (spotifyPreviousVolume || 0.7) : 0;
  spotifyMuted = !spotifyMuted;
  setSpotifyVolume(nextVolume).catch(() => showToast('⚠ No se pudo ajustar el volumen'));
}

function updateSpotifyVolumeUI() {
  const slider = document.getElementById('spotify-volume-slider');
  const btn = document.getElementById('btn-spotify-mute');
  if (slider) slider.value = String(Math.round(spotifyVolume * 100));
  if (btn) {
    const icon = spotifyVolume === 0 ? 'volume_off' : (spotifyVolume < 0.5 ? 'volume_down' : 'volume_up');
    btn.innerHTML = `<span class="material-symbols-rounded text-[16px]">${icon}</span>`;
  }
<<<<<<< HEAD
=======
>>>>>>> Stashed changes
>>>>>>> 5b3698b (Fix)
}

function renderNowPlaying() {
  const frame     = document.getElementById('now-playing-frame');
  const titleEl   = document.getElementById('now-playing-title');
  const addedByEl = document.getElementById('now-playing-added-by');
  if (!frame) return;

  const item = currentQueue[currentPlayback.trackIndex];
  const trackKey = item ? `${item.id}:${currentPlayback.playing ? 'playing' : 'paused'}` : 'empty';

  if (trackKey !== renderedTrackKey) {
    renderedTrackKey = trackKey;
    if (!item) {
      frame.innerHTML = `<div style="height:72px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;gap:6px">
        <span class="material-symbols-rounded text-[16px]">music_off</span> Cola vacía — añade canciones abajo
      </div>`;
    } else {
      const image = item.artworkUrl
        ? `<img src="${escapeHtml(item.artworkUrl)}" alt="${escapeHtml(item.title)}" class="w-16 h-16 rounded-[10px] object-cover shrink-0">`
        : `<div class="w-16 h-16 rounded-[10px] shrink-0 flex items-center justify-center" style="background:var(--accent-glow);color:var(--accent)">
            <span class="material-symbols-rounded">album</span>
          </div>`;
      frame.innerHTML = `<div class="flex items-center gap-3 p-3 min-h-[88px]" style="background:var(--surface-2)">
        ${image}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 text-[10px] uppercase tracking-[1.5px] mb-1" style="color:var(--text-muted)">
            <span class="material-symbols-rounded text-[13px]" style="color:#1DB954">music_note</span>
            <span>${currentPlayback.playing ? 'Sonando' : 'En pausa'}</span>
          </div>
          <div class="text-[13px] font-medium truncate">${escapeHtml(item.title)}</div>
          <div class="text-[11px] truncate mt-0.5" style="color:var(--text-muted)">${escapeHtml((item.artists || []).join(', ') || 'Spotify')}</div>
          ${item.sourceTitle ? `<div class="text-[10px] truncate mt-1" style="color:var(--text-dim)">Playlist: ${escapeHtml(item.sourceTitle)}</div>` : ''}
        </div>
      </div>`;
    }
    if (titleEl)   titleEl.textContent   = item?.title || '—';
    if (addedByEl) {
      const source = item?.sourceTitle ? ` · ${item.sourceTitle}` : '';
      addedByEl.textContent = item ? `Añadido por ${item.addedBy}${source}` : '';
    }
  }
}

function renderQueueList() {
  const el = document.getElementById('queue-list');
  const countEl = document.getElementById('queue-count');
  if (!el) return;

  if (countEl) countEl.textContent = currentQueue.length ? `(${currentQueue.length})` : '';

  if (!currentQueue.length) {
    el.innerHTML = `<div class="text-center py-6 text-[12px]" style="color:var(--text-muted)">
      La cola está vacía.
    </div>`;
    return;
  }

  el.innerHTML = currentQueue.map((item, i) => {
    const isCurrent = i === currentPlayback.trackIndex;
    const isHidden = !!item.hidden;
    const icon = isCurrent && currentPlayback.playing
      ? 'volume_up'
      : (isHidden ? 'visibility_off' : 'music_note');
    const artwork = item.artworkUrl
      ? `<img src="${escapeHtml(item.artworkUrl)}" alt="${escapeHtml(item.title)}" class="queue-item-artwork">`
      : `<div class="queue-item-artwork queue-item-artwork-fallback">
          <span class="material-symbols-rounded text-[14px]">album</span>
        </div>`;
    return `<div class="queue-item${isCurrent ? ' current' : ''}${isHidden ? ' hidden-item' : ''}"
      draggable="true"
      ondragstart="queueDragStart(${i})"
      ondragover="queueDragOver(event)"
      ondrop="queueDrop(${i})"
      ondragend="queueDragEnd()"
      onclick="${isHidden ? '' : `queueJump(${i})`}"
      >
      <span class="material-symbols-rounded text-[15px] queue-item-icon" title="Arrastrar">drag_indicator</span>
      ${artwork}
      <div class="flex flex-col flex-1 min-w-0">
        <span class="text-[13px] truncate" style="color:${isCurrent ? 'var(--accent)' : 'var(--text)'}">${escapeHtml(item.title)}${isHidden ? ' · oculta' : ''}</span>
        <span class="text-[10px] truncate" style="color:var(--text-muted)">${escapeHtml((item.artists || []).join(', ') || item.addedBy)}${item.sourceTitle ? ` · ${escapeHtml(item.sourceTitle)}` : ''}</span>
      </div>
      <button class="queue-remove-btn" onclick="event.stopPropagation();queueToggleHidden('${item.id}')" title="${isHidden ? 'Mostrar en reproducción' : 'Ocultar de reproducción'}">
        <span class="material-symbols-rounded text-[14px]">${isHidden ? 'visibility' : 'visibility_off'}</span>
      </button>
      <button class="queue-remove-btn" onclick="event.stopPropagation();queueRemove('${item.id}')" title="Eliminar">
        <span class="material-symbols-rounded text-[14px]">close</span>
      </button>
    </div>`;
  }).join('');

  const cur = el.querySelector('.queue-item.current');
  if (cur) cur.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updatePlaybackButtons() {
  const btn = document.getElementById('btn-queue-play');
  if (btn) btn.innerHTML = `<span class="material-symbols-rounded">${currentPlayback.playing ? 'pause' : 'play_arrow'}</span>`;

  const skip = document.getElementById('btn-queue-skip');
  const prev = document.getElementById('btn-queue-prev');
<<<<<<< HEAD
  const hasNext = currentQueue.slice(currentPlayback.trackIndex + 1).some(item => !item.hidden);
  const hasPrev = currentQueue.slice(0, Math.max(currentPlayback.trackIndex, 0)).some(item => !item.hidden);
  if (skip) skip.disabled = !currentQueue.length || !hasNext;
  if (prev) prev.disabled = currentPlayback.trackIndex <= 0 || !hasPrev;
=======
<<<<<<< Updated upstream
  if (skip) skip.disabled = !currentQueue.length || currentPlayback.trackIndex >= currentQueue.length - 1;
  if (prev) prev.disabled = currentPlayback.trackIndex <= 0;
=======
  const visibleCount = currentQueue.filter(item => !item.hidden).length;
  if (skip) skip.disabled = visibleCount <= 1;
  if (prev) prev.disabled = visibleCount <= 1;
>>>>>>> Stashed changes
>>>>>>> 5b3698b (Fix)
}

// ─── Pestañas panel derecho ───────────────────────────────────────────────────
function switchRightTab(tab) {
  const isMusic = tab === 'music';
  document.getElementById('right-music').classList.toggle('hidden', !isMusic);
  document.getElementById('right-chat').classList.toggle('hidden', isMusic);
  document.getElementById('tab-music').classList.toggle('active', isMusic);
  document.getElementById('tab-chat-tab').classList.toggle('active', !isMusic);
  if (window.innerWidth <= 768) {
    document.getElementById('panel-right').classList.add('mobile-open');
  }
}

function toggleChat() {
  const chatVisible = !document.getElementById('right-chat').classList.contains('hidden');
  if (chatVisible && window.innerWidth <= 768) {
    document.getElementById('panel-right').classList.remove('mobile-open');
  } else {
    switchRightTab(chatVisible ? 'music' : 'chat');
  }
}

// ─── Modal compartir ──────────────────────────────────────────────────────────
function openShareModal() {
  document.getElementById('modal-share').classList.add('open');
}

function closeShareModal(e) {
  if (!e || e.target === document.getElementById('modal-share')) {
    document.getElementById('modal-share').classList.remove('open');
  }
}

function copyShareUrl() {
  navigator.clipboard.writeText(document.getElementById('share-url-input').value)
    .then(() => showToast('✓ Enlace copiado al portapapeles'));
}

// ─── Toasts ───────────────────────────────────────────────────────────────────
function showToast(msg) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3400);
}

function showLobbyError(msg) {
  const el = document.getElementById('lobby-error');
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 4000);
}

// ─── Modal de configuración ───────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-study').value       = Math.round(PHASE_DURATIONS.study / 60);
  document.getElementById('settings-short-break').value = Math.round(PHASE_DURATIONS.short_break / 60);
  document.getElementById('settings-long-break').value  = Math.round(PHASE_DURATIONS.long_break / 60);
  document.getElementById('modal-settings').classList.add('open');
}

function closeSettings(e) {
  if (!e || e.target === document.getElementById('modal-settings')) {
    document.getElementById('modal-settings').classList.remove('open');
  }
}

function saveSettings() {
  const study      = parseInt(document.getElementById('settings-study').value);
  const shortBreak = parseInt(document.getElementById('settings-short-break').value);
  const longBreak  = parseInt(document.getElementById('settings-long-break').value);

  if ([study, shortBreak, longBreak].some(v => isNaN(v) || v < 1 || v > 99)) {
    showToast('⚠ Los minutos deben estar entre 1 y 99');
    return;
  }

  if (socket && currentRoomId) {
    socket.emit('settings:update', { study, short_break: shortBreak, long_break: longBreak });
  } else {
    PHASE_DURATIONS.study       = study * 60;
    PHASE_DURATIONS.short_break = shortBreak * 60;
    PHASE_DURATIONS.long_break  = longBreak * 60;
  }

  document.getElementById('modal-settings').classList.remove('open');
  showToast('✓ Duraciones actualizadas');
}

function syncSettingsInputs() {
  const studyEl  = document.getElementById('settings-study');
  const shortEl  = document.getElementById('settings-short-break');
  const longEl   = document.getElementById('settings-long-break');
  if (studyEl) studyEl.value  = Math.round(PHASE_DURATIONS.study / 60);
  if (shortEl) shortEl.value  = Math.round(PHASE_DURATIONS.short_break / 60);
  if (longEl)  longEl.value   = Math.round(PHASE_DURATIONS.long_break / 60);
}

// ─── Salas activas (lobby) ────────────────────────────────────────────────────
function startLobbyRefresh() {
  fetchLobbyRooms();
  lobbyRefreshInterval = setInterval(fetchLobbyRooms, 10000);
}

function stopLobbyRefresh() {
  clearInterval(lobbyRefreshInterval);
  lobbyRefreshInterval = null;
}

async function fetchLobbyRooms() {
  try {
    const res = await fetch('/api/rooms');
    const data = await res.json();
    renderLobbyRooms(data);
  } catch {}
}

const PHASE_LABEL_ES = { study: 'Estudio', short_break: 'Descanso', long_break: 'Largo' };

function renderLobbyRooms(rooms) {
  const el = document.getElementById('lobby-rooms');
  if (!el) return;
  if (!rooms.length) {
    el.innerHTML = '<p class="text-center text-[12px] py-2" style="color:var(--text-muted)">Sin salas activas ahora mismo.</p>';
    return;
  }
  el.innerHTML = rooms.map(r => `
    <div class="lobby-room-card" onclick="quickJoin('${escapeHtml(r.id)}')">
      <span class="material-symbols-rounded text-[18px]" style="color:var(--text-muted)">group</span>
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-[13px] font-medium truncate" style="color:var(--text)">${escapeHtml(r.name || r.id)}</span>
        <span class="text-[11px]" style="color:var(--text-muted)">${r.userCount} usuario${r.userCount !== 1 ? 's' : ''} · ${PHASE_LABEL_ES[r.phase] || r.phase}</span>
      </div>
      <span class="room-phase${r.running ? ' running' : ''}">${r.running ? 'activa' : 'pausada'}</span>
      <button class="join-btn">Unirse</button>
    </div>
  `).join('');
}

function quickJoin(roomId) {
  const username = document.getElementById('input-username').value.trim();
  if (!username) { showLobbyError('Escribe tu nombre para unirte.'); return; }
  document.getElementById('input-roomcode').value = roomId;
  handleJoin();
}

// ─── Resize panel derecho ────────────────────────────────────────────────────
function initResizeHandle() {
  const handle = document.getElementById('panel-resize-handle');
  const panel  = document.getElementById('panel-right');
  const header = document.querySelector('#screen-app header');
  if (!handle || !panel) return;

  let startX, startWidth;

  handle.addEventListener('mousedown', e => {
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  function onMove(e) {
    const w = Math.max(300, Math.min(680, startWidth + (startX - e.clientX)));
    panel.style.width = w + 'px';
    if (header) header.style.gridTemplateColumns = `220px 1fr ${w}px`;
  }

  function onUp() {
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

// ─── Sonido de notificación ───────────────────────────────────────────────────
function playNotificationSound() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.setValueAtTime(800, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(600, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {}
}

// ─── Utilidades ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
