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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// ─── Estado en memoria de las salas ──────────────────────────────────────────
// Estructura: { [roomId]: Room }
const rooms = {};

/**
 * Crea una sala con su estado inicial del temporizador Pomodoro.
 */
function createRoom(roomId) {
  return {
    id: roomId,
    users: {},           // { [socketId]: UserState }
    timer: {
      phase: 'study',    // 'study' | 'short_break' | 'long_break'
      running: false,
      timeLeft: 25 * 60, // segundos
      startedAt: null,   // timestamp de cuando se inició la última vez
      pomodoroCount: 0,  // cuántos pomodoros completados
    },
    messages: [],        // historial de chat (máx 50)
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
  if (timer.phase === 'study') {
    timer.pomodoroCount++;
    // Cada 4 pomodoros = descanso largo
    if (timer.pomodoroCount % 4 === 0) {
      timer.phase = 'long_break';
      timer.timeLeft = 15 * 60;
    } else {
      timer.phase = 'short_break';
      timer.timeLeft = 5 * 60;
    }
  } else {
    timer.phase = 'study';
    timer.timeLeft = 25 * 60;
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
  socket.on('room:create', ({ username }, callback) => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    rooms[roomId] = createRoom(roomId);

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
      timer: getTimerSnapshot(rooms[roomId]),
      users: Object.values(rooms[roomId].users)
    });
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
      timer: getTimerSnapshot(room),
      users: Object.values(room.users),
      messages: room.messages.slice(-20) // últimos 20 mensajes
    });
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
    room.timer.timeLeft = 25 * 60;
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

    // Limpiar sala si está vacía después de 5 minutos
    if (Object.keys(room.users).length === 0) {
      setTimeout(() => {
        if (rooms[roomId] && Object.keys(rooms[roomId].users).length === 0) {
          delete rooms[roomId];
          console.log(`[SALA] Eliminada por inactividad: ${roomId}`);
        }
      }, 5 * 60 * 1000);
    }

    console.log(`[-] Usuario desconectado: ${user?.username} de sala ${roomId}`);
  });
});

// ─── Iniciar servidor ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n🍅 Pomodoro Sync Server corriendo en http://localhost:${PORT}\n`);
});
