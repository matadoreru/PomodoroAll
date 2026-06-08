'use strict';

// ─── Configuración ────────────────────────────────────────────────────────────
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3001'
  : window.location.origin;

const SPOTIFY_PLAYLISTS = {
  lofi:      '0vvXsWCC9xrXsKd4eVbQVz',
  synthwave: '37i9dQZF1DX9RwfGbeGQwP',
  classical: '37i9dQZF1DWWEJlAGA9gs0',
  jazz:      '37i9dQZF1DWV7EzJpy1ne1',
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
let currentSpotifyPreset = null;

const PHASE_DURATIONS = {
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
}

// ─── Crear sala ──────────────────────────────────────────────────────────────
function handleCreate() {
  const username = document.getElementById('input-username').value.trim();
  if (!username) { showLobbyError('Por favor escribe tu nombre.'); return; }

  myUsername = username;
  if (!socket) connectSocket();

  socket.once('connect', () => {
    socket.emit('room:create', { username }, (res) => {
      if (res.error) { showLobbyError(res.error); return; }
      enterApp(res);
    });
  });

  if (socket.connected) {
    socket.emit('room:create', { username }, (res) => {
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
function enterApp({ roomId, timer, users }, messages = []) {
  currentRoomId = roomId;

  document.getElementById('header-room-code').textContent = roomId;
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
  document.getElementById('screen-app').classList.remove('active');
  document.getElementById('screen-lobby').style.display = 'flex';
  history.pushState({}, '', '/');
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
  document.getElementById('btn-play-pause').textContent = running ? '⏸' : '▶';
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

// ─── Spotify ─────────────────────────────────────────────────────────────────
function loadSpotifyPlaylist(preset) {
  document.querySelectorAll('.spotify-preset').forEach(b => b.classList.remove('active'));

  if (currentSpotifyPreset === preset) {
    document.getElementById('spotify-widget-frame').innerHTML = `
      <div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">
        Elige una playlist ↓
      </div>`;
    currentSpotifyPreset = null;
    return;
  }

  currentSpotifyPreset = preset;
  document.getElementById(`preset-${preset}`)?.classList.add('active');

  const playlistId = SPOTIFY_PLAYLISTS[preset];
  document.getElementById('spotify-widget-frame').innerHTML = `
    <iframe
      src="https://open.spotify.com/embed/playlist/${playlistId}?utm_source=generator&theme=0"
      width="100%" height="152" frameborder="0" allowfullscreen=""
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy"
    ></iframe>`;
}

// ─── Toggle chat ─────────────────────────────────────────────────────────────
function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById('panel-right').classList.toggle('collapsed', !chatOpen);
  document.getElementById('btn-toggle-chat').classList.toggle('active', chatOpen);
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
